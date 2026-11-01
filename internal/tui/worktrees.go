package tui

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"agentfirehose/internal/event"
)

// worktreeRefreshEvery is how often the worktree altitude re-fetches while it
// is the visible rung.
const worktreeRefreshEvery = 10 * time.Second

// worktreeFetchTimeout bounds one fetch so a stuck source cannot pin the
// in-flight flag forever.
const worktreeFetchTimeout = 5 * time.Second

// ErrWorktreesUnavailable means the source cannot provide worktrees at all
// (for example a daemon that predates the route). It is not retried.
var ErrWorktreesUnavailable = errors.New("tui: worktrees unavailable")

// SessionRef names a session across sources: session IDs are only unique
// within one source.
type SessionRef struct{ Source, ID string }

// WorktreeRow is one worktree lifetime as the list altitude shows it. The
// pointer fields are nil when the source could not observe them.
type WorktreeRow struct {
	ID, Repo, Path, State string
	Last                  time.Time
	LastObserved          *time.Time
	Sessions              []SessionRef
	SessionsTotal         int
	Ahead, Behind         *int
	Dirty                 *bool
}

// WorktreeList is one fetch result. StateKnown is false when the source did
// not classify worktrees (no ahead/behind/landed knowledge).
type WorktreeList struct {
	Rows       []WorktreeRow
	StateKnown bool
}

// WorktreeSource supplies worktree lifetimes; the TUI never classifies them.
type WorktreeSource interface {
	Worktrees(ctx context.Context) (WorktreeList, error)
}

// WorktreesMsg delivers a finished fetch into the model.
type WorktreesMsg struct {
	List WorktreeList
	Err  error
}

// WithWorktrees installs the source behind the `w` key.
func (m Model) WithWorktrees(src WorktreeSource) Model {
	m.wsrc = src
	return m
}

// worktreeScope narrows the session altitude to one worktree. Rows holds only
// the sessions the list row named. Seen retains every pair positively observed
// in the worktree for the scope's lifetime (loaded at descent, admitted since,
// or named by a refreshed row), so a session whose events leave the ring stays
// in scope. Like Model.attention, Seen is shared by model copies.
type worktreeScope struct {
	Key, Repo, ID, Label string
	Rows                 map[SessionRef]bool
	Seen                 map[SessionRef]bool
}

func wtKey(r WorktreeRow) string { return r.Repo + "\x00" + r.ID }

func (w *worktreeScope) holds(ev event.Event) bool {
	return w.ID != "" && ev.WorktreeID == w.ID && ev.RepoID == w.Repo
}

// noteWorktreeScope retains an admitted event's pair when it is positively
// observed in the scoped worktree.
func (m Model) noteWorktreeScope(ev event.Event) {
	if m.wscope == nil || isTransition(ev) || ev.SessionID == "" || !m.wscope.holds(ev) {
		return
	}
	m.wscope.Seen[SessionRef{ev.Source, ev.SessionID}] = true
}

// wscopeMembers is the set of (source, session) pairs in the worktree scope:
// the listed and retained pairs plus every loaded non-transition event's pair
// whose RepoID+WorktreeID match.
func (m Model) wscopeMembers() map[SessionRef]bool {
	if m.wscope == nil {
		return nil
	}
	members := make(map[SessionRef]bool, len(m.wscope.Rows)+len(m.wscope.Seen))
	for ref := range m.wscope.Rows {
		members[ref] = true
	}
	for ref := range m.wscope.Seen {
		members[ref] = true
	}
	for _, ev := range m.events {
		if isTransition(ev) || ev.SessionID == "" {
			continue
		}
		if m.wscope.holds(ev) {
			members[SessionRef{ev.Source, ev.SessionID}] = true
		}
	}
	return members
}

// wscopeIndex is the per-call lookup the filters share: the membership and,
// for each session ID, the distinct (source, id) pairs known (loaded events,
// every fetched worktree row, identified attention entries), which decides
// whether a source-less transition is ambiguous.
type wscopeIndex struct {
	members map[SessionRef]bool
	byID    map[string]map[SessionRef]bool
}

