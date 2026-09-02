package tui

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"agentfirehose/internal/event"
)

func plain(s string) string { return ansiEscape.ReplaceAllString(s, "") }

func viewLines(m Model) []string {
	return strings.Split(strings.TrimRight(plain(m.View()), "\n"), "\n")
}

func indexOf(lines []string, want string) int {
	for i, l := range lines {
		if l == want {
			return i
		}
	}
	return -1
}

func TestRowsRepeatOnlyWhatChanged(t *testing.T) {
	m := newTestModel()
	a := mkEv(1, event.CategoryTool, "ran: go test")
	a.CWD = "/home/me/dev/app"
	b := mkEv(3, event.CategoryShell, "ran: ls")
	b.Source, b.Agent, b.SessionID, b.CWD = "codex", "codex", "s2", a.CWD
	c := mkEv(60, event.CategoryFile, "edit x.go") // next minute, other directory
	c.CWD = "/home/me/dev/lib"
	m = push(push(push(m, a), b), c)
	m.now = func() time.Time { return t0.Add(61 * time.Second) }

	full := func(ev event.Event) string { return ev.Time.Local().Format("15:04:05") }
	want := []string{
		full(a) + " │ claude ● ran: go test …/dev/app",
		"     " + b.Time.Local().Format(":05") + " │ codex  $ ran: ls",
		full(c) + " │ claude ■ edit x.go …/dev/lib",
	}
	got := viewLines(m)
	at := indexOf(got, want[0])
	if at < 0 {
		t.Fatalf("first row %q not found in:\n%s", want[0], strings.Join(got, "\n"))
	}
	for i, w := range want {
		if got[at+i] != w {
			t.Errorf("row %d = %q, want %q", i, got[at+i], w)
		}
	}
	if strings.Contains(strings.Join(got[at:at+3], "\n"), "[") {
		t.Error("rows must not spend cells on brackets")
	}
}

func TestBandShowsOneLinePerLiveSession(t *testing.T) {
	now := t0.Add(5 * time.Minute)
	m := newTestModel()
	m.now = func() time.Time { return now }
	for i := range 3 {
		ev := mkEv(i, event.CategoryTool, "edit view.go")
		ev.Time = now.Add(-time.Duration(10*i+5) * time.Second)
		m = push(m, ev)
	}
	asked := mkEv(10, event.CategoryPermission, "Bash wants to run rm")
	asked.SessionID, asked.Source, asked.Agent = "s2", "codex", "codex"
	asked.Time = now.Add(-time.Minute)
	m = push(m, asked)
	m = push(m, stateTransitionAt(now.Add(-time.Minute), "s2", stateNeedsInput, "approve Bash"))
	m = push(m, stateTransitionAt(now.Add(-5*time.Second), "s1", stateWorking, ""))

	got := viewLines(m)
	if len(got) < 5 {
		t.Fatalf("view too short:\n%s", strings.Join(got, "\n"))
	}
	first, second, sep := got[1], got[2], got[3]
	if !strings.HasPrefix(first, "│ codex ") || !strings.Contains(first, "NEEDS YOU") || !strings.Contains(first, "approve Bash") {
		t.Errorf("needs-you session should lead the band with its reason: %q", first)
	}
	if !strings.HasPrefix(second, "│ claude ") || !strings.ContainsAny(second, "▁▂▃▄▅▆▇█") || !strings.Contains(second, "edit view.go") {
		t.Errorf("working session should show a sparkline and last summary: %q", second)
	}
	// Time in state is a bar against the five-minute hairline, labelled with
	// its own number.
	if !strings.Contains(first, dwellBar(time.Minute)+"  1m ") {
		t.Errorf("needs-you session should show its wait as a bar with a label: %q", first)
	}
	if !strings.Contains(second, dwellBar(0)+"  5s ") {
		t.Errorf("a five-second dwell is under half a cell but still labelled: %q", second)
	}
	if sep != "" {
		t.Errorf("band should be separated from the feed by a blank line, got %q", sep)
	}
}

