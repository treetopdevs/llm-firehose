// Package procwatch emits agent-start / agent-stop events by polling the
// process table for known agent binaries. It gives process-level visibility
// for agents that have no deeper adapter.
package procwatch

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// Source is the agent family identifier for process watcher events.
const Source = "procwatch"

// Process is one row of the process table.
type Process struct {
	PID     int
	Command string // executable path or name
	Args    string // full argv
}

// Lister supplies the current process table; injectable for tests.
type Lister interface {
	List() ([]Process, error)
}

// knownAgents maps executable base names to the agent name we report.
var knownAgents = map[string]string{
	"claude":       "claude",
	"codex":        "codex",
	"opencode":     "opencode",
	"aider":        "aider",
	"agy":          "antigravity",
	"gemini":       "gemini",
	"cursor-agent": "cursor-agent",
	"copilot":      "copilot",
	"goose":        "goose",
	"amp":          "amp",
}

func matchAgent(command string) string {
	return knownAgents[filepath.Base(command)]
}

// Watcher diffs successive process listings and reports agent lifecycle.
type Watcher struct {
	lister   Lister
	interval time.Duration
	running  map[int]string // pid -> agent
	baseline bool
}

func NewWatcher(l Lister, interval time.Duration) *Watcher {
	return &Watcher{lister: l, interval: interval, running: map[int]string{}}
}

// Run polls until ctx is done. The first poll establishes a baseline so
// long-running agents present at startup do not fire start events.
func (w *Watcher) Run(ctx context.Context, ch chan<- event.Event) {
	w.poll(ctx, ch, true)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.poll(ctx, ch, false)
		}
	}
}

func (w *Watcher) poll(ctx context.Context, ch chan<- event.Event, baseline bool) {
	procs, err := w.lister.List()
	if err != nil {
		return
	}
	current := map[int]string{}
	for _, p := range procs {
		agent := matchAgent(p.Command)
		if agent == "" {
			continue
		}
		current[p.PID] = agent
		if _, seen := w.running[p.PID]; !seen && !baseline {
			w.emit(ctx, ch, "agent-start", agent, p.PID, fmt.Sprintf("%s started (pid %d)", agent, p.PID))
		}
	}
	for pid, agent := range w.running {
		if _, still := current[pid]; !still && !baseline {
			w.emit(ctx, ch, "agent-stop", agent, pid, fmt.Sprintf("%s exited (pid %d)", agent, pid))
		}
	}
	w.running = current
}

func (w *Watcher) emit(ctx context.Context, ch chan<- event.Event, name, agent string, pid int, summary string) {
	captured := time.Now().UTC()
	ev := event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: &captured,
		Source:      Source,
		Agent:       agent,
		Category:    event.CategorySession,
		Name:        name,
		Severity:    event.SeverityNotice,
		Summary:     summary,
		Payload:     map[string]any{"pid": pid},
	}
	select {
	case ch <- ev:
	case <-ctx.Done():
	}
}

// PSLister lists processes via `ps` (macOS / any POSIX).
type PSLister struct{}

func (PSLister) List() ([]Process, error) {
	out, err := exec.Command("ps", "-axo", "pid=,comm=,args=").Output()
	if err != nil {
		return nil, err
	}
	var procs []Process
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		procs = append(procs, Process{PID: pid, Command: fields[1], Args: strings.Join(fields[2:], " ")})
	}
	return procs, nil
}
