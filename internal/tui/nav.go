package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// maxPlaces caps Back and Forward, the same bound the desktop history uses.
const maxPlaces = 50

// place is where the reader was: enough to come back to the same view with the
// same thing selected. Lists are live, so selections are held by key, with the
// index kept only to find the nearest survivor when the key is gone. The filter
// and lane window are not part of a place: they stay as set across every move.
type place struct {
	alt        altitude
	scope      *cellScope
	wscope     *worktreeScope
	lanes      bool
	feedLanes  bool
	rowKey     string
	rowIdx     int
	cellKey    cellScope
	hasCellKey bool
	cellIdx    int
	wtSel      string
	wtIdx      int
}

func (m Model) here() place {
	p := place{
		alt: m.alt, scope: m.scope, wscope: m.wscope, lanes: m.lanes, feedLanes: m.feedLanes,
		cellKey: m.cellKey, hasCellKey: m.hasCellKey, cellIdx: m.cellIdx,
		wtSel: m.wtSel, wtIdx: m.wtIdx,
	}
	if m.alt == altSession && m.cursor >= 0 {
		if rows := m.visibleRows(); m.cursor < len(rows) {
			p.rowKey, p.rowIdx = rows[m.cursor].Event.ID, m.cursor
		}
	}
	return p
}

// appendPlace never writes into a shared backing array, because Model is
// copied by value, and drops the oldest entry past the cap.
func appendPlace(list []place, p place) []place {
	out := append(list[:len(list):len(list)], p)
	if len(out) > maxPlaces {
		out = out[len(out)-maxPlaces:]
	}
	return out
}

// pushPlace records the current place before a move. A new move ends any
// forward path.
func (m *Model) pushPlace() {
	m.back = appendPlace(m.back, m.here())
	m.forward = nil
}

func (m *Model) restore(p place) {
	m.alt, m.scope, m.wscope, m.lanes, m.feedLanes = p.alt, p.scope, p.wscope, p.lanes, p.feedLanes
	m.cellKey, m.hasCellKey, m.cellIdx = p.cellKey, p.hasCellKey, p.cellIdx
	m.cursor = -1
	if p.rowKey != "" {
		rows := m.visibleRows()
		for i, r := range rows {
			if r.Event.ID == p.rowKey {
				m.cursor = i
				break
			}
		}
		if m.cursor < 0 && len(rows) > 0 {
			m.cursor = min(p.rowIdx, len(rows)-1)
		}
	}
	if p.alt == altWorktree {
		m.wtSel, m.wtIdx = p.wtSel, p.wtIdx
		found := false
		for i, r := range m.worktrees {
			if wtKey(r) == p.wtSel {
				m.wtIdx, found = i, true
				break
			}
		}
		m.wtLost = p.wtSel != "" && !found && len(m.worktrees) > 0
		m.syncWorktreeSelection()
	}
}

// enterScope opens the session view for a scope the caller is about to set.
// A scoped view reads as lanes; the reader's own choice for the whole feed is
// kept so leaving the scope puts it back.
func (m *Model) enterScope() {
	if m.scope == nil && m.wscope == nil {
		m.feedLanes = m.lanes
	}
	m.alt, m.lanes, m.cursor = altSession, true, -1
}

func (m *Model) leaveScope() {
	if m.scope != nil || m.wscope != nil {
		m.lanes = m.feedLanes
	}
	m.scope, m.wscope = nil, nil
}

// selectedCellIndex resolves the workspace selection by key, because the matrix
// reorders as sessions become active. A cell that is gone falls to the nearest.
func (m Model) selectedCellIndex(cells []matrixCell) int {
	if m.hasCellKey {
		for i, c := range cells {
			if c.Where == m.cellKey.Where && c.Agent == m.cellKey.Agent {
				return i
			}
		}
	}
	return max(min(m.cellIdx, len(cells)-1), 0)
}

