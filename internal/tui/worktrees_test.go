package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"agentfirehose/internal/event"
)

type fakeSource struct {
	list  WorktreeList
	err   error
	calls int
	block chan struct{}
}

func (f *fakeSource) Worktrees(ctx context.Context) (WorktreeList, error) {
	f.calls++
	if f.block != nil {
		select {
		case <-f.block:
		case <-time.After(2 * time.Second):
		}
	}
	return f.list, f.err
}

func keyCmd(m Model, k string) (Model, tea.Cmd) {
	var msg tea.KeyMsg
	switch k {
	case "enter":
		msg = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		msg = tea.KeyMsg{Type: tea.KeyEsc}
	case "up":
		msg = tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		msg = tea.KeyMsg{Type: tea.KeyDown}
	case "left":
		msg = tea.KeyMsg{Type: tea.KeyLeft}
	case "right":
		msg = tea.KeyMsg{Type: tea.KeyRight}
	case "ctrl+c":
		msg = tea.KeyMsg{Type: tea.KeyCtrlC}
	default:
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
	}
	mm, cmd := m.Update(msg)
	return mm.(Model), cmd
}

func wtModel(src WorktreeSource) Model {
	m := newTestModel()
	m.now = func() time.Time { return t0 }
	if src != nil {
		m = m.WithWorktrees(src)
	}
	return m
}

func row(repo, id, path string, sessions ...SessionRef) WorktreeRow {
	return WorktreeRow{ID: id, Repo: repo, Path: path, State: "active", Last: t0, Sessions: sessions, SessionsTotal: len(sessions)}
}

func withWorktrees(m Model, rows ...WorktreeRow) Model {
	mm, _ := m.Update(WorktreesMsg{List: WorktreeList{Rows: rows, StateKnown: true}})
	return mm.(Model)
}

func wev(i int, source, session, repo, wt string) event.Event {
	ev := mkEv(i, event.CategoryTool, fmt.Sprintf("e%d-%s-%s", i, source, session))
	ev.Source, ev.SessionID, ev.RepoID, ev.WorktreeID = source, session, repo, wt
	return ev
}

func ids(evs []event.Event) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.ID)
	}
	return out
}

func sessionIDs(m Model) map[string]bool {
	out := map[string]bool{}
	for _, s := range m.liveSessions(t0.Add(30 * time.Second)) {
		out[s.ID] = true
	}
	return out
}

func TestWKeyEntersWorktreeAltitudeAndFetches(t *testing.T) {
	src := &fakeSource{list: WorktreeList{Rows: []WorktreeRow{row("/r/.git", "/r", "/r")}, StateKnown: true}}
	m := wtModel(src)
	m, cmd := keyCmd(m, "w")
	if m.alt != altWorktree || !m.wtInflight || cmd == nil {
		t.Fatalf("alt=%v inflight=%v cmd=%v", m.alt, m.wtInflight, cmd)
	}
	msg := cmd()
	mm, _ := m.Update(msg)
	m = mm.(Model)
	if m.wtInflight || len(m.worktrees) != 1 || !m.wtKnown || !m.wtFetchedAt.Equal(t0) {
		t.Fatalf("after fetch: %+v", m)
	}
}

func TestWKeyWithoutSourceSetsStatus(t *testing.T) {
	m := wtModel(nil)
	m, cmd := keyCmd(m, "w")
	if m.alt != altSession || cmd != nil || !strings.Contains(m.status, "worktrees") {
		t.Fatalf("alt=%v status=%q", m.alt, m.status)
	}
}

func TestWKeyFromWorkspaceAltitude(t *testing.T) {
	m := wtModel(&fakeSource{})
	m, _ = keyCmd(m, "esc")
	if m.alt != altWorkspace {
		t.Fatal("setup")
	}
	m, _ = keyCmd(m, "w")
	if m.alt != altWorktree {
		t.Fatalf("alt=%v", m.alt)
	}
	m, _ = keyCmd(m, "?")
	if !m.help {
		t.Fatal("? should open help")
	}
	m, _ = keyCmd(m, "?")
	_, cmd := keyCmd(m, "q")
	if cmd == nil || cmd() != tea.Quit() {
		t.Fatal("q should quit")
	}
}

