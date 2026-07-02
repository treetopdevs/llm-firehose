// Package tui renders the live firehose timeline with Bubble Tea.
package tui

import (
	"fmt"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"agentfirehose/internal/event"
	"agentfirehose/internal/store"
)

const (
	maxEvents      = 20000
	coalesceWindow = 2 * time.Second
)

// EventMsg delivers one new event into the model.
type EventMsg struct{ Event event.Event }

// ExportFunc writes events somewhere and returns a description of where.
type ExportFunc func([]event.Event) (string, error)

// Model is the Bubble Tea model for the firehose view.
type Model struct {
	ch       <-chan event.Event
	events   []event.Event
	filter   store.Filter
	catIdx   int
	srcIdx   int
	sources  []string // discovered source families, for cycling
	paused   bool
	frozen   int // len(events) at pause time
	unread   int
	total    int
	cursor   int // -1 = follow bottom
	detail   *event.Event
	search   bool
	buf      string
	compact  bool
	status   string
	width    int
	height   int
	ExportFn ExportFunc
}

var categoryCycle = []event.Category{
	"", event.CategorySession, event.CategoryPrompt, event.CategoryMessage,
	event.CategoryTool, event.CategoryFile, event.CategoryPermission,
	event.CategoryShell, event.CategoryError, event.CategoryMeta,
}

func NewModel(ch <-chan event.Event) Model {
	return Model{ch: ch, cursor: -1, width: 80, height: 24}
}

// Preload seeds the model with historical events (spool replay) so the
// timeline is populated before live events arrive.
func (m Model) Preload(evs []event.Event) Model {
	m.events = append(m.events, evs...)
	m.total += len(evs)
	for _, ev := range evs {
		if !hasSource(m.sources, ev.Source) {
			m.sources = append(m.sources, ev.Source)
		}
	}
	return m
}

// Paused reports whether live scrolling is held.
func (m Model) Paused() bool { return m.paused }

// Filter exposes the active filter (for tests and status display).
func (m Model) Filter() store.Filter { return m.filter }

func (m Model) Init() tea.Cmd { return m.wait() }

func (m Model) wait() tea.Cmd {
	if m.ch == nil {
		return nil
	}
	ch := m.ch
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return nil
		}
		return EventMsg{Event: ev}
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case EventMsg:
		m.events = append(m.events, msg.Event)
		m.total++
		if len(m.events) > maxEvents {
			drop := len(m.events) - maxEvents
			m.events = m.events[drop:]
			if m.frozen > 0 {
				m.frozen = max(0, m.frozen-drop)
			}
		}
		if !hasSource(m.sources, msg.Event.Source) {
			m.sources = append(m.sources, msg.Event.Source)
		}
		if m.paused {
			m.unread++
		}
		return m, m.wait()
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func hasSource(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.search {
		switch msg.Type {
		case tea.KeyEnter:
			m.search = false
			m.filter.Text = m.buf
		case tea.KeyEsc:
			m.search = false
			m.buf = ""
			m.filter.Text = ""
		case tea.KeyBackspace:
			if len(m.buf) > 0 {
				m.buf = m.buf[:len(m.buf)-1]
			}
		case tea.KeyRunes:
			m.buf += string(msg.Runes)
		}
		return m, nil
	}
	if m.detail != nil {
		switch msg.String() {
		case "esc", "q", "enter":
			m.detail = nil
		}
		return m, nil
	}
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case " ":
		if m.paused {
			m.paused = false
			m.frozen = 0
			m.unread = 0
			m.cursor = -1
		} else {
			m.paused = true
			m.frozen = len(m.events)
		}
	case "enter":
		rows := m.visibleRows()
		if len(rows) > 0 {
			i := m.cursor
			if i < 0 || i >= len(rows) {
				i = len(rows) - 1
			}
			ev := rows[i].Event
			m.detail = &ev
		}
	case "up", "k":
		rows := m.visibleRows()
		if m.cursor < 0 {
			m.cursor = len(rows) - 1
		}
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		rows := m.visibleRows()
		if m.cursor >= 0 && m.cursor < len(rows)-1 {
			m.cursor++
		} else {
			m.cursor = -1 // back to follow
		}
	case "f":
		m.catIdx = (m.catIdx + 1) % len(categoryCycle)
		m.filter.Category = categoryCycle[m.catIdx]
	case "a":
		cycle := append([]string{""}, m.sources...)
		m.srcIdx = (m.srcIdx + 1) % len(cycle)
		m.filter.Source = cycle[m.srcIdx]
	case "/":
		m.search = true
		m.buf = ""
	case "t":
		m.compact = !m.compact
	case "e":
		if m.ExportFn != nil {
			evs := m.filteredEvents()
			if dest, err := m.ExportFn(evs); err != nil {
				m.status = "export failed: " + err.Error()
			} else {
				m.status = fmt.Sprintf("exported %d events to %s", len(evs), dest)
			}
		}
	}
	return m, nil
}

func (m Model) filteredEvents() []event.Event {
	evs := m.events
	if m.paused {
		evs = evs[:m.frozen]
	}
	out := make([]event.Event, 0, len(evs))
	for _, ev := range evs {
		if m.filter.Match(ev) {
			out = append(out, ev)
		}
	}
	return out
}

func (m Model) visibleRows() []store.Row {
	return store.Coalesce(m.filteredEvents(), coalesceWindow)
}
