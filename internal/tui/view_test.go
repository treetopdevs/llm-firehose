package tui

import (
	"fmt"
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
	if !strings.Contains(first, " 1m ") || !strings.Contains(second, " 5s ") {
		t.Errorf("band should show time since last event: %q / %q", first, second)
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