func TestWKeyWhileInflightDoesNotDoubleFetch(t *testing.T) {
	src := &fakeSource{}
	m := wtModel(src)
	m, c1 := keyCmd(m, "w")
	m, _ = keyCmd(m, "esc")
	m, c2 := keyCmd(m, "w")
	if c1 == nil || c2 != nil || !m.wtInflight {
		t.Fatalf("c1=%v c2=%v inflight=%v", c1 != nil, c2 != nil, m.wtInflight)
	}
}

func TestReenterResetsUnavailable(t *testing.T) {
	m := wtModel(&fakeSource{})
	m, _ = keyCmd(m, "w")
	mm, _ := m.Update(WorktreesMsg{Err: ErrWorktreesUnavailable})
	m = mm.(Model)
	if !m.wtUnavailable {
		t.Fatal("setup")
	}
	m, _ = keyCmd(m, "esc")
	m, cmd := keyCmd(m, "w")
	if m.wtUnavailable || m.wtErr != nil || cmd == nil {
		t.Fatalf("unavailable=%v err=%v", m.wtUnavailable, m.wtErr)
	}
}

func TestWorktreeRowsAreStableOrderedByRepoThenPath(t *testing.T) {
	m := withWorktrees(wtModel(&fakeSource{}),
		row("/b/.git", "z", "/b/z"), row("/a/.git", "y", "/a/y"), row("/a/.git", "x", "/a/x"))
	var got []string
	for _, r := range m.worktrees {
		got = append(got, r.ID)
	}
	if strings.Join(got, ",") != "x,y,z" {
		t.Fatalf("order=%v", got)
	}
	// Recency must not reorder.
	later := row("/b/.git", "z", "/b/z")
	later.Last = t0.Add(time.Hour)
	m = withWorktrees(m, later, row("/a/.git", "y", "/a/y"), row("/a/.git", "x", "/a/x"))
	if m.worktrees[2].ID != "z" {
		t.Fatalf("reordered by recency: %v", m.worktrees)
	}
}

func TestWorktreeSelectionFollowsKeyAcrossRefresh(t *testing.T) {
	m := withWorktrees(wtModel(&fakeSource{}), row("/a/.git", "a", "/a"), row("/b/.git", "b", "/b"))
	m.alt = altWorktree
	m, _ = keyCmd(m, "down")
	if m.worktrees[m.wtIdx].ID != "b" {
		t.Fatal("setup")
	}
	m = withWorktrees(m, row("/0/.git", "n", "/0"), row("/a/.git", "a", "/a"), row("/b/.git", "b", "/b"))
	if m.worktrees[m.wtIdx].ID != "b" {
		t.Fatalf("selection moved to %v", m.worktrees[m.wtIdx].ID)
	}
	// Selected row vanishes: clamped, selection key re-synced.
	m = withWorktrees(m, row("/0/.git", "n", "/0"))
	if m.wtIdx != 0 || m.wtSel != wtKey(m.worktrees[0]) {
		t.Fatalf("idx=%d sel=%q", m.wtIdx, m.wtSel)
	}
}

func TestVanishedSelectionIsSignalled(t *testing.T) {
	m := withWorktrees(wtModel(&fakeSource{}), row("/a/.git", "a", "/a"), row("/b/.git", "b", "/b"), row("/c/.git", "c", "/c"))
	m.alt = altWorktree
	m.width = 200
	m, _ = keyCmd(m, "down")
	m = withWorktrees(m, row("/a/.git", "a", "/a"), row("/c/.git", "c", "/c"))
	if !strings.Contains(m.worktreeFooter(), "selected worktree no longer listed") {
		t.Fatalf("no notice: %q", m.worktreeFooter())
	}
	// A refresh that keeps the selection raises no notice.
	m, _ = keyCmd(m, "down")
	m = withWorktrees(m, row("/a/.git", "a", "/a"), row("/c/.git", "c", "/c"))
	if strings.Contains(m.worktreeFooter(), "no longer listed") {
		t.Fatalf("spurious notice: %q", m.worktreeFooter())
	}
}