func (m Model) wscopeIndex() *wscopeIndex {
	if m.wscope == nil {
		return nil
	}
	ix := &wscopeIndex{members: m.wscopeMembers(), byID: map[string]map[SessionRef]bool{}}
	add := func(ref SessionRef) {
		if ix.byID[ref.ID] == nil {
			ix.byID[ref.ID] = map[SessionRef]bool{}
		}
		ix.byID[ref.ID][ref] = true
	}
	for ref := range ix.members {
		add(ref)
	}
	for _, ev := range m.events {
		if ev.SessionID != "" && !isTransition(ev) {
			add(SessionRef{ev.Source, ev.SessionID})
		}
	}
	for _, r := range m.worktrees {
		for _, ref := range r.Sessions {
			add(ref)
		}
	}
	for id, a := range m.attention {
		if a.Source != "" {
			add(SessionRef{a.Source, id})
		}
	}
	return ix
}

// has reports whether an event is in the worktree scope. A transition carries
// no source, so it is in scope only when its session ID names exactly one
// known pair and that pair is a member.
func (ix *wscopeIndex) has(w *worktreeScope, ev event.Event) bool {
	if isTransition(ev) {
		return ix.sessionIDMember(ev.SessionID)
	}
	if ev.SessionID == "" {
		return w.holds(ev)
	}
	return ix.members[SessionRef{ev.Source, ev.SessionID}]
}

func (ix *wscopeIndex) sessionIDMember(id string) bool {
	pairs := ix.byID[id]
	if len(pairs) != 1 {
		return false
	}
	for ref := range pairs {
		return ix.members[ref]
	}
	return false
}

// hasAttention applies the same rule to an engine attention entry.
func (ix *wscopeIndex) hasAttention(id string, a attention) bool {
	if a.Source != "" {
		return ix.members[SessionRef{a.Source, id}]
	}
	return ix.sessionIDMember(id)
}

// fetchWorktrees runs the source outside Update, bounded by a timeout.
func fetchWorktrees(src WorktreeSource) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), worktreeFetchTimeout)
		defer cancel()
		list, err := src.Worktrees(ctx)
		return WorktreesMsg{List: list, Err: err}
	}
}

// sortWorktreeRows orders rows stably by repo, then path, then ID; never by
// recency, so the list does not reshuffle under the cursor.
func sortWorktreeRows(rows []WorktreeRow) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if la, lb := workspaceLabel("", a.Repo), workspaceLabel("", b.Repo); la != lb {
			return la < lb
		}
		if la, lb := workspaceLabel("", a.Path), workspaceLabel("", b.Path); la != lb {
			return la < lb
		}
		if a.Repo != b.Repo {
			return a.Repo < b.Repo
		}
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return a.ID < b.ID
	})
}

// shouldRefreshWorktrees says whether a tick should start a fetch. Age counts
// from the last successful fetch, so failures retry on the next tick window.
func (m Model) shouldRefreshWorktrees(now time.Time) bool {
	if m.alt != altWorktree || m.wsrc == nil || m.wtInflight || m.wtUnavailable {
		return false
	}
	return m.wtFetchedAt.IsZero() || now.Sub(m.wtFetchedAt) >= worktreeRefreshEvery
}

func (m Model) enterWorktrees() (tea.Model, tea.Cmd) {
	if m.wsrc == nil {
		m.status = "worktrees: no source available"
		return m, nil
	}
	m.alt, m.scope, m.wscope = altWorktree, nil, nil
	m.wtUnavailable, m.wtErr = false, nil
	if m.wtInflight {
		return m, nil
	}
	m.wtInflight = true
	return m, fetchWorktrees(m.wsrc)
}

