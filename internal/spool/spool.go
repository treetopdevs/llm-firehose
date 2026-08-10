// Package spool persists normalized events as daily append-only NDJSON files
// and tails them for live viewing. The spool is the local store: writers
// (firehose emit, adapters) append single lines with O_APPEND so concurrent
// producers never interleave, and the viewer tails the directory.
package spool

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// Writer appends events to the daily spool file in Dir.
type Writer struct {
	Dir string
}

func NewWriter(dir string) *Writer { return &Writer{Dir: dir} }

func fileFor(dir string, t time.Time) string {
	return filepath.Join(dir, t.UTC().Format("2006-01-02")+".ndjson")
}

// Append writes ev as one NDJSON line to today's spool file, stamping the
// current schema version on events that don't carry one. Callers that need
// repository identity must Enrich before privacy redaction and Append.
func (w *Writer) Append(ev event.Event) error {
	if err := ev.Validate(); err != nil {
		return err
	}
	if ev.ID == "" {
		ev.ID = event.NewID()
	}
	if ev.CaptureTime == nil {
		captured := time.Now().UTC()
		ev.CaptureTime = &captured
	}
	if ev.SchemaVersion == 0 {
		ev.SchemaVersion = event.CurrentSchemaVersion
	}
	data, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("spool: marshal: %w", err)
	}
	if err := os.MkdirAll(w.Dir, 0o755); err != nil {
		return fmt.Errorf("spool: mkdir: %w", err)
	}
	f, err := os.OpenFile(fileFor(w.Dir, ev.Time), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("spool: open: %w", err)
	}
	defer f.Close()
	_, err = f.Write(append(data, '\n'))
	return err
}

// spoolFiles returns the .ndjson files in dir, oldest first.
func spoolFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".ndjson") {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(files) // YYYY-MM-DD names sort chronologically
	return files, nil
}

// ReadLastN returns up to n most recent events across spool files, oldest first.
func ReadLastN(dir string, n int) ([]event.Event, error) {
	files, err := spoolFiles(dir)
	if err != nil {
		return nil, err
	}
	var all []event.Event
	// Read newest files first until we have enough lines.
	for i := len(files) - 1; i >= 0 && len(all) < n; i-- {
		evs, err := readFile(files[i])
		if err != nil {
			return nil, err
		}
		all = append(evs, all...)
	}
	if len(all) > n {
		all = all[len(all)-n:]
	}
	return all, nil
}

// ReadDays returns all events from the named UTC day files (YYYY-MM-DD),
// oldest first. Missing files are skipped so callers can pass index-derived
// day lists without racing file rotation.
func ReadDays(dir string, days []string) ([]event.Event, error) {
	sorted := append([]string(nil), days...)
	sort.Strings(sorted) // day names sort chronologically
	var all []event.Event
	for _, day := range sorted {
		evs, err := readFile(filepath.Join(dir, day+".ndjson"))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		all = append(all, evs...)
	}
	return all, nil
}

func readFile(path string) ([]event.Event, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var evs []event.Event
	reader := bufio.NewReader(f)
	for {
		line, _, err := readLine(reader, true)
		if errors.Is(err, io.EOF) {
			break
		}
		if errors.Is(err, errOversizedRecord) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var ev event.Event
		if err := json.Unmarshal(line, &ev); err != nil {
			continue // reader skips bad lines; the tailer surfaces them
		}
		evs = append(evs, ev)
	}
	return evs, nil
}

// Tailer polls the spool directory and delivers newly appended events.
type Tailer struct {
	Dir      string
	Interval time.Duration
	offsets  map[string]int64
	primed   bool
}

func NewTailer(dir string, interval time.Duration) *Tailer {
	return &Tailer{Dir: dir, Interval: interval, offsets: map[string]int64{}}
}

// Prime records current file sizes so Run only streams lines appended after
// this call. Calling it before Run pins the snapshot boundary: a caller can
// read the spool (e.g. an index rebuild) after Prime without losing events
// appended in between. Not safe to call concurrently with Run.
func (t *Tailer) Prime() {
	if t.primed {
		return
	}
	t.primed = true
	if files, err := spoolFiles(t.Dir); err == nil {
		for _, f := range files {
			if fi, err := os.Stat(f); err == nil {
				t.offsets[f] = fi.Size()
			}
		}
	}
}