func TestDuplicateWorktreeIDDifferentRepo(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "s1", "/r1/.git", "/wt"))
	m = push(m, wev(2, "claude-code", "s2", "/r2/.git", "/wt"))
	m = withWorktrees(m, row("/r2/.git", "/wt", "/p2"), row("/r1/.git", "/wt", "/p1"))
	m.alt = altWorktree
	if m.worktrees[0].Repo != "/r1/.git" {
		t.Fatalf("tie-break order: %v", m.worktrees)
	}
	m, _ = keyCmd(m, "down") // r2
	m, _ = keyCmd(m, "enter")
	got := ids(m.filteredEvents())
	if len(got) != 1 || got[0] != "e2" {
		t.Fatalf("scoped to r2 only, got %v", got)
	}
}

func TestWorktreeCursorKeysClampAndMove(t *testing.T) {
	m := wtModel(&fakeSource{})
	m.alt = altWorktree
	m, _ = keyCmd(m, "enter") // zero rows: no-op
	if m.alt != altWorktree || m.wscope != nil {
		t.Fatal("enter with no rows must be a no-op")
	}
	m = withWorktrees(m, row("/a/.git", "a", "/a"), row("/b/.git", "b", "/b"), row("/c/.git", "c", "/c"))
	for _, k := range []string{"up", "k", "left", "h"} {
		m, _ = keyCmd(m, k)
		if m.wtIdx != 0 {
			t.Fatalf("%s moved above top: %d", k, m.wtIdx)
		}
	}
	for i, k := range []string{"down", "j", "right", "down"} {
		m, _ = keyCmd(m, k)
		if want := min(i+1, 2); m.wtIdx != want {
			t.Fatalf("%s: idx=%d want %d", k, m.wtIdx, want)
		}
	}
	for i, k := range []string{"up", "k", "left", "h"} {
		m, _ = keyCmd(m, k)
		if want := max(1-i, 0); m.wtIdx != want {
			t.Fatalf("%s: idx=%d want %d", k, m.wtIdx, want)
		}
	}
}

func narrowModel(t *testing.T) Model {
	t.Helper()
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "s1", "/r/.git", "/wt-a"))
	m = push(m, wev(2, "claude-code", "s2", "/r/.git", "/wt-b"))
	m = push(m, stateTransition(3, "s1", "working", ""))
	m = withWorktrees(m,
		row("/r/.git", "/wt-a", "/wt-a", SessionRef{"claude-code", "s1"}),
		row("/r/.git", "/wt-b", "/wt-b", SessionRef{"claude-code", "s2"}))
	m, _ = keyCmd(m, "w")
	return m
}

func TestEnterNarrowsSessionAltitudeToWorktree(t *testing.T) {
	m := narrowModel(t)
	m, _ = keyCmd(m, "enter")
	if m.alt != altSession || m.wscope == nil || m.scope != nil || !m.lanes || m.cursor != -1 {
		t.Fatalf("alt=%v wscope=%v scope=%v lanes=%v cursor=%d", m.alt, m.wscope, m.scope, m.lanes, m.cursor)
	}
	got := ids(m.filteredEvents())
	if strings.Join(got, ",") != "e1,transition-3" {
		t.Fatalf("filtered=%v", got)
	}
	s := sessionIDs(m)
	if len(s) != 1 || !s["s1"] {
		t.Fatalf("live=%v", s)
	}
}

func TestScopeMembershipIsDerivedNotCached(t *testing.T) {
	m := narrowModel(t)
	m, _ = keyCmd(m, "enter")
	m = push(m, wev(5, "claude-code", "s7", "/r/.git", "/wt-a"))
	m = push(m, stateTransition(6, "s7", "working", ""))
	got := strings.Join(ids(m.filteredEvents()), ",")
	if got != "e1,transition-3,e5,transition-6" {
		t.Fatalf("filtered=%s", got)
	}
	if s := sessionIDs(m); !s["s7"] || !s["s1"] || s["s2"] {
		t.Fatalf("live=%v", s)
	}
}