func (m Model) applyWorktrees(msg WorktreesMsg) Model {
	m.wtInflight = false
	switch {
	case errors.Is(msg.Err, ErrWorktreesUnavailable):
		m.wtUnavailable, m.wtErr = true, nil
		m.worktrees, m.wtKnown = nil, false
	case msg.Err != nil:
		m.wtErr = msg.Err
	default:
		m.wtUnavailable, m.wtErr = false, nil
		m.wtFetchedAt = m.now()
		rows := append([]WorktreeRow(nil), msg.List.Rows...)
		sortWorktreeRows(rows)
		m.worktrees, m.wtKnown = rows, msg.List.StateKnown
		found := false
		for i, r := range rows {
			if wtKey(r) == m.wtSel {
				m.wtIdx, found = i, true
				break
			}
		}
		if r, ok := m.scopedWorktreeRow(); ok {
			for _, ref := range r.Sessions {
				m.wscope.Seen[ref] = true
			}
		}
		if m.wtSel != "" && !found {
			m.wtLost = true
		}
	}
	m.syncWorktreeSelection()
	return m
}

// wtListHeight is how many rows fit: the header, column heading and footer
// take the rest.
func (m Model) wtListHeight() int { return max(1, m.height-4) }

// syncWorktreeSelection clamps the cursor, remembers its key, and scrolls the
// window minimally so the selection stays visible.
func (m *Model) syncWorktreeSelection() {
	n := len(m.worktrees)
	if n == 0 {
		m.wtIdx, m.wtTop, m.wtSel = 0, 0, ""
		return
	}
	m.wtIdx = max(0, min(m.wtIdx, n-1))
	m.wtSel = wtKey(m.worktrees[m.wtIdx])
	h := m.wtListHeight()
	if m.wtIdx < m.wtTop {
		m.wtTop = m.wtIdx
	}
	if m.wtIdx >= m.wtTop+h {
		m.wtTop = m.wtIdx - h + 1
	}
	m.wtTop = max(0, min(m.wtTop, max(n-h, 0)))
}

func (m Model) handleWorktreeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	m.wtLost = false
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "?":
		m.help = true
	case "up", "k", "left", "h":
		m.wtIdx--
		m.syncWorktreeSelection()
	case "down", "j", "right":
		m.wtIdx++
		m.syncWorktreeSelection()
	case "esc":
		m.alt = altWorkspace
	case "enter":
		if len(m.worktrees) == 0 {
			return m, nil
		}
		m.syncWorktreeSelection()
		row := m.worktrees[m.wtIdx]
		rows := make(map[SessionRef]bool, len(row.Sessions))
		for _, s := range row.Sessions {
			rows[s] = true
		}
		m.wscope = &worktreeScope{
			Key: wtKey(row), Repo: row.Repo, ID: row.ID,
			Label: workspaceLabel("", orDefault(row.Path, row.ID)), Rows: rows,
			Seen: map[SessionRef]bool{},
		}
		for _, ev := range m.events {
			m.noteWorktreeScope(ev)
		}
		m.scope = nil
		m.alt, m.lanes, m.cursor = altSession, true, -1
	}
	return m, nil
}

// worktreePathLabel prepares a worktree path for the terminal: short, and
// control-sequence safe.
func worktreePathLabel(p string) string { return workspaceLabel("", p) }

// scopedWorktreeRow finds the list row the current worktree scope came from.
func (m Model) scopedWorktreeRow() (WorktreeRow, bool) {
	if m.wscope == nil {
		return WorktreeRow{}, false
	}
	for _, r := range m.worktrees {
		if wtKey(r) == m.wscope.Key {
			return r, true
		}
	}
	return WorktreeRow{}, false
}

// unloadedWorktreeSessions is how many sessions the scoped worktree row lists
// while no loaded event is in scope. It says nothing about their age. Zero when
// a filter may be hiding them.
func (m Model) unloadedWorktreeSessions() int {
	if m.wscope == nil || m.filterLabel() != "" {
		return 0
	}
	n := len(m.wscope.Rows)
	if r, ok := m.scopedWorktreeRow(); ok {
		n = max(n, len(r.Sessions), r.SessionsTotal)
	}
	return n
}

