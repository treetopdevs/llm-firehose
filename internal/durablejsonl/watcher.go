// Package durablejsonl provides crash-safe tailing for append-oriented JSONL
// sources. It checkpoints parser context and offsets only after the mapped
// event has been accepted by the durable sink.
package durablejsonl

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"agentfirehose/internal/event"
)

const maxFingerprintLine = 1 << 20

// Parser maps one source line and serializes the source-specific context
// required to parse the next line.
type Parser interface {
	ParseLine([]byte) (*event.Event, error)
	Snapshot() (json.RawMessage, error)
}

// Options defines one durable source without coupling the watcher to its
// native schema.
type Options struct {
	Root           string
	StatePath      string
	Interval       time.Duration
	Match          func(path string, entry os.DirEntry) bool
	NewParser      func(snapshot json.RawMessage) (Parser, error)
	Sink           func(event.Event) error
	ParseWarning   func(snapshot json.RawMessage, err error) event.Event
	CaptureWarning func(err error) event.Event
}

type cursorFile struct {
	Offset       int64           `json:"offset"`
	Parser       json.RawMessage `json:"parser,omitempty"`
	Identity     string          `json:"identity,omitempty"`
	LastLineHash string          `json:"last_line_hash,omitempty"`
	PendingID    string          `json:"pending_id,omitempty"`
	PendingNext  int64           `json:"pending_next,omitempty"`
}

type cursorState struct {
	SavedAt time.Time             `json:"saved_at"`
	Files   map[string]cursorFile `json:"files"`
}

type fileState struct {
	offset       int64
	parser       Parser
	identity     string
	lastLineHash string
}

type fileStamp struct {
	size    int64
	modTime time.Time
}

// Watcher tails all files selected by Match under Root.
type Watcher struct {
	options              Options
	state                cursorState
	files                map[string]*fileState
	observed             map[string]fileStamp
	warned               map[string]bool
	discoveryWatermark   time.Time
	firstLineFingerprint func(string) (string, error)
	lastLineFingerprint  func(string, int64) (string, error)
	loaded               bool
}

// New constructs a watcher. Initialize performs filesystem work.
func New(options Options) *Watcher {
	return &Watcher{
		options:              options,
		files:                map[string]*fileState{},
		observed:             map[string]fileStamp{},
		warned:               map[string]bool{},
		firstLineFingerprint: firstLineHash,
		lastLineFingerprint:  lastLineHashBefore,
	}
}

// Loaded reports whether Initialize has established a usable checkpoint.
func (w *Watcher) Loaded() bool {
	return w.loaded
}

// Initialize loads a checkpoint or baselines pre-existing matched files.
func (w *Watcher) Initialize() error {
	if w.loaded {
		return nil
	}
	if w.options.Match == nil {
		return errors.New("durablejsonl: file matcher is required")
	}
	if w.options.NewParser == nil {
		return errors.New("durablejsonl: parser factory is required")
	}
	w.state = cursorState{Files: map[string]cursorFile{}}
	w.files = map[string]*fileState{}
	w.observed = map[string]fileStamp{}

	data, err := os.ReadFile(w.options.StatePath)
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
			w.Report(fmt.Errorf("corrupt cursor quarantined at %s: %w", filepath.Base(quarantinePath), decodeErr))
			return nil
		}
		if w.state.Files == nil {
			w.state.Files = map[string]cursorFile{}
		}
		w.discoveryWatermark = w.state.SavedAt
		for path, cursor := range w.state.Files {
			parser, parserErr := w.options.NewParser(cursor.Parser)
			if parserErr != nil {
				quarantinePath, renameErr := w.quarantineCorruptState()
				if renameErr != nil {
					return renameErr
				}
				if err := w.initializeBaseline(); err != nil {
					return err
				}
				w.Report(fmt.Errorf(
					"corrupt parser checkpoint quarantined at %s for %s: %w",
					filepath.Base(quarantinePath),
					filepath.Base(path),
					parserErr,
				))
				return nil
			}
			w.files[path] = &fileState{
				offset:       cursor.Offset,
				parser:       parser,
				identity:     cursor.Identity,
				lastLineHash: cursor.LastLineHash,
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

func (w *Watcher) initializeBaseline() error {
	w.state = cursorState{Files: map[string]cursorFile{}}
	w.files = map[string]*fileState{}
	w.observed = map[string]fileStamp{}
	w.discoveryWatermark = time.Now().UTC()
	for _, path := range w.scan() {
		state, cursor, err := w.baseline(path)
		if err != nil {
			continue
		}
		w.files[path] = state
		w.state.Files[path] = cursor
		if info, statErr := os.Stat(path); statErr == nil {
			w.observed[path] = stampFor(info)
		}
	}
	w.loaded = true
	if err := w.save(); err != nil {
		w.loaded = false
		return err
	}
	return nil
}

func (w *Watcher) quarantineCorruptState() (string, error) {
	suffix := time.Now().UTC().Format("20060102T150405.000000000Z")
	path := w.options.StatePath + ".corrupt-" + suffix
	return path, os.Rename(w.options.StatePath, path)
}

// Run polls until cancellation. Transient failures retain the checkpoint and
// retry on the next tick.
func (w *Watcher) Run(ctx context.Context) {
	if err := w.Initialize(); err != nil {
		w.Report(err)
	} else if err := w.Poll(ctx); err != nil && !errors.Is(err, context.Canceled) {
		w.Report(err)
	}
	interval := w.options.Interval
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.Poll(ctx); err != nil && !errors.Is(err, context.Canceled) {
				w.Report(err)
			}
		}
	}
}