// Run polls until ctx is done, sending new events (and meta/warn events for
// unparseable lines) on ch. Files existing at start are skipped to their end
// unless Prime already pinned an earlier boundary.
func (t *Tailer) Run(ctx context.Context, ch chan<- event.Event) {
	t.Prime()
	ticker := time.NewTicker(t.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			t.poll(ctx, ch)
		}
	}
}

// maxRecordBytes caps a single NDJSON record during reads. It sits above the
// 5 MiB large-record round-trip tests while still bounding live-tail memory.
const maxRecordBytes = 8 << 20

var errOversizedRecord = errors.New("spool: oversized record")

func (t *Tailer) poll(ctx context.Context, ch chan<- event.Event) {
	files, err := spoolFiles(t.Dir)
	if err != nil {
		return
	}
	for _, path := range files {
		fi, err := os.Stat(path)
		if err != nil {
			continue
		}
		off := t.offsets[path]
		if fi.Size() <= off {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		if _, err := f.Seek(off, 0); err != nil {
			f.Close()
			continue
		}
		reader := bufio.NewReader(f)
		read := off
		for {
			line, consumed, readErr := readLine(reader, false)
			if errors.Is(readErr, io.EOF) {
				break
			}
			if readErr != nil && !errors.Is(readErr, errOversizedRecord) {
				break
			}
			read += consumed
			var ev event.Event
			var perr error
			if errors.Is(readErr, errOversizedRecord) {
				captured := time.Now().UTC()
				ev = event.Event{
					ID:          event.NewID(),
					Time:        captured,
					CaptureTime: &captured,
					Source:      "firehose",
					Category:    event.CategoryMeta,
					Name:        "parse-error",
					Severity:    event.SeverityWarn,
					Summary:     fmt.Sprintf("oversized spool record in %s (>%d bytes)", filepath.Base(path), maxRecordBytes),
				}
			} else {
				ev, perr = parseLine(line)
				if perr != nil {
					captured := time.Now().UTC()
					ev = event.Event{
						ID:          event.NewID(),
						Time:        captured,
						CaptureTime: &captured,
						Source:      "firehose",
						Category:    event.CategoryMeta,
						Name:        "parse-error",
						Severity:    event.SeverityWarn,
						Summary:     fmt.Sprintf("unparseable spool line in %s: %v", filepath.Base(path), perr),
					}
				}
			}
			select {
			case ch <- ev:
			case <-ctx.Done():
				f.Close()
				return
			}
		}
		f.Close()
		t.offsets[path] = read
	}
}

// readLine returns one record and the exact number of bytes consumed. Snapshot
// readers accept a legacy final record without a newline; live tailers leave
// unfinished records unconsumed so a later append can complete them. Records
// larger than maxRecordBytes are quarantined: the remainder through the next
// newline (or EOF) is consumed and errOversizedRecord is returned.
func readLine(reader *bufio.Reader, acceptFinal bool) ([]byte, int64, error) {
	var raw []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		raw = append(raw, chunk...)
		if len(raw) > maxRecordBytes {
			consumed := int64(len(raw))
			if len(chunk) == 0 || chunk[len(chunk)-1] != '\n' {
				skipped, skipErr := discardThroughNewline(reader)
				consumed += skipped
				if skipErr != nil && !errors.Is(skipErr, io.EOF) {
					return nil, consumed, skipErr
				}
			}
			return nil, consumed, errOversizedRecord
		}
		if err == nil {
			line := bytes.TrimSuffix(raw, []byte{'\n'})
			line = bytes.TrimSuffix(line, []byte{'\r'})
			return line, int64(len(raw)), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if len(raw) == 0 || !acceptFinal {
				return nil, 0, io.EOF
			}
			line := bytes.TrimSuffix(raw, []byte{'\r'})
			return line, int64(len(raw)), nil
		}
		return nil, 0, err
	}
}

func discardThroughNewline(reader *bufio.Reader) (int64, error) {
	var n int64
	for {
		chunk, err := reader.ReadSlice('\n')
		n += int64(len(chunk))
		if len(chunk) > 0 && chunk[len(chunk)-1] == '\n' {
			return n, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return n, err
	}
}

func parseLine(line []byte) (event.Event, error) {
	var ev event.Event
	if err := json.Unmarshal(line, &ev); err != nil {
		return ev, err
	}
	if err := ev.Validate(); err != nil {
		return ev, err
	}
	return ev, nil
}