func TestBandCapsRowsAndCountsTheRest(t *testing.T) {
	now := t0.Add(time.Minute)
	m := newTestModel() // 120x30 → up to 6 band rows
	m.now = func() time.Time { return now }
	for i := range 8 {
		ev := mkEv(i, event.CategoryTool, "work")
		ev.SessionID = fmt.Sprintf("s%d", i)
		ev.Time = now.Add(-time.Duration(i) * time.Second)
		m = push(m, ev)
	}
	got := viewLines(m)
	sep := indexOf(got, "")
	if sep != 8 || !strings.Contains(got[7], "+2 more") {
		t.Fatalf("band = %q", got[1:sep+1])
	}
}

func TestHelpLivesBehindQuestionMark(t *testing.T) {
	m := newTestModel()
	if v := plain(m.View()); strings.Contains(v, "space pause") || !strings.Contains(v, "? help") {
		t.Fatalf("footer should only point at help:\n%s", v)
	}
	m = key(m, "?")
	if v := plain(m.View()); !strings.Contains(v, "◆ session") || !strings.Contains(v, "space") {
		t.Fatalf("help should list keys and the glyph legend:\n%s", v)
	}
	m = key(m, "esc")
	if strings.Contains(plain(m.View()), "◆ session") {
		t.Error("esc should close help")
	}
}

func TestLanesToggleAndZoom(t *testing.T) {
	now := t0.Add(2 * time.Minute)
	m := newTestModel()
	m.now = func() time.Time { return now }
	m = push(m, laneEvent(now, 30*time.Second, "c1", "start"))
	m = push(m, laneEvent(now, 10*time.Second, "c1", "end"))
	m = key(m, "l")
	v := plain(m.View())
	if !strings.Contains(v, "lanes · 5m") {
		t.Fatalf("header should name the lane window:\n%s", v)
	}
	if !strings.Contains(v, "╷") || !strings.Contains(v, "─") || !strings.Contains(v, "▂") {
		t.Fatalf("lanes need an axis, a span, and event ticks:\n%s", v)
	}
	m = key(m, "+")
	if !strings.Contains(plain(m.View()), "lanes · 15m") {
		t.Error("+ should widen the window")
	}
	m = key(key(m, "-"), "-")
	if !strings.Contains(plain(m.View()), "lanes · 1m") {
		t.Error("- should narrow the window")
	}
	m = key(m, "l")
	if strings.Contains(plain(m.View()), "lanes ·") {
		t.Error("l should return to the feed")
	}
}

func TestLinesFitTheTerminalWidth(t *testing.T) {
	now := t0.Add(time.Minute)
	m := newTestModel()
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 40, Height: 20})
	m = mm.(Model)
	m.now = func() time.Time { return now }
	long := mkEv(1, event.CategoryTool, strings.Repeat("summary ", 40))
	long.CWD = "/very/long/path/to/some/repo"
	long.Time = now.Add(-time.Second)
	m = push(m, long)
	m = push(m, stateTransitionAt(now, "s1", stateNeedsInput, strings.Repeat("reason ", 40)))
	check := func(mode string) {
		lines := strings.Split(strings.TrimRight(m.View(), "\n"), "\n")
		for i, l := range lines[1:] {
			if w := lipgloss.Width(l); w > 40 {
				t.Errorf("%s line %d is %d cells wide: %q", mode, i+1, w, plain(l))
			}
		}
	}
	check("feed")
	m = key(m, "l")
	check("lanes")
}

func TestRowSummaryStripsControlSequences(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryTool, "ok\x1b[2J\x07\tdone"))
	v := m.View()
	if strings.Contains(v, "\x1b[2J") || strings.Contains(v, "\x07") {
		t.Fatalf("row leaked control sequences:\n%q", v)
	}
	if !strings.Contains(plain(v), "ok done") {
		t.Fatalf("expected sanitized summary:\n%s", plain(v))
	}
}

func callPair(now time.Time) (event.Event, event.Event) {
	start := mkEv(1, event.CategoryShell, "ran: go test ./...")
	start.CallID, start.TurnID, start.CWD = "c1", "t1", "/home/me/dev/app"
	start.Time = now.Add(-10 * time.Second)
	start.Payload = map[string]any{"phase": "start", "tool_name": "Bash", "command": "go test ./..."}
	end := mkEv(2, event.CategoryShell, "ran: go test ./...")
	end.CallID, end.TurnID, end.CWD = "c1", "t1", start.CWD
	end.Time = start.Time.Add(2590 * time.Millisecond)
	end.Payload = map[string]any{
		"phase": "end", "tool_name": "Bash", "exit_code": 0,
		"stdout": map[string]any{"sha256": "abcdef0123456789abcdef", "len": 512},
	}
	return start, end
}