// Poll processes every complete newly appended line.
func (w *Watcher) Poll(ctx context.Context) error {
	if err := w.Initialize(); err != nil {
		return err
	}
	for _, path := range w.scan() {
		state, ok := w.files[path]
		if !ok {
			info, err := os.Stat(path)
			if err != nil {
				return err
			}
			if !w.discoveryWatermark.IsZero() && info.ModTime().Before(w.discoveryWatermark) {
				state, cursor, err := w.baseline(path)
				if err != nil {
					return err
				}
				w.files[path] = state
				w.state.Files[path] = cursor
				w.observed[path] = stampFor(info)
				if err := w.save(); err != nil {
					return err
				}
				continue
			}
			parser, err := w.options.NewParser(nil)
			if err != nil {
				return err
			}
			state = &fileState{parser: parser}
			w.files[path] = state
		}
		if err := w.resetIfChanged(path, state); err != nil {
			return err
		}
		if err := w.readAppends(ctx, path, state); err != nil {
			return err
		}
	}
	return nil
}

func (w *Watcher) resetIfChanged(path string, state *fileState) error {
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	stamp := stampFor(info)
	if previous, ok := w.observed[path]; ok && previous == stamp {
		return nil
	}
	changed := info.Size() < state.offset
	if !changed && state.offset > 0 {
		identity, identityErr := w.firstLineFingerprint(path)
		if identityErr != nil {
			w.Report(fmt.Errorf("fingerprint %s: %w", filepath.Base(path), identityErr))
			return nil
		}
		lastHash, lastErr := w.lastLineFingerprint(path, state.offset)
		if lastErr != nil {
			w.Report(fmt.Errorf("fingerprint %s: %w", filepath.Base(path), lastErr))
			return nil
		}
		changed = (state.identity != "" && identity != state.identity) ||
			(state.lastLineHash != "" && lastHash != state.lastLineHash)
	}
	if !changed {
		w.observed[path] = stamp
		return nil
	}
	parser, err := w.options.NewParser(nil)
	if err != nil {
		return err
	}
	state.offset = 0
	state.parser = parser
	state.identity = ""
	state.lastLineHash = ""
	w.observed[path] = stamp
	w.state.Files[path] = cursorFile{}
	return w.save()
}

func (w *Watcher) readAppends(ctx context.Context, path string, state *fileState) error {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	if _, err := file.Seek(state.offset, io.SeekStart); err != nil {
		return err
	}
	reader := bufio.NewReader(file)
	read := state.offset
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		line, err := reader.ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		next := read + int64(len(line))
		line = bytes.TrimSuffix(line, []byte{'\n'})
		line = bytes.TrimSuffix(line, []byte{'\r'})

		before, err := state.parser.Snapshot()
		if err != nil {
			return err
		}
		mapped, parseErr := state.parser.ParseLine(line)
		if parseErr != nil {
			state.parser, err = w.options.NewParser(before)
			if err != nil {
				return err
			}
			if w.options.ParseWarning != nil {
				warning := w.options.ParseWarning(before, parseErr)
				mapped = &warning
			}
		}

		current := w.state.Files[path]
		pending := cursorFile{
			Offset:       read,
			Parser:       before,
			Identity:     state.identity,
			LastLineHash: state.lastLineHash,
		}
		if mapped != nil {
			if current.PendingID != "" && current.PendingNext == next {
				mapped.ID = current.PendingID
				pending = current
			} else {
				pending.PendingID = mapped.ID
				pending.PendingNext = next
				w.state.Files[path] = pending
				if err := w.save(); err != nil {
					state.parser, _ = w.options.NewParser(before)
					return err
				}
			}
		}
		if mapped != nil && w.options.Sink != nil {
			if err := w.options.Sink(*mapped); err != nil {
				state.parser, _ = w.options.NewParser(before)
				return err
			}
		}
		after, err := state.parser.Snapshot()
		if err != nil {
			state.parser, _ = w.options.NewParser(before)
			return err
		}
		identity := state.identity
		if read == 0 {
			identity = hashLine(line)
		}
		cursor := cursorFile{
			Offset:       next,
			Parser:       after,
			Identity:     identity,
			LastLineHash: hashLine(line),
		}
		w.state.Files[path] = cursor
		if err := w.save(); err != nil {
			state.parser, _ = w.options.NewParser(before)
			w.state.Files[path] = pending
			return err
		}
		state.offset = next
		state.identity = identity
		state.lastLineHash = cursor.LastLineHash
		read = next
	}
}