func TestScopeKeysOnSourceAndSession(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "session-1", "/r/.git", "/wt-a"))
	m = push(m, wev(2, "codex", "session-1", "/o/.git", "/wt-o"))
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a", SessionRef{"claude-code", "session-1"}),
		row("/o/.git", "/wt-o", "/wt-o", SessionRef{"codex", "session-1"}))
	m, _ = keyCmd(m, "w")
	// Sorted: /o first. Move to /r.
	if m.worktrees[0].Repo != "/o/.git" {
		t.Fatal("setup order")
	}
	m, _ = keyCmd(m, "down")
	m, _ = keyCmd(m, "enter")
	if got := strings.Join(ids(m.filteredEvents()), ","); got != "e1" {
		t.Fatalf("filtered=%s", got)
	}
	for _, s := range m.liveSessions(t0.Add(30 * time.Second)) {
		if s.Label == "claude" && s.ID == "session-1" {
			continue
		}
		t.Fatalf("unexpected live session %+v", s)
	}
	if len(sessionIDs(m)) != 1 {
		t.Fatal("expected exactly one live session")
	}
}

func TestAmbiguousTransitionDropped(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "session-1", "/r/.git", "/wt-a"))
	m = push(m, wev(2, "codex", "session-1", "/o/.git", "/wt-o"))
	m = push(m, wev(3, "claude-code", "uniq", "/r/.git", "/wt-a"))
	m = push(m, stateTransition(4, "session-1", "working", ""))
	m = push(m, stateTransition(5, "uniq", "working", ""))
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a", SessionRef{"claude-code", "session-1"}, SessionRef{"claude-code", "uniq"}))
	m, _ = keyCmd(m, "w")
	m, _ = keyCmd(m, "enter")
	got := strings.Join(ids(m.filteredEvents()), ",")
	if got != "e1,e3,transition-5" {
		t.Fatalf("filtered=%s", got)
	}
}

func TestScopeIncludesLoadedSessionNotListed(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "capped", "/r/.git", "/wt-a"))
	noWT := wev(2, "claude-code", "capped", "", "")
	m = push(m, noWT)
	m = push(m, wev(3, "claude-code", "other", "/r/.git", "/wt-z"))
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a"))
	m, _ = keyCmd(m, "w")
	m, _ = keyCmd(m, "enter")
	if got := strings.Join(ids(m.filteredEvents()), ","); got != "e1,e2" {
		t.Fatalf("filtered=%s", got)
	}
}

func TestSessionThatVisitedTwoWorktreesShownWholeInBoth(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "s1", "/r/.git", "/wt-a"))
	m = push(m, wev(2, "claude-code", "s1", "/r/.git", "/wt-b"))
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a"), row("/r/.git", "/wt-b", "/wt-b"))
	for _, down := range []int{0, 1} {
		mm, _ := keyCmd(m, "w")
		for i := 0; i < down; i++ {
			mm, _ = keyCmd(mm, "down")
		}
		mm, _ = keyCmd(mm, "enter")
		if got := strings.Join(ids(mm.filteredEvents()), ","); got != "e1,e2" {
			t.Fatalf("wt %d: %s", down, got)
		}
	}
}

func TestEscLadder(t *testing.T) {
	m := narrowModel(t)
	sel := m.wtSel
	m, _ = keyCmd(m, "enter")
	m, _ = keyCmd(m, "esc")
	if m.alt != altWorktree || m.wscope != nil || m.wtSel != sel {
		t.Fatalf("alt=%v wscope=%v sel=%q", m.alt, m.wscope, m.wtSel)
	}
	m, _ = keyCmd(m, "esc")
	if m.alt != altWorkspace {
		t.Fatalf("alt=%v", m.alt)
	}
	m, _ = keyCmd(m, "esc")
	if m.alt != altWorkspace {
		t.Fatal("workspace esc must be unchanged")
	}
}

func TestEscFromUnscopedSessionStillGoesToWorkspace(t *testing.T) {
	m := wtModel(&fakeSource{})
	m, _ = keyCmd(m, "esc")
	if m.alt != altWorkspace {
		t.Fatalf("alt=%v", m.alt)
	}
}