func TestCallAltitudePairsPhasesAndTabulatesPayload(t *testing.T) {
	now := t0.Add(time.Minute)
	m := newTestModel()
	m.now = func() time.Time { return now }
	start, end := callPair(now)
	src := end.Time.Add(-42 * time.Millisecond)
	cap := end.Time
	end.SourceTime, end.CaptureTime = &src, &cap
	m = push(m, stateTransitionAt(start.Time, "s1", stateWorking, ""))
	m = push(push(m, start), end)
	m = key(m, "enter") // follow mode selects the last row: the end of c1

	v := plain(m.View())
	for _, want := range []string{
		"CALL",
		"…/dev/app · claude · session s1",
		"│ claude ", // the parent session's band line survives the zoom
		"started   " + start.Time.Local().Format("15:04:05.000"),
		"ended     " + end.Time.Local().Format("15:04:05.000") + "  2.59s",
		"captured  +42ms after source",
		"turn t1 · call c1",
	} {
		if !strings.Contains(v, want) {
			t.Errorf("call view missing %q:\n%s", want, v)
		}
	}
	for _, re := range []string{`command\s+go test \./\.\.\.`, `exit_code\s+0`, `stdout\s+#abcdef01 · len 512`} {
		if !regexp.MustCompile(re).MatchString(v) {
			t.Errorf("payload table missing %s:\n%s", re, v)
		}
	}
	// The request (start payload) and response (end payload) are the two halves
	// of one call; keys the headline and timing already express are not repeated.
	if strings.Index(v, "request") > strings.Index(v, "command") || strings.Index(v, "response") > strings.Index(v, "exit_code") {
		t.Errorf("request should precede its keys and response its own:\n%s", v)
	}
	for _, re := range []string{`(?m)^\s+phase\s`, `(?m)^\s+tool_name\s`} {
		if regexp.MustCompile(re).MatchString(v) {
			t.Errorf("%s is already expressed above the table:\n%s", re, v)
		}
	}
	if strings.Contains(v, `"exit_code"`) || strings.Contains(v, "{") {
		t.Errorf("call view must be a table, not marshalled JSON:\n%s", v)
	}
	m = key(m, "esc")
	if strings.Contains(plain(m.View()), "CALL") {
		t.Error("esc should ascend to the session altitude")
	}
}

func TestCallAltitudeReportsUnfinishedCalls(t *testing.T) {
	now := t0.Add(time.Minute)
	m := newTestModel()
	m.now = func() time.Time { return now }
	start, _ := callPair(now)
	m = push(m, stateTransitionAt(start.Time, "s1", stateWorking, ""))
	m = push(m, start)
	m = key(m, "enter")
	if v := plain(m.View()); !strings.Contains(v, "ended     still running · 10s") {
		t.Errorf("a working session's open call should read as running:\n%s", v)
	}
	m = key(m, "esc")
	m = push(m, stateTransitionAt(now, "s1", stateDone, ""))
	m = key(m, "k") // the transition row is last; the call is above it
	m = key(m, "enter")
	if v := plain(m.View()); !strings.Contains(v, "ended     no end captured") {
		t.Errorf("a finished session's open call should say so:\n%s", v)
	}
}