// Report persists a capture warning at most once per successful unique error.
func (w *Watcher) Report(err error) {
	if err == nil || w.options.Sink == nil || w.options.CaptureWarning == nil || w.warned[err.Error()] {
		return
	}
	if sinkErr := w.options.Sink(w.options.CaptureWarning(err)); sinkErr == nil {
		w.warned[err.Error()] = true
	}
}

func (w *Watcher) save() error {
	w.state.SavedAt = time.Now().UTC()
	if w.options.StatePath == "" {
		return nil
	}
	data, err := json.MarshalIndent(w.state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(w.options.StatePath), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(w.options.StatePath), ".durable-jsonl-*")
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
	if err := os.Rename(tmpPath, w.options.StatePath); err != nil {
		cleanup()
		return err
	}
	return nil
}

func (w *Watcher) baseline(path string) (*fileState, cursorFile, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, cursorFile{}, err
	}
	defer file.Close()
	parser, err := w.options.NewParser(nil)
	if err != nil {
		return nil, cursorFile{}, err
	}
	reader := bufio.NewReader(file)
	var offset int64
	var identity string
	var lastHash string
	for {
		line, err := reader.ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, cursorFile{}, err
		}
		offset += int64(len(line))
		line = bytes.TrimSuffix(line, []byte{'\n'})
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if identity == "" {
			identity = hashLine(line)
		}
		lastHash = hashLine(line)
		_, _ = parser.ParseLine(line)
	}
	snapshot, err := parser.Snapshot()
	if err != nil {
		return nil, cursorFile{}, err
	}
	state := &fileState{
		offset:       offset,
		parser:       parser,
		identity:     identity,
		lastLineHash: lastHash,
	}
	cursor := cursorFile{
		Offset:       offset,
		Parser:       snapshot,
		Identity:     identity,
		LastLineHash: lastHash,
	}
	return state, cursor, nil
}

func (w *Watcher) scan() []string {
	var paths []string
	_ = filepath.WalkDir(w.options.Root, func(path string, entry os.DirEntry, err error) error {
		if err == nil && w.options.Match(path, entry) {
			paths = append(paths, path)
		}
		return nil
	})
	sort.Strings(paths)
	return paths
}

func firstLineHash(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, maxFingerprintLine)
	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, bufio.ErrBufferFull) {
		return "", err
	}
	line = bytes.TrimSuffix(line, []byte{'\n'})
	line = bytes.TrimSuffix(line, []byte{'\r'})
	return hashLine(line), nil
}

func lastLineHashBefore(path string, offset int64) (string, error) {
	if offset <= 0 {
		return "", nil
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	start := offset - maxFingerprintLine
	if start < 0 {
		start = 0
	}
	size := offset - start
	buffer := make([]byte, size)
	if _, err := file.ReadAt(buffer, start); err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	buffer = bytes.TrimSuffix(buffer, []byte{'\n'})
	buffer = bytes.TrimSuffix(buffer, []byte{'\r'})
	if index := bytes.LastIndexByte(buffer, '\n'); index >= 0 {
		buffer = buffer[index+1:]
	}
	return hashLine(buffer), nil
}

func hashLine(line []byte) string {
	if len(line) > maxFingerprintLine {
		line = line[len(line)-maxFingerprintLine:]
	}
	sum := sha256.Sum256(line)
	return hex.EncodeToString(sum[:])
}

func stampFor(info os.FileInfo) fileStamp {
	return fileStamp{size: info.Size(), modTime: info.ModTime()}
}
