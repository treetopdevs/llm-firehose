package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

type cursorFile struct {
	Offset      int64       `json:"offset"`
	Parser      ParserState `json:"parser"`
	PendingID   string      `json:"pending_id,omitempty"`
	PendingNext int64       `json:"pending_next,omitempty"`
}

type cursorState struct {
	SavedAt time.Time             `json:"saved_at"`
	Files   map[string]cursorFile `json:"files"`
}

// DurableWatcher persists each per-file offset only after Sink has durably
// accepted the mapped event. This provides at-least-once delivery across
// daemon restarts.
type DurableWatcher struct {
	Root      string
	StatePath string
	Interval  time.Duration
	Sink      func(event.Event) error
	state     cursorState
	files     map[string]*fileState
	warned    map[string]bool
	loaded    bool
}

// NewDurableWatcher constructs a rollout watcher with a durable checkpoint.
func NewDurableWatcher(root, statePath string, interval time.Duration, sink func(event.Event) error) *DurableWatcher {
	return &DurableWatcher{
		Root: root, StatePath: statePath, Interval: interval, Sink: sink,
		files:  map[string]*fileState{},
		warned: map[string]bool{},
	}
}

// Initialize loads a prior checkpoint. On first activation it parses existing
// files only to establish context and baselines them at EOF; it emits nothing.
func (w *DurableWatcher) Initialize() error {
	if w.loaded {
		return nil
	}
	w.state = cursorState{Files: map[string]cursorFile{}}
	w.files = map[string]*fileState{}
	data, err := os.ReadFile(w.StatePath)
	switch {
	case err == nil:
		if decodeErr := json.Unmarshal(data, &w.state); decodeErr != nil {
			quarantinePath, renameErr := w.quarantineCorruptState()
			if renameErr != nil {
				return renameErr
			}
			if err := w.initializeBaseline(); err != nil {
				return err
			}
			w.report(errors.New("corrupt Codex cursor quarantined at " + filepath.Base(quarantinePath) + ": " + decodeErr.Error()))
			return nil
		}
		if w.state.Files == nil {
			w.state.Files = map[string]cursorFile{}
		}
		for path, cursor := range w.state.Files {
			w.files[path] = &fileState{
				offset: cursor.Offset,
				parser: NewFileParserFrom(cursor.Parser),
			}
		}
	case os.IsNotExist(err):
		return w.initializeBaseline()
	default:
		return err
	}
	w.loaded = true
	return nil
}

func (w *DurableWatcher) initializeBaseline() error {
	w.state = cursorState{Files: map[string]cursorFile{}}
	w.files = map[string]*fileState{}
	for _, path := range scanRollouts(w.Root) {
		state, err := baseline(path)
		if err != nil {
			continue
		}
		w.files[path] = state
		w.state.Files[path] = cursorFile{Offset: state.offset, Parser: state.parser.Snapshot()}
	}
	w.loaded = true
	if err := w.save(); err != nil {
		w.loaded = false
		return err
	}
	return nil
}

func (w *DurableWatcher) quarantineCorruptState() (string, error) {
	suffix := time.Now().UTC().Format("20060102T150405.000000000Z")
	path := w.StatePath + ".corrupt-" + suffix
	return path, os.Rename(w.StatePath, path)
}

// Run polls until cancellation. Transient failures leave the cursor in place
// and are retried on the next tick.
func (w *DurableWatcher) Run(ctx context.Context) {
	if err := w.Initialize(); err != nil {
		w.report(err)
	} else if err := w.Poll(ctx); err != nil && !errors.Is(err, context.Canceled) {
		w.report(err)
	}
	ticker := time.NewTicker(w.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.Poll(ctx); err != nil && !errors.Is(err, context.Canceled) {
				w.report(err)
			}
		}
	}
}

// Poll processes all complete newly appended rollout lines.
func (w *DurableWatcher) Poll(ctx context.Context) error {
	if err := w.Initialize(); err != nil {
		return err
	}
	for _, path := range scanRollouts(w.Root) {
		st, ok := w.files[path]
		if !ok {
			fi, err := os.Stat(path)
			if err != nil {
				return err
			}
			// Unknown files newer than the last checkpoint were created while
			// the daemon was down and must be read from the beginning.
			if !w.state.SavedAt.IsZero() && fi.ModTime().Before(w.state.SavedAt) {
				st, err = baseline(path)
				if err != nil {
					return err
				}
				w.files[path] = st
				w.state.Files[path] = cursorFile{Offset: st.offset, Parser: st.parser.Snapshot()}
				if err := w.save(); err != nil {
					return err
				}
				continue
			}
			st = &fileState{parser: NewFileParser()}
			w.files[path] = st
		}
		if err := w.readAppends(ctx, path, st); err != nil {
			return err
		}
	}
	return nil
}

