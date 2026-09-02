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
	maxEvents       = 20000
	coalesceWindow  = 5 * time.Second
	stateNeedsInput = "needs_input"
)

// EventMsg delivers one new event into the model.
type EventMsg struct{ Event event.Event }

// ExportFunc writes events somewhere and returns a description of where.
type ExportFunc func([]event.Event) (string, error)

// SessionAttention is the engine-owned Projection state needed by the view.
type SessionAttention struct {
	ID     string
	Source string
	Agent  string
	Repo   string
	CWD    string
	State  string
	Since  time.Time
	Reason string
}

type attention struct {
	State  string
	Since  time.Time
	Reason string
	Source string
	Agent  string
	Where  string
}

// altitude is the reading distance: the workspace matrix, or the session
// strip over event rows. The call altitude is a selected event (detail).
type altitude int

const (
	altSession altitude = iota
	altWorkspace
)

// cellScope narrows the session altitude to one workspace × agent cell.
type cellScope struct{ Where, Agent string }

func (c cellScope) has(s sessionInfo) bool {
	return s.Where == c.Where && s.Label == c.Agent
}

// holds reports whether an event itself is in the cell. Sessions are also
// members through any one of their events; see Model.scoped.
func (c cellScope) holds(ev event.Event) bool {
	return !isTransition(ev) && workspaceKey(ev.Repo, ev.CWD) == c.Where &&
		agentLabel(ev.Agent, ev.Source) == c.Agent
}

// tickMsg redraws once a second so ages, sparklines, and the lane axis move
// even when no event arrives.
type tickMsg time.Time

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

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
	// attention mirrors engine-owned session state: the NEEDS YOU indicator,
	// the band's state column, and lane labels all read from it.
	attention map[string]attention
	help      bool
	lanes     bool // the strip over the rows is lanes rather than the band
	laneIdx   int  // index into laneWindows
	alt       altitude
	scope     *cellScope
	cellIdx   int // selected cell at the workspace altitude, reading order
	now       func() time.Time
}

var categoryCycle = []event.Category{
	"", event.CategorySession, event.CategoryPrompt, event.CategoryMessage,
	event.CategoryTool, event.CategoryFile, event.CategoryPermission,
	event.CategoryShell, event.CategoryError, event.CategoryMeta,
}

func NewModel(ch <-chan event.Event) Model {
	return Model{
		ch: ch, cursor: -1, width: 80, height: 24, attention: map[string]attention{},
		laneIdx: 1, now: time.Now,
	}
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

// PreloadSessions seeds attention from the Capture Engine Projection. Durable
// history is presentation data and is not folded a second time by the view.
func (m Model) PreloadSessions(sessions []SessionAttention) Model {
	if m.attention == nil {
		m.attention = map[string]attention{}
	}
	for _, session := range sessions {
		if session.ID == "" || session.State == "" || session.State == stateDone {
			continue
		}
		m.attention[session.ID] = attention{
			State: session.State, Since: session.Since, Reason: session.Reason,
			Source: session.Source, Agent: session.Agent, Where: workspaceKey(session.Repo, session.CWD),
		}
	}
	m.boundAttention()
	return m
}

// Paused reports whether live scrolling is held.
func (m Model) Paused() bool { return m.paused }

// Filter exposes the active filter (for tests and status display).
func (m Model) Filter() store.Filter { return m.filter }

func (m Model) Init() tea.Cmd { return tea.Batch(m.wait(), tick()) }

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
		m.noteAttention(msg.Event)
		if isReconciledTransition(msg.Event) {
			return m, m.wait()
		}
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
	case tickMsg:
		return m, tick()
	}
	return m, nil
}

func isReconciledTransition(ev event.Event) bool {
	if ev.Source != "firehose" || ev.Name != "state.transition" {
		return false
	}
	reconciled, _ := ev.Payload["reconciled"].(bool)
	return reconciled
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
		case "esc", "q":
			m.detail = nil
		}
		return m, nil
	}
	if m.help {
		switch msg.String() {
		case "esc", "q", "enter", "?":
			m.help = false
		}
		return m, nil
	}
	if m.alt == altWorkspace {
		return m.handleWorkspaceKey(msg)
	}
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "esc":
		// Ascend: the workspace shows everything, with the cursor left on
		// the cell we came from.
		m.alt, m.scope, m.cursor = altWorkspace, nil, -1
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
	case "?":
		m.help = true
	case "l":
		m.lanes = !m.lanes
	case "-":
		m.laneIdx = max(m.laneIdx-1, 0)
	case "+", "=":
		m.laneIdx = min(m.laneIdx+1, len(laneWindows)-1)
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