// heldWorktreeEvents is how many scoped events arrived after a pause froze the
// view, so the empty view can say they are held rather than absent.
func (m Model) heldWorktreeEvents() int {
	if m.wscope == nil || !m.paused || m.frozen >= len(m.events) {
		return 0
	}
	n := 0
	for _, ev := range m.scoped(m.events[m.frozen:]) {
		if m.filter.Match(ev) {
			n++
		}
	}
	return n
}

// worktreeState renders the STATE cell. State is the daemon's classification;
// without it (or when unknown) the cell is an absence, never a guess.
func (m Model) worktreeState(r WorktreeRow) string {
	if !m.wtKnown {
		return "–"
	}
	st := stripControl(r.State)
	if st == "" || st == "unknown" {
		st = "–"
	}
	if r.Ahead != nil && r.Behind != nil {
		st += fmt.Sprintf(" ↑%d ↓%d", *r.Ahead, *r.Behind)
	} else if r.Ahead != nil {
		st += fmt.Sprintf(" ↑%d", *r.Ahead)
	} else if r.Behind != nil {
		st += fmt.Sprintf(" ↓%d", *r.Behind)
	}
	if r.Dirty != nil && *r.Dirty {
		st += "*"
	}
	return st
}

func worktreeSessCell(r WorktreeRow) string {
	cell := fmt.Sprintf("%d", len(r.Sessions))
	if r.SessionsTotal > len(r.Sessions) {
		cell += fmt.Sprintf(" +%d", r.SessionsTotal-len(r.Sessions))
	}
	return cell
}

// worktreeMembers is the row's listed pairs plus every loaded non-transition
// event's pair whose RepoID+WorktreeID match the row.
func (m Model) worktreeMembers(r WorktreeRow) map[SessionRef]bool {
	members := make(map[SessionRef]bool, len(r.Sessions))
	for _, s := range r.Sessions {
		members[s] = true
	}
	for _, ev := range m.events {
		if !isTransition(ev) && ev.SessionID != "" && ev.WorktreeID == r.ID && ev.RepoID == r.Repo {
			members[SessionRef{ev.Source, ev.SessionID}] = true
		}
	}
	return members
}

// worktreeLiveCell counts live sessions (as the band sees them) among the
// members. A capped session list cannot rule out more, so the count is then a
// lower bound and says so.
func worktreeLiveCell(r WorktreeRow, members map[SessionRef]bool, live []sessionInfo) string {
	ids := make(map[string]bool, len(members))
	for s := range members {
		ids[s.ID] = true
	}
	n := 0
	for _, l := range live {
		if (l.Source != "" && members[SessionRef{l.Source, l.ID}]) || (l.Source == "" && ids[l.ID]) {
			n++
		}
	}
	if r.SessionsTotal > len(r.Sessions) {
		return fmt.Sprintf("≥%d", n)
	}
	return fmt.Sprintf("%d", n)
}