func TestEnterFromCellScopeThenEscReturnsToListNotCell(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "s1", "/r/.git", "/wt-a"))
	m.attention["s1"] = attention{State: "working", Since: t0, Last: t0, Source: "claude-code", Agent: "claude"}
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a", SessionRef{"claude-code", "s1"}))
	m, _ = keyCmd(m, "esc")
	m, _ = keyCmd(m, "enter") // cell scope
	if m.scope == nil {
		t.Fatal("setup: cell scope expected")
	}
	m, _ = keyCmd(m, "w")
	if m.scope != nil {
		t.Fatal("w must clear the cell scope")
	}
	m, _ = keyCmd(m, "enter")
	if m.scope != nil || m.wscope == nil {
		t.Fatal("narrow must not carry a cell scope")
	}
	m, _ = keyCmd(m, "esc")
	if m.alt != altWorktree || m.scope != nil {
		t.Fatalf("alt=%v scope=%v", m.alt, m.scope)
	}
}

func TestWorktreeFetchErrorsMapToState(t *testing.T) {
	m := withWorktrees(wtModel(&fakeSource{}), row("/a/.git", "a", "/a"))
	mm, _ := m.Update(WorktreesMsg{Err: errors.New("boom")})
	m = mm.(Model)
	if m.wtErr == nil || len(m.worktrees) != 1 || !m.wtFetchedAt.Equal(t0) {
		t.Fatalf("err=%v rows=%d fetched=%v", m.wtErr, len(m.worktrees), m.wtFetchedAt)
	}
	later := t0.Add(time.Minute)
	m.now = func() time.Time { return later }
	mm, _ = m.Update(WorktreesMsg{Err: errors.New("boom2")})
	m = mm.(Model)
	if !m.wtFetchedAt.Equal(t0) {
		t.Fatal("failure advanced wtFetchedAt")
	}
	mm, _ = m.Update(WorktreesMsg{List: WorktreeList{Rows: []WorktreeRow{row("/a/.git", "a", "/a")}}})
	m = mm.(Model)
	if m.wtErr != nil || m.wtUnavailable || !m.wtFetchedAt.Equal(later) {
		t.Fatalf("success did not clear: %v %v %v", m.wtErr, m.wtUnavailable, m.wtFetchedAt)
	}
	mm, _ = m.Update(WorktreesMsg{Err: fmt.Errorf("wrap: %w", ErrWorktreesUnavailable)})
	m = mm.(Model)
	if !m.wtUnavailable || len(m.worktrees) != 0 {
		t.Fatalf("unavailable=%v rows=%d", m.wtUnavailable, len(m.worktrees))
	}
}

func manyRows(n int) []WorktreeRow {
	rows := make([]WorktreeRow, n)
	for i := range rows {
		rows[i] = row(fmt.Sprintf("/r%03d/.git", i), fmt.Sprintf("wt%03d", i), fmt.Sprintf("/r%03d", i))
	}
	return rows
}

func selectedVisible(t *testing.T, m Model) {
	t.Helper()
	view := m.View()
	lines := strings.Split(strings.TrimRight(view, "\n"), "\n")
	if len(lines) > m.height {
		t.Fatalf("rendered %d lines, height %d", len(lines), m.height)
	}
	if !strings.Contains(view, fmt.Sprintf("wt%03d", m.wtIdx)) {
		// ID is not printed; path label carries r%03d.
		if !strings.Contains(view, fmt.Sprintf("r%03d", m.wtIdx)) {
			t.Fatalf("selected row %d not in view:\n%s", m.wtIdx, view)
		}
	}
	if m.wtIdx < m.wtTop || m.wtIdx >= m.wtTop+m.wtListHeight() {
		t.Fatalf("idx %d outside window [%d,+%d)", m.wtIdx, m.wtTop, m.wtListHeight())
	}
}

func TestWorktreeWindowKeepsSelectionVisible(t *testing.T) {
	m := wtModel(&fakeSource{})
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 24})
	m = withWorktrees(mm.(Model), manyRows(100)...)
	m.alt = altWorktree
	selectedVisible(t, m)
	for i := 0; i < 60; i++ {
		m, _ = keyCmd(m, "down")
	}
	selectedVisible(t, m)
	for i := 0; i < 100; i++ {
		m, _ = keyCmd(m, "down")
	}
	if m.wtIdx != 99 {
		t.Fatalf("idx=%d", m.wtIdx)
	}
	selectedVisible(t, m)
	for i := 0; i < 99; i++ {
		m, _ = keyCmd(m, "up")
	}
	selectedVisible(t, m)
}