func (m *Model) selectCell(cells []matrixCell, i int) {
	if len(cells) == 0 {
		m.cellIdx, m.hasCellKey = 0, false
		return
	}
	i = max(min(i, len(cells)-1), 0)
	m.cellIdx, m.cellKey, m.hasCellKey = i, cellScope{Where: cells[i].Where, Agent: cells[i].Agent}, true
}

// handlePlaceKey runs the moves that work the same from every altitude.
func (m Model) handlePlaceKey(k string) (Model, bool) {
	switch k {
	case "[":
		if len(m.back) == 0 {
			m.navNote = "nothing to go back to"
			return m, true
		}
		p := m.back[len(m.back)-1]
		m.forward = appendPlace(m.forward, m.here())
		m.back = m.back[:len(m.back)-1]
		m.wtLost = false
		m.restore(p)
	case "]":
		if len(m.forward) == 0 {
			m.navNote = "nothing to go forward to"
			return m, true
		}
		p := m.forward[len(m.forward)-1]
		m.back = appendPlace(m.back, m.here())
		m.forward = m.forward[:len(m.forward)-1]
		m.wtLost = false
		m.restore(p)
	case "g":
		if m.alt == altSession && m.scope == nil && m.wscope == nil {
			return m, true
		}
		m.pushPlace()
		m.leaveScope()
		m.alt, m.cursor = altSession, -1
	case "n":
		return m.jumpNeedsYou(), true
	default:
		return m, false
	}
	return m, true
}

// jumpNeedsYou opens the cell of the session waiting longest; pressed again it
// moves to the next cell with someone waiting.
func (m Model) jumpNeedsYou() Model {
	all := m
	all.scope, all.wscope = nil, nil
	var cells []cellScope
	seen := map[cellScope]bool{}
	for _, s := range all.liveSessions(m.now()) {
		if s.State != stateNeedsInput {
			continue
		}
		if c := (cellScope{Where: s.Where, Agent: s.Label}); !seen[c] {
			seen[c] = true
			cells = append(cells, c)
		}
	}
	if len(cells) == 0 {
		m.navNote = "nothing needs you"
		return m
	}
	next := cells[0]
	if m.alt == altSession && m.scope != nil {
		for i, c := range cells {
			if c == *m.scope {
				next = cells[(i+1)%len(cells)]
				break
			}
		}
		if next == *m.scope {
			m.navNote = "this is the only session waiting"
			return m
		}
	}
	m.pushPlace()
	m.enterScope()
	m.scope, m.wscope = &next, nil
	m.cellKey, m.hasCellKey = next, true
	return m
}

// hintLine is the footer's one grammar: help, what needs you, the moves of this
// view including where Esc goes, the history that exists, then view details.
func (m Model) hintLine(moves []string, details ...string) string {
	parts := []string{"? help"}
	if m.needsYouCount() > 0 {
		parts = append(parts, "n needs you")
	}
	parts = append(parts, moves...)
	if len(m.back) > 0 {
		parts = append(parts, "[ back")
	}
	if len(m.forward) > 0 {
		parts = append(parts, "] forward")
	}
	return strings.Join(append(parts, details...), " · ")
}

// feedHint is the session view's footer.
func (m Model) feedHint() string {
	esc := "esc workspace"
	switch {
	case m.cursor >= 0:
		esc = "esc follow live"
	case m.wscope != nil:
		esc = "esc worktrees"
	}
	strip := "l lanes"
	if m.lanes {
		strip = "l band"
	}
	return m.hintLine([]string{esc}, strip)
}

// footerWith puts a transient note or status ahead of the hints, inside the
// terminal width.
func (m Model) footerWith(help string) string {
	note := m.navNote
	if note == "" {
		note = m.status
	}
	if note == "" {
		return dimStyle.Render(fit(help, m.width))
	}
	note = fit(note, m.width)
	rest := fit(help, m.width-lipgloss.Width(note)-2)
	if rest == "" {
		return note
	}
	return note + "  " + dimStyle.Render(rest)
}
