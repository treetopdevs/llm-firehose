package codex

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// Watcher polls a Codex sessions root for rollout .jsonl files and streams
// newly appended lines as events. Files that exist when the watcher starts
// are skipped to their current end; files created later are read from the top
// so new sessions surface completely.
type Watcher struct {
	Root     string
	Interval time.Duration
	files    map[string]*fileState
}

type fileState struct {
	offset int64
	parser *FileParser
}

func NewWatcher(root string, interval time.Duration) *Watcher {
	return &Watcher{Root: root, Interval: interval, files: map[string]*fileState{}}
}

// Run polls until ctx is done, sending events on ch.
func (w *Watcher) Run(ctx context.Context, ch chan<- event.Event) {
	// Skip pre-existing files to their end so we only stream live activity.
	for _, path := range w.scan() {
		st := &fileState{parser: NewFileParser()}
		if fi, err := os.Stat(path); err == nil {
			st.offset = fi.Size()
		}
		w.files[path] = st
	}
	ticker := time.NewTicker(w.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.poll(ctx, ch)
		}
	}
}

func (w *Watcher) scan() []string {
	var paths []string
	filepath.WalkDir(w.Root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && strings.HasSuffix(path, ".jsonl") {
			paths = append(paths, path)
		}
		return nil
	})
	return paths
}

func (w *Watcher) poll(ctx context.Context, ch chan<- event.Event) {
	for _, path := range w.scan() {
		st, ok := w.files[path]
		if !ok {
			st = &fileState{parser: NewFileParser()}
			w.files[path] = st
		}
		fi, err := os.Stat(path)
		if err != nil || fi.Size() <= st.offset {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		if _, err := f.Seek(st.offset, 0); err != nil {
			f.Close()
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		read := st.offset
		for sc.Scan() {
			line := sc.Bytes()
			read += int64(len(line)) + 1
			ev, err := st.parser.ParseLine(line)
			if err != nil || ev == nil {
				continue
			}
			select {
			case ch <- *ev:
			case <-ctx.Done():
				f.Close()
				return
			}
		}
		f.Close()
		st.offset = read
	}
}