func TestWorktreeWindowResize(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = withWorktrees(m, manyRows(100)...)
	m.alt = altWorktree
	for i := 0; i < 25; i++ {
		m, _ = keyCmd(m, "down")
	}
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 10})
	m = mm.(Model)
	selectedVisible(t, m)

	few := wtModel(&fakeSource{})
	few = withWorktrees(few, manyRows(3)...)
	few.alt = altWorktree
	view := few.View()
	for i := 0; i < 3; i++ {
		if !strings.Contains(view, fmt.Sprintf("r%03d", i)) {
			t.Fatalf("row %d missing:\n%s", i, view)
		}
	}
}

func TestShouldRefreshWorktrees(t *testing.T) {
	src := &fakeSource{}
	base := func() Model {
		m := wtModel(src)
		m.alt = altWorktree
		m.wtFetchedAt = t0
		return m
	}
	cases := []struct {
		name string
		mut  func(*Model)
		now  time.Time
		want bool
	}{
		{"fresh", func(m *Model) {}, t0.Add(9 * time.Second), false},
		{"stale", func(m *Model) {}, t0.Add(10 * time.Second), true},
		{"never fetched", func(m *Model) { m.wtFetchedAt = time.Time{} }, t0, true},
		{"wrong alt", func(m *Model) { m.alt = altSession }, t0.Add(time.Hour), false},
		{"no source", func(m *Model) { m.wsrc = nil }, t0.Add(time.Hour), false},
		{"inflight", func(m *Model) { m.wtInflight = true }, t0.Add(time.Hour), false},
		{"unavailable", func(m *Model) { m.wtUnavailable = true }, t0.Add(time.Hour), false},
		{"error keeps old age", func(m *Model) { m.wtErr = errors.New("x") }, t0.Add(11 * time.Second), true},
	}
	for _, c := range cases {
		m := base()
		c.mut(&m)
		if got := m.shouldRefreshWorktrees(c.now); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestTickSetsInflightOnce(t *testing.T) {
	src := &fakeSource{}
	m := wtModel(src)
	m.alt = altWorktree
	mm, cmd := m.Update(tickMsg(t0))
	m = mm.(Model)
	if !m.wtInflight || cmd == nil {
		t.Fatalf("inflight=%v cmd=%v", m.wtInflight, cmd != nil)
	}
	mm, cmd = m.Update(tickMsg(t0))
	if cmd == nil || !mm.(Model).wtInflight {
		t.Fatal("tick must still re-arm")
	}
	if src.calls != 0 {
		t.Fatalf("Update must not call the source: calls=%d", src.calls)
	}
}

func TestWorktreeFetchRunsOutsideUpdate(t *testing.T) {
	block := make(chan struct{})
	defer close(block)
	src := &fakeSource{block: block, list: WorktreeList{Rows: []WorktreeRow{row("/a/.git", "a", "/a")}}}
	m := wtModel(src)
	_, cmd := keyCmd(m, "w")
	if src.calls != 0 {
		t.Fatalf("calls=%d before cmd ran", src.calls)
	}
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	block <- struct{}{}
	select {
	case msg := <-done:
		if _, ok := msg.(WorktreesMsg); !ok {
			t.Fatalf("msg=%T", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestHistoryNotLoadedRendering(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = withWorktrees(m, row("/a/.git", "a", "/a", SessionRef{"claude-code", "s1"}))
	m, _ = keyCmd(m, "w")
	m, _ = keyCmd(m, "enter")
	if !strings.Contains(m.View(), "history not loaded") {
		t.Fatalf("view:\n%s", m.View())
	}
}

// Finding 1: a same-ID session from another source in another worktree must
// not paint its errors or spans onto the scoped lane.
func TestWorktreeLaneExcludesOtherSourceSameID(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "s", "/r/.git", "/wt-a"))
	bad := wev(20, "codex", "s", "/o/.git", "/wt-o")
	bad.Severity, bad.Category = event.SeverityError, event.CategoryError
	m = push(m, bad)
	open := wev(21, "codex", "s", "/o/.git", "/wt-o")
	open.CallID, open.Payload = "c1", map[string]any{"phase": "start"}
	m = push(m, open)
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a", SessionRef{"claude-code", "s"}),
		row("/o/.git", "/wt-o", "/wt-o", SessionRef{"codex", "s"}))
	m, _ = keyCmd(m, "w")
	m, _ = keyCmd(m, "down") // sorted: /o first
	m, _ = keyCmd(m, "enter")
	if m.wscope == nil || m.wscope.Repo != "/r/.git" || !m.lanes {
		t.Fatalf("setup: %+v lanes=%v", m.wscope, m.lanes)
	}
	now := t0.Add(30 * time.Second)
	strip := plain(strings.Join(m.viewLaneStrip(m.liveSessions(now), now, 8), "\n"))
	if !strings.Contains(strip, "claude") {
		t.Fatalf("no claude lane rendered:\n%s", strip)
	}
	if strings.Contains(strip, "!") || strings.Contains(strip, "─") {
		t.Fatalf("codex activity leaked onto the claude lane:\n%s", strip)
	}
}

// Finding 2: a collision known only from another fetched worktree row (its
// events have left the ring) still makes a source-less transition ambiguous.
func TestAmbiguousTransitionCollisionFromOtherRowOnly(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "s", "/r/.git", "/wt-a"))
	m = push(m, stateTransition(2, "s", "working", ""))
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a", SessionRef{"claude-code", "s"}),
		row("/o/.git", "/wt-o", "/wt-o", SessionRef{"codex", "s"}))
	m, _ = keyCmd(m, "w")
	m, _ = keyCmd(m, "down")
	m, _ = keyCmd(m, "enter")
	if got := strings.Join(ids(m.filteredEvents()), ","); got != "e1" {
		t.Fatalf("filtered=%s", got)
	}
}