func TestEscAscendsToWorkspaceAndEnterDescendsScoped(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now)
	m = key(m, "esc")
	v := viewLines(m)
	if !strings.Contains(v[0], "workspace") {
		t.Fatalf("esc should ascend to the workspace altitude:\n%s", strings.Join(v, "\n"))
	}
	app := -1
	for i, l := range v {
		if strings.HasPrefix(l, "…/dev/app") {
			app = i
		}
	}
	if app < 0 {
		t.Fatalf("matrix should have a row per workspace:\n%s", strings.Join(v, "\n"))
	}
	if !strings.Contains(v[app-1], "claude") || !strings.Contains(v[app-1], "codex") {
		t.Errorf("columns should be agents: %q", v[app-1])
	}
	if !strings.Contains(v[app], "●") || !strings.Contains(v[app], "?") {
		t.Errorf("cells should carry a state glyph: %q", v[app])
	}
	if !strings.HasPrefix(v[app+1], "aa43f1ff") {
		t.Errorf("a digested directory is labelled by its first hex digits: %q", v[app+1])
	}

	m = key(m, "enter") // first cell: …/dev/app · claude
	v = viewLines(m)
	joined := strings.Join(v, "\n")
	if !strings.Contains(v[0], "…/dev/app · claude") {
		t.Errorf("header should carry the scope as a breadcrumb: %q", v[0])
	}
	if !strings.Contains(joined, "s1 edits") || strings.Contains(joined, "s2 asks") || strings.Contains(joined, "s3 writes") {
		t.Errorf("rows should be scoped to the cell:\n%s", joined)
	}
	if !strings.Contains(joined, "╷") {
		t.Errorf("the session altitude reads as lanes over rows:\n%s", joined)
	}
	if strings.Contains(joined, "│ codex") {
		t.Errorf("the strip should be scoped too:\n%s", joined)
	}

	m = key(key(key(m, "esc"), "j"), "enter") // second cell: …/dev/app · codex
	v = viewLines(m)
	joined = strings.Join(v, "\n")
	if !strings.Contains(v[0], "…/dev/app · codex") || !strings.Contains(joined, "s2 asks") || strings.Contains(joined, "s1 edits") {
		t.Errorf("j should move to the next cell before descending:\n%s", joined)
	}
	if !strings.Contains(joined, "NEEDS YOU") {
		t.Errorf("the scoped lane should still show the engine state:\n%s", joined)
	}
}

func TestLanesStripKeepsRows(t *testing.T) {
	now := t0.Add(2 * time.Minute)
	m := newTestModel()
	m.now = func() time.Time { return now }
	m = push(m, laneEvent(now, 30*time.Second, "c1", "start"))
	m = key(m, "l")
	v := plain(m.View())
	if !strings.Contains(v, "╷") || !strings.Contains(v, "─") {
		t.Fatalf("lanes strip missing:\n%s", v)
	}
	if !strings.Contains(v, "$ x") {
		t.Fatalf("rows should stay under the lanes strip:\n%s", v)
	}
}

func TestAltitudeLabelsStripControlSequences(t *testing.T) {
	now := t0.Add(time.Minute)
	m := newTestModel()
	m.now = func() time.Time { return now }
	ev := mkEv(1, event.CategoryTool, "work")
	ev.CWD, ev.Agent, ev.Time = "/home/me/dev/\x1b[31mapp\x07", "cla\x1b[2Jude", now.Add(-time.Second)
	m = push(m, ev)
	m = key(m, "esc")
	if v := m.View(); strings.Contains(v, "\x1b") || strings.Contains(v, "\x07") {
		t.Fatalf("workspace altitude leaked control sequences:\n%q", v)
	} else if !strings.Contains(v, "…/dev/app") || !strings.Contains(v, "claude") {
		t.Fatalf("labels should survive sanitizing:\n%s", v)
	}
	m = key(m, "enter")
	if h := m.viewHeader(); strings.Contains(h, "\x1b") || !strings.Contains(h, "…/dev/app · claude") {
		t.Fatalf("scope breadcrumb = %q", h)
	}
	m = key(m, "enter")
	if v := m.View(); strings.Contains(v, "\x1b") || !strings.Contains(v, "…/dev/app · claude · session s1") {
		t.Fatalf("call crumb leaked or lost its labels:\n%q", v)
	}
}

func TestWorkspaceKeysAreSafeOnAnEmptyMatrix(t *testing.T) {
	m := newTestModel()
	m = key(key(key(key(m, "esc"), "k"), "j"), "enter")
	if m.alt != altWorkspace || m.scope != nil {
		t.Fatalf("enter on an empty matrix should stay put: alt=%v scope=%v", m.alt, m.scope)
	}
	if !strings.Contains(plain(m.View()), "no live sessions") {
		t.Fatalf("empty matrix should say so:\n%s", plain(m.View()))
	}
}
