package codex

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"time"

	"agentfirehose/internal/capturemeta"
	"agentfirehose/internal/durablejsonl"
	"agentfirehose/internal/event"
)

// DurableManifest describes the passive rollout transport. It is intentionally
// conservative because rollout JSONL is a local internal record format.
var DurableManifest = capturemeta.Manifest{
	Source:    Source,
	Transport: "durable-jsonl",
	Fidelity:  capturemeta.PassiveInternalFile,
	Mapped: []string{
		"session_meta", "turn_context", "world_state", "task_started", "task_complete",
		"user_message", "agent_message", "exec_command_end", "patch_apply_end",
		"mcp_tool_call_end", "function_call", "function_call_output",
		"custom_tool_call", "custom_tool_call_output",
		"tool_search_call", "tool_search_output",
		"token_count", "context_compacted", "thread_settings_applied", "error",
	},
	Filtered: []string{
		"reasoning", "encrypted_reasoning", "duplicate_response_item", "instruction_body",
	},
	SourceSchema: "codex-rollout-jsonl",
}

// DurableWatcher adapts Codex rollout parsing and warnings onto the shared
// crash-safe durable JSONL core.
type DurableWatcher struct {
	Root      string
	StatePath string
	Interval  time.Duration
	Sink      func(event.Event) error

	core   *durablejsonl.Watcher
	loaded bool
}

// NewDurableWatcher constructs a rollout watcher with a durable checkpoint.
func NewDurableWatcher(root, statePath string, interval time.Duration, sink func(event.Event) error) *DurableWatcher {
	return &DurableWatcher{
		Root:      root,
		StatePath: statePath,
		Interval:  interval,
		Sink:      sink,
	}
}

func (w *DurableWatcher) ensureCore() {
	if w.core != nil {
		return
	}
	w.core = durablejsonl.New(durablejsonl.Options{
		Root:      w.Root,
		StatePath: w.StatePath,
		Interval:  w.Interval,
		Match: func(path string, entry os.DirEntry) bool {
			return !entry.IsDir() && strings.HasSuffix(path, ".jsonl")
		},
		NewParser: newDurableParser,
		Sink: func(ev event.Event) error {
			if w.Sink == nil {
				return nil
			}
			return w.Sink(ev)
		},
		ParseWarning: func(snapshot json.RawMessage, err error) event.Event {
			var state ParserState
			_ = json.Unmarshal(snapshot, &state)
			return parseWarning(state, err)
		},
		CaptureWarning: captureWarning,
	})
}

// Initialize loads a prior checkpoint or baselines pre-existing rollouts.
func (w *DurableWatcher) Initialize() error {
	w.ensureCore()
	err := w.core.Initialize()
	w.loaded = w.core.Loaded()
	return err
}

// Run polls until cancellation.
func (w *DurableWatcher) Run(ctx context.Context) {
	w.ensureCore()
	w.core.Run(ctx)
	w.loaded = w.core.Loaded()
}

// Poll processes all complete newly appended rollout lines.
func (w *DurableWatcher) Poll(ctx context.Context) error {
	w.ensureCore()
	err := w.core.Poll(ctx)
	w.loaded = w.core.Loaded()
	return err
}

func (w *DurableWatcher) report(err error) {
	w.ensureCore()
	w.core.Report(err)
}

type durableParser struct {
	parser *FileParser
}

func newDurableParser(snapshot json.RawMessage) (durablejsonl.Parser, error) {
	if len(snapshot) == 0 || string(snapshot) == "null" {
		return &durableParser{parser: NewFileParser()}, nil
	}
	var state ParserState
	if err := json.Unmarshal(snapshot, &state); err != nil {
		return nil, err
	}
	return &durableParser{parser: NewFileParserFrom(state)}, nil
}

func (p *durableParser) ParseLine(line []byte) (*event.Event, error) {
	ev, err := p.parser.ParseLine(line)
	if ev != nil {
		ev.Transport = "durable-jsonl"
	}
	return ev, err
}

func (p *durableParser) Snapshot() (json.RawMessage, error) {
	return json.Marshal(p.parser.Snapshot())
}

func captureWarning(err error) event.Event {
	captured := time.Now().UTC()
	return event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: &captured,
		Source:      Source,
		Agent:       "codex",
		Transport:   "durable-jsonl",
		Category:    event.CategoryMeta,
		Name:        "rollout_capture_error",
		Severity:    event.SeverityWarn,
		Summary:     "Codex rollout capture warning: " + err.Error(),
		Payload: map[string]any{
			"transport": "durable-jsonl",
			"status":    "error",
		},
	}
}

func parseWarning(state ParserState, err error) event.Event {
	captured := time.Now().UTC()
	return event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: &captured,
		Source:      Source,
		Agent:       "codex",
		SessionID:   state.SessionID,
		CWD:         state.CWD,
		Transport:   "durable-jsonl",
		Category:    event.CategoryMeta,
		Name:        "rollout_parse_error",
		Severity:    event.SeverityWarn,
		Summary:     "Codex rollout record could not be parsed: " + err.Error(),
		Payload: map[string]any{
			"transport": "durable-jsonl",
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