// Finding 2: an identified attention entry is a known identity too.
func TestAmbiguousTransitionCollisionFromAttention(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "s", "/r/.git", "/wt-a"))
	m = push(m, stateTransition(2, "s", "working", ""))
	m.attention["s"] = attention{State: stateWorking, Source: "codex", Last: t0}
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a", SessionRef{"claude-code", "s"}))
	m, _ = keyCmd(m, "w")
	m, _ = keyCmd(m, "enter")
	if got := strings.Join(ids(m.filteredEvents()), ","); got != "e1" {
		t.Fatalf("filtered=%s", got)
	}
}

// Finding 3: a session discovered after descent stays in scope after the ring
// evicts its events, so a still-waiting needs_input session is not hidden.
func TestDiscoveredSessionSurvivesEvictionWhileNeedsInput(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a"))
	m, _ = keyCmd(m, "w")
	m, _ = keyCmd(m, "enter")
	m = push(m, wev(10, "claude-code", "new", "/r/.git", "/wt-a"))
	m = push(m, stateTransition(11, "new", stateNeedsInput, "permission"))
	if !sessionIDs(m)["new"] {
		t.Fatal("setup: new session not live before eviction")
	}
	// What the ring does once 20,000 newer events arrive.
	m.events = []event.Event{wev(12, "claude-code", "zz", "/o/.git", "/wt-o")}
	if s := sessionIDs(m); !s["new"] || s["zz"] {
		t.Fatalf("live after eviction=%v", s)
	}
}

// Finding 3: refreshed authoritative rows widen the scope as well.
func TestScopeMergesRefreshedRowSessions(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a"))
	m, _ = keyCmd(m, "w")
	m, _ = keyCmd(m, "enter")
	m = withWorktrees(m, row("/r/.git", "/wt-a", "/wt-a", SessionRef{"claude-code", "late"}))
	m.attention["late"] = attention{State: stateNeedsInput, Source: "claude-code", Since: t0, Last: t0}
	if !sessionIDs(m)["late"] {
		t.Fatal("refreshed row's session not in scope")
	}
}
