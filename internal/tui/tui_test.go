package tui

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"agentfirehose/internal/event"
)

var t0 = time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)

func mkEv(i int, cat event.Category, summary string) event.Event {
	return event.Event{
		ID: fmt.Sprintf("e%d", i), Time: t0.Add(time.Duration(i) * time.Second),
		Source: "claude-code", Agent: "claude", SessionID: "s1",
		Category: cat, Name: "n", Severity: event.SeverityInfo, Summary: summary,
		Payload: map[string]any{"k": "v"},
	}
}

func newTestModel() Model {
	m := NewModel(nil)
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	return mm.(Model)
}

func push(m Model, ev event.Event) Model {
	mm, _ := m.Update(EventMsg{Event: ev})
	return mm.(Model)
}

func key(m Model, k string) Model {
	var msg tea.KeyMsg
	switch k {
	case "space":
		msg = tea.KeyMsg{Type: tea.KeySpace}
	case "enter":
		msg = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		msg = tea.KeyMsg{Type: tea.KeyEsc}
	default:
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
	}
	mm, _ := m.Update(msg)
	return mm.(Model)
}

func TestNewEventAppearsInView(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryShell, "ran: go test ./..."))
	view := m.View()
	if !strings.Contains(view, "ran: go test ./...") {
		t.Errorf("view missing event summary:\n%s", view)
	}
	if !strings.Contains(view, "claude") {
		t.Errorf("view missing agent badge:\n%s", view)
	}
}

func TestPauseHoldsStreamAndCountsUnread(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryShell, "first event"))
	m = key(m, "space") // pause
	if !m.Paused() {
		t.Fatal("space should pause")
	}
	m = push(m, mkEv(2, event.CategoryShell, "arrived while paused"))
	view := m.View()
	if strings.Contains(view, "arrived while paused") {
		t.Error("paused view should not show new events")
	}
	if !strings.Contains(view, "1 new") {
		t.Errorf("paused view should show unread count:\n%s", view)
	}
	m = key(m, "space") // resume
	view = m.View()
	if !strings.Contains(view, "arrived while paused") {
		t.Error("resume should reveal held events")
	}
}

func TestCategoryFilterCyclesAndNarrows(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryShell, "shell event here"))
	m = push(m, mkEv(2, event.CategoryPrompt, "prompt event here"))
	// cycle category filter until it lands on shell
	found := false
	for range 12 {
		m = key(m, "f")
		if m.Filter().Category == event.CategoryShell {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("could not cycle to shell filter")
	}
	view := m.View()
	if strings.Contains(view, "prompt event here") {
		t.Error("filtered view should hide other categories")
	}
	if !strings.Contains(view, "shell event here") {
		t.Error("filtered view should keep matching category")
	}
}

func TestDetailPaneShowsPayload(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryTool, "tool call"))
	m = key(m, "enter")
	view := m.View()
	if !strings.Contains(view, `"k": "v"`) {
		t.Errorf("detail should render payload JSON:\n%s", view)
	}
	m = key(m, "esc")
	if strings.Contains(m.View(), `"k": "v"`) {
		t.Error("esc should close detail")
	}
}

func TestSearchFiltersBySummary(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryShell, "ran: make build"))
	m = push(m, mkEv(2, event.CategoryShell, "ran: go vet"))
	m = key(m, "/")
	for _, r := range "vet" {
		m = key(m, string(r))
	}
	m = key(m, "enter")
	view := m.View()
	if strings.Contains(view, "make build") || !strings.Contains(view, "go vet") {
		t.Errorf("search filter wrong:\n%s", view)
	}
}

func TestBurstCoalescesInView(t *testing.T) {
	m := newTestModel()
	for i := range 4 {
		ev := mkEv(0, event.CategoryShell, "ran: ls")
		ev.ID = fmt.Sprintf("b%d", i)
		ev.Time = t0.Add(time.Duration(i) * 100 * time.Millisecond)
		m = push(m, ev)
	}
	view := m.View()
	if !strings.Contains(view, "×4") {
		t.Errorf("burst should collapse with count:\n%s", view)
	}
}

func TestQuitKey(t *testing.T) {
	m := newTestModel()
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	if cmd == nil {
		t.Fatal("q should quit")
	}
	if msg := cmd(); msg != tea.Quit() {
		t.Errorf("expected quit msg, got %#v", msg)
	}
}