func (w *DurableWatcher) readAppends(ctx context.Context, path string, st *fileState) error {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	if _, err := f.Seek(st.offset, io.SeekStart); err != nil {
		return err
	}
	reader := bufio.NewReader(f)
	read := st.offset
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		line, err := reader.ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			return nil // do not checkpoint a partial final line
		}
		if err != nil {
			return err
		}
		next := read + int64(len(line))
		line = bytes.TrimSuffix(line, []byte{'\n'})
		line = bytes.TrimSuffix(line, []byte{'\r'})
		before := st.parser.Snapshot()
		ev, parseErr := st.parser.ParseLine(line)
		if parseErr != nil {
			ev = parseWarning(before, parseErr)
		}

		current := w.state.Files[path]
		pending := cursorFile{Offset: read, Parser: before}
		if ev != nil {
			if current.PendingID != "" && current.PendingNext == next {
				ev.ID = current.PendingID
				pending = current
			} else {
				pending.PendingID = ev.ID
				pending.PendingNext = next
				w.state.Files[path] = pending
				if err := w.save(); err != nil {
					st.parser.Restore(before)
					return err
				}
			}
		}
		if ev != nil && w.Sink != nil {
			if err := w.Sink(*ev); err != nil {
				st.parser.Restore(before)
				return err
			}
		}
		cursor := cursorFile{Offset: next, Parser: st.parser.Snapshot()}
		w.state.Files[path] = cursor
		if err := w.save(); err != nil {
			st.parser.Restore(before)
			w.state.Files[path] = pending
			return err
		}
		st.offset = next
		read = next
	}
}

func (w *DurableWatcher) report(err error) {
	if err == nil || w.Sink == nil || w.warned[err.Error()] {
		return
	}
	if sinkErr := w.Sink(event.Event{
		ID:       event.NewID(),
		Time:     time.Now().UTC(),
		Source:   Source,
		Agent:    "codex",
		Category: event.CategoryMeta,
		Name:     "rollout_capture_error",
		Severity: event.SeverityWarn,
		Summary:  "Codex rollout capture warning: " + err.Error(),
		Payload: map[string]any{
			"transport": "rollout",
			"status":    "error",
		},
	}); sinkErr == nil {
		w.warned[err.Error()] = true
	}
}

func parseWarning(state ParserState, err error) *event.Event {
	return &event.Event{
		ID:        event.NewID(),
		Time:      time.Now().UTC(),
		Source:    Source,
		Agent:     "codex",
		SessionID: state.SessionID,
		CWD:       state.CWD,
		Category:  event.CategoryMeta,
		Name:      "rollout_parse_error",
		Severity:  event.SeverityWarn,
		Summary:   "Codex rollout record could not be parsed: " + err.Error(),
		Payload: map[string]any{
			"transport": "rollout",
			"status":    "error",
		},
	}
}

func (w *DurableWatcher) save() error {
	w.state.SavedAt = time.Now().UTC()
	data, err := json.MarshalIndent(w.state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(w.StatePath), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(w.StatePath), ".codex-cursors-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() { os.Remove(tmpPath) }
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpPath, w.StatePath); err != nil {
		cleanup()
		return err
	}
	return nil
}

func baseline(path string) (*fileState, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	parser := NewFileParser()
	reader := bufio.NewReader(f)
	var offset int64
	for {
		line, err := reader.ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			break // leave a partial final line for the first poll
		}
		if err != nil {
			return nil, err
		}
		offset += int64(len(line))
		line = bytes.TrimSuffix(line, []byte{'\n'})
		line = bytes.TrimSuffix(line, []byte{'\r'})
		_, _ = parser.ParseLine(line)
	}
	// Historical events are not imported, but their parser context is needed
	// to correlate lines appended after activation.
	return &fileState{offset: offset, parser: parser}, nil
}

func scanRollouts(root string) []string {
	var paths []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, ".jsonl") {
			paths = append(paths, path)
		}
		return nil
	})
	return paths
}