// handleWorkspaceKey moves between occupied cells in reading order; enter
// descends into the selected cell with the strip switched to lanes, which is
// how a session reads at that altitude.
func (m Model) handleWorkspaceKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "?":
		m.help = true
	case "up", "k", "left", "h":
		m.cellIdx = max(m.cellIdx-1, 0)
	case "down", "j", "right":
		n := len(buildMatrix(m.liveSessions(m.now())).Cells)
		m.cellIdx = min(m.cellIdx+1, max(n-1, 0))
	case "enter":
		cells := buildMatrix(m.liveSessions(m.now())).Cells
		if len(cells) == 0 {
			return m, nil
		}
		m.cellIdx = min(m.cellIdx, len(cells)-1)
		c := cells[m.cellIdx]
		m.scope = &cellScope{Where: c.Where, Agent: c.Agent}
		m.alt, m.lanes, m.cursor = altSession, true, -1
	}
	return m, nil
}

func (m Model) filteredEvents() []event.Event {
	evs := m.events
	if m.paused {
		evs = evs[:m.frozen]
	}
	evs = m.scoped(evs)
	out := make([]event.Event, 0, len(evs))
	for _, ev := range evs {
		if m.filter.Match(ev) {
			out = append(out, ev)
		}
	}
	return out
}

// scoped keeps the events of the sessions in the scope cell. A session is a
// member through its engine attention or through any one of its events, so
// transitions and events without a workspace stay with their session.
func (m Model) scoped(evs []event.Event) []event.Event {
	if m.scope == nil {
		return evs
	}
	in := map[string]bool{}
	for id, a := range m.attention {
		if a.Where == m.scope.Where && agentLabel(a.Agent, a.Source) == m.scope.Agent {
			in[id] = true
		}
	}
	for _, ev := range evs {
		if ev.SessionID != "" && m.scope.holds(ev) {
			in[ev.SessionID] = true
		}
	}
	out := make([]event.Event, 0, len(evs))
	for _, ev := range evs {
		if m.scope.holds(ev) || (ev.SessionID != "" && in[ev.SessionID]) {
			out = append(out, ev)
		}
	}
	return out
}

func (m Model) visibleRows() []store.Row {
	return store.Coalesce(m.filteredEvents(), coalesceWindow)
}

// noteAttention applies engine-owned, live-only Projection transitions.
func (m Model) noteAttention(ev event.Event) {
	if ev.SessionID == "" || m.attention == nil || !isTransition(ev) {
		return
	}
	state, _ := ev.Payload["state"].(string)
	if state == "" || state == stateDone {
		delete(m.attention, ev.SessionID)
		return
	}
	reason, _ := ev.Payload["reason"].(string)
	if reason == "" && state == stateNeedsInput {
		reason = ev.Summary
	}
	prev := m.attention[ev.SessionID]
	m.attention[ev.SessionID] = attention{
		State: state, Since: ev.Time, Reason: reason,
		Source: prev.Source, Agent: prev.Agent, Where: prev.Where,
	}
	m.boundAttention()
}

// boundAttention evicts the stalest routine entries past attentionCap.
// Sessions that need you are never evicted.
func (m Model) boundAttention() {
	for len(m.attention) > attentionCap {
		victim, found := "", false
		var oldest time.Time
		for id, a := range m.attention {
			if a.State == stateNeedsInput {
				continue
			}
			if !found || a.Since.Before(oldest) {
				victim, oldest, found = id, a.Since, true
			}
		}
		if !found {
			return
		}
		delete(m.attention, victim)
	}
}

func (m Model) needsYouCount() int {
	n := 0
	for _, a := range m.attention {
		if a.State == stateNeedsInput {
			n++
		}
	}
	return n
}

func (m Model) oldestNeedsYouReason() string {
	var best attention
	found := false
	for _, a := range m.attention {
		if a.State != stateNeedsInput {
			continue
		}
		if !found || a.Since.Before(best.Since) {
			best = a
			found = true
		}
	}
	if !found {
		return ""
	}
	return best.Reason
}