// viewWorktrees renders the list altitude: a title line, the column heading,
// then only the visible window of rows.
func (m Model) viewWorktrees(now time.Time) []string {
	n := len(m.worktrees)
	title := fmt.Sprintf("WORKTREES · %d", n)
	end := min(n, m.wtTop+m.wtListHeight())
	if n > 0 && (m.wtTop > 0 || end < n) {
		title += fmt.Sprintf(" · %d/%d", m.wtIdx+1, n)
		if end < n {
			title += fmt.Sprintf(" · %d more", n-end)
		}
	}
	if m.wtErr != nil {
		title += "  ! refresh failed: " + sanitizeNeedsYouReason(m.wtErr.Error())
	}
	lines := []string{dimStyle.Render(fit(title, m.width))}
	switch {
	case m.wtUnavailable:
		return append(lines, dimStyle.Render("  worktrees are not available from this daemon"))
	case n == 0 && m.wtFetchedAt.IsZero() && m.wtErr == nil:
		return append(lines, dimStyle.Render("  loading worktrees…"))
	case n == 0:
		return append(lines, dimStyle.Render("  no worktrees captured yet"))
	}
	plainM := m
	plainM.wscope = nil
	live := plainM.liveSessions(now)

	type cells struct{ repo, path, sess, live, last, state string }
	vis := make([]cells, 0, end-m.wtTop)
	rw, pw, sw, tw := len("REPO"), len("PATH"), len("SESS"), len("STATE")
	for i := m.wtTop; i < end; i++ {
		r := m.worktrees[i]
		c := cells{
			repo:  workspaceLabel("", r.Repo),
			path:  worktreePathLabel(orDefault(r.Path, r.ID)),
			sess:  worktreeSessCell(r),
			live:  worktreeLiveCell(r, m.worktreeMembers(r), live),
			last:  formatAge(max(now.Sub(r.Last), 0)),
			state: m.worktreeState(r),
		}
		vis = append(vis, c)
		rw, pw = max(rw, lipglossWidth(c.repo)), max(pw, lipglossWidth(c.path))
		sw, tw = max(sw, lipglossWidth(c.sess)), max(tw, lipglossWidth(c.state))
	}
	const branchW, liveW, lastW = len("BRANCH"), len("LIVE"), len("LAST")
	tw = min(tw, 24)
	// prefix "▸ " (2) and six two-space gaps (12).
	budget := m.width - (2 + 12 + branchW + sw + liveW + lastW + tw)
	for rw+pw > budget && (rw > 4 || pw > 4) {
		if rw >= pw && rw > 4 {
			rw--
		} else if pw > 4 {
			pw--
		} else {
			rw--
		}
	}
	row := func(prefix, repo, path, branch, sess, live, last, state string) string {
		return prefix + strings.Join([]string{
			padRight(fit(repo, rw), rw), padRight(fit(path, pw), pw), padRight(branch, branchW),
			padLeft(sess, sw), padLeft(live, liveW), padLeft(last, lastW), fit(state, tw),
		}, "  ")
	}
	lines = append(lines, dimStyle.Render(fit(row("  ", "REPO", "PATH", "BRANCH", "SESS", "LIVE", "LAST", "STATE"), m.width)))
	for k, c := range vis {
		prefix := "  "
		selected := m.wtTop+k == m.wtIdx
		if selected {
			prefix = "▸ "
		}
		// BRANCH is always absent: the daemon's worktree view carries no
		// branch (D107), so the column is reserved and shows – rather than a guess.
		line := fit(row(prefix, c.repo, c.path, "–", c.sess, c.live, c.last, c.state), m.width)
		if selected {
			line = selStyle.Render(line)
		}
		lines = append(lines, line)
	}
	return lines
}

func lipglossWidth(s string) int { return lipgloss.Width(s) }

// worktreeFooter is the list altitude's hint line plus what the reader needs
// to know about the freshness and provenance of what they see.
func (m Model) worktreeFooter() string {
	now := m.now()
	parts := []string{"? help", "↑↓ pick", "enter open", "esc back"}
	if m.wtLost {
		parts = append([]string{"selected worktree no longer listed"}, parts...)
	}
	if !m.wtFetchedAt.IsZero() {
		parts = append(parts, "fetched "+formatAge(max(now.Sub(m.wtFetchedAt), 0))+" ago")
		// The selected row's own observation; a local view never observes,
		// and its "state needs the daemon" note already says so.
		if m.wtIdx < len(m.worktrees) {
			if o := m.worktrees[m.wtIdx].LastObserved; o != nil {
				parts = append(parts, "observed "+formatAge(max(now.Sub(*o), 0))+" ago")
			} else if m.wtKnown {
				parts = append(parts, "observed unknown")
			}
		}
		if !m.wtKnown && len(m.worktrees) > 0 {
			parts = append(parts, "state needs the daemon", "local view, may lag the writer")
		}
	}
	return fit(strings.Join(parts, " · "), m.width)
}
