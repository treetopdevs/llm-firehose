package tui

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"agentfirehose/internal/event"
)

func wtView(m Model) string { return plain(m.View()) }

func listModel(known bool, rows ...WorktreeRow) Model {
	m := wtModel(&fakeSource{})
	mm, _ := m.Update(WorktreesMsg{List: WorktreeList{Rows: rows, StateKnown: known}})
	m = mm.(Model)
	m.alt = altWorktree
	return m
}

func mustContain(t *testing.T, v string, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if !strings.Contains(v, s) {
			t.Fatalf("missing %q in:\n%s", s, v)
		}
	}
}

func mustNotContain(t *testing.T, v string, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if strings.Contains(v, s) {
			t.Fatalf("unexpected %q in:\n%s", s, v)
		}
	}
}

func TestWorktreeListShowsColumns(t *testing.T) {
	r := row("org/repo", "wt1", "/home/u/proj/feature-x", SessionRef{"claude-code", "s1"}, SessionRef{"codex", "s2"})
	r.State = "open"
	r.Last = t0.Add(-2 * time.Minute)
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "s1", "org/repo", "wt1"))
	m.events[len(m.events)-1].Time = t0.Add(-time.Second)
	m = push(m, wev(2, "claude-code", "other", "org/repo", "wt9"))
	mm, _ := m.Update(WorktreesMsg{List: WorktreeList{Rows: []WorktreeRow{r}, StateKnown: true}})
	m = mm.(Model)
	m.alt = altWorktree
	v := wtView(m)
	mustContain(t, v, "REPO", "PATH", "BRANCH", "SESS", "LIVE", "LAST", "STATE", "org/repo", "…/proj/feature-x", "2m", "open", "–")
	var data string
	for _, l := range strings.Split(v, "\n") {
		if strings.Contains(l, "org/repo") {
			data = l
		}
	}
	f := strings.Fields(data)
	// ▸ org/repo path – 2 1 2m open
	if len(f) < 8 || f[3] != "–" || f[4] != "2" || f[5] != "1" || f[6] != "2m" || f[7] != "open" {
		t.Fatalf("columns wrong: %q", data)
	}
}

func TestWorktreeCappedSessionsShowsPlusN(t *testing.T) {
	r := row("org/repo", "wt1", "/p/a", SessionRef{"x", "1"}, SessionRef{"x", "2"}, SessionRef{"x", "3"})
	r.SessionsTotal = 5
	mustContain(t, wtView(listModel(true, r)), "+2")
}

func TestWorktreeStateRenderedAsAbsenceWithoutDaemon(t *testing.T) {
	r := row("org/repo", "wt1", "/p/a")
	r.State = "landed"
	m := listModel(false, r)
	v := wtView(m)
	mustNotContain(t, v, "landed")
	mustContain(t, v, "state needs the daemon")
	line := ""
	for _, l := range strings.Split(v, "\n") {
		if strings.Contains(l, "org/repo") {
			line = l
		}
	}
	if !strings.HasSuffix(strings.TrimSpace(line), "–") {
		t.Fatalf("state not absent: %q", line)
	}
}

func TestWorktreeStateUnknownFromDaemonIsAbsence(t *testing.T) {
	two, one := 2, 1
	yes := true
	cases := []struct {
		r    WorktreeRow
		want string
	}{
		{WorktreeRow{State: ""}, "–"},
		{WorktreeRow{State: "unknown"}, "–"},
		{WorktreeRow{State: "landed"}, "landed"},
		{WorktreeRow{State: "gone"}, "gone"},
		{WorktreeRow{State: "never_diverged"}, "never_diverged"},
		{WorktreeRow{State: "ahead", Ahead: &two, Behind: &one}, "ahead ↑2 ↓1"},
		{WorktreeRow{State: "ahead", Ahead: &two}, "ahead ↑2"},
		{WorktreeRow{State: "ahead", Ahead: &two, Behind: &one, Dirty: &yes}, "ahead ↑2 ↓1*"},
		{WorktreeRow{State: "landed"}, "landed"},
	}
	m := listModel(true)
	for _, c := range cases {
		if got := m.worktreeState(c.r); got != c.want {
			t.Errorf("%+v: got %q want %q", c.r, got, c.want)
		}
	}
	no := false
	if got := m.worktreeState(WorktreeRow{State: "gone", Dirty: &no}); got != "gone" {
		t.Errorf("dirty=false: %q", got)
	}
	if got := m.worktreeState(WorktreeRow{State: "ahead"}); strings.Contains(got, "↑") {
		t.Errorf("nil ahead rendered: %q", got)
	}
}

func TestWorktreeUnavailableDaemonShowsExplicitLine(t *testing.T) {
	m := wtModel(&fakeSource{})
	mm, _ := m.Update(WorktreesMsg{Err: ErrWorktreesUnavailable})
	m = mm.(Model)
	m.alt = altWorktree
	mustContain(t, wtView(m), "worktrees are not available from this daemon")
}

func TestWorktreeErrShowsLineWithStaleRows(t *testing.T) {
	m := listModel(true, row("org/repo", "wt1", "/p/a"))
	mm, _ := m.Update(WorktreesMsg{Err: errors.New("boom")})
	m = mm.(Model)
	mustContain(t, wtView(m), "refresh failed: boom", "org/repo")
}

func TestWorktreeEmptyListMessage(t *testing.T) {
	m := wtModel(&fakeSource{})
	m.alt = altWorktree
	mustContain(t, wtView(m), "loading worktrees…")
	m = listModel(true)
	mustContain(t, wtView(m), "no worktrees captured yet")
}

func TestWorktreeSelectedRowIsMarked(t *testing.T) {
	m := listModel(true, row("aaa/one", "w1", "/p/a"), row("bbb/two", "w2", "/p/b"))
	m, _ = keyCmd(m, "down")
	for _, l := range strings.Split(wtView(m), "\n") {
		if strings.Contains(l, "bbb/two") && !strings.HasPrefix(l, "▸ ") {
			t.Fatalf("selected not marked: %q", l)
		}
		if strings.Contains(l, "aaa/one") && strings.HasPrefix(l, "▸ ") {
			t.Fatalf("unselected marked: %q", l)
		}
	}
}

func TestWorktreeListIsWindowed(t *testing.T) {
	m := wtModel(&fakeSource{})
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 24})
	m = withWorktrees(mm.(Model), manyRows(100)...)
	m.alt = altWorktree
	for i := 0; i < 36; i++ {
		m, _ = keyCmd(m, "down")
	}
	v := wtView(m)
	if n := len(strings.Split(strings.TrimRight(v, "\n"), "\n")); n > 24 {
		t.Fatalf("%d lines > 24:\n%s", n, v)
	}
	mustContain(t, v, "37/100", "more", fmt.Sprintf("r%03d", 36))
}

func TestWorktreeFooterFetchedAge(t *testing.T) {
	m := listModel(true, row("org/repo", "wt1", "/p/a"))
	m.wtFetchedAt = t0.Add(-3 * time.Second)
	mustContain(t, wtView(m), "fetched 3s ago")
	mm, _ := m.Update(WorktreesMsg{Err: errors.New("down")})
	m = mm.(Model)
	if !m.wtFetchedAt.Equal(t0.Add(-3 * time.Second)) {
		t.Fatalf("failed fetch reset age: %v", m.wtFetchedAt)
	}
	mustContain(t, wtView(m), "fetched 3s ago", "refresh failed: down")

	obs := t0.Add(-7 * time.Second)
	r := row("org/repo", "wt1", "/p/a")
	r.LastObserved = &obs
	m = listModel(true, r)
	m.wtFetchedAt = t0
	mustContain(t, wtView(m), "observed 7s ago")
	mustNotContain(t, wtView(m), "local view")

	m = listModel(false, row("org/repo", "wt1", "/p/a"))
	v := wtView(m)
	mustContain(t, v, "local view, may lag the writer")
	mustNotContain(t, v, "reconciled")
}

func scopedModel(t *testing.T, r WorktreeRow, evs ...event.Event) Model {
	t.Helper()
	m := wtModel(&fakeSource{})
	for _, ev := range evs {
		m = push(m, ev)
	}
	m = withWorktrees(m, r)
	m.alt = altWorktree
	m, _ = keyCmd(m, "enter")
	if m.wscope == nil {
		t.Fatal("not scoped")
	}
	return m
}

func TestScopedWorktreeHistoryNotLoaded(t *testing.T) {
	r := row("org/repo", "wt1", "/p/feature", SessionRef{"claude-code", "s1"})
	var evs []event.Event
	for i := 0; i < 501; i++ {
		evs = append(evs, wev(i, "claude-code", "zz", "org/other", "wtz"))
	}
	m := scopedModel(t, r, evs...)
	v := wtView(m)
	mustContain(t, v, "history not loaded", "no loaded events for 1 listed session", "sessions of …/p/feature · loaded events")
	mustNotContain(t, v, "older than the loaded window")
	mustNotContain(t, v, "waiting for agent activity")
}

func TestScopedWorktreeWaitingStillShownWhenRowHasNoSessions(t *testing.T) {
	m := scopedModel(t, row("org/repo", "wt1", "/p/feature"), wev(1, "claude-code", "zz", "org/other", "wtz"))
	v := wtView(m)
	mustContain(t, v, "waiting for agent activity")
	mustNotContain(t, v, "history not loaded")
}

func TestWorktreeHeaderBreadcrumb(t *testing.T) {
	m := listModel(true, row("org/repo", "wt1", "/p/feature"))
	h := strings.Split(wtView(m), "\n")[0]
	mustContain(t, h, "worktrees")
	mustNotContain(t, h, "sessions of")
	m, _ = keyCmd(m, "enter")
	h = strings.Split(wtView(m), "\n")[0]
	mustContain(t, h, "worktrees", "sessions of …/p/feature · loaded events")
}

func TestWorktreeFooterHints(t *testing.T) {
	m := listModel(true, row("org/repo", "wt1", "/p/feature"))
	mustContain(t, wtView(m), "↑↓ pick · enter open · esc back")
	m, _ = keyCmd(m, "enter")
	mustContain(t, wtView(m), "esc worktrees", "l band")
	m, _ = keyCmd(m, "l")
	mustContain(t, wtView(m), "esc worktrees", "l lanes")
}

func TestHelpDocumentsWorktreeKey(t *testing.T) {
	m := wtModel(nil)
	m, _ = keyCmd(m, "?")
	v := wtView(m)
	mustContain(t, v, "w      worktree list", "workspace › worktree › session › call", "esc ascends one rung",
		"loaded events", "STATE needs the daemon", "BRANCH is not captured")
}

func TestWorktreeRowControlCharsStripped(t *testing.T) {
	r := row("org/\x1b[31mrepo\x07", "wt1", "/p/\x1b]0;evil\x07pa\tth\x1b[2J", SessionRef{"x", "1"})
	r.State = "la\x1b[2Jnded"
	m := listModel(true, r)
	raw := m.View()
	for _, bad := range []string{"\x07", "\x1b[2J", "\x1b]0;", "\x1b[31m"} {
		if strings.Contains(raw, bad) {
			t.Fatalf("control %q leaked: %q", bad, raw)
		}
	}
	m, _ = keyCmd(m, "enter")
	if strings.Contains(m.View(), "\x1b]0;") || strings.Contains(m.View(), "\x1b[2J") {
		t.Fatalf("scoped header leaked: %q", m.View())
	}
}

// Finding 4: a live session the capped list omits still counts when a loaded
// event places it in the worktree, and the count says it may be incomplete.
func TestWorktreeLiveCountUnionsLoadedAndMarksCapped(t *testing.T) {
	r := row("org/repo", "wt1", "/p/a", SessionRef{"claude-code", "listed"})
	r.SessionsTotal = 201
	m := wtModel(&fakeSource{})
	m = push(m, wev(1, "claude-code", "oldest", "org/repo", "wt1"))
	m = push(m, stateTransition(2, "oldest", stateNeedsInput, "permission"))
	mm, _ := m.Update(WorktreesMsg{List: WorktreeList{Rows: []WorktreeRow{r}, StateKnown: true}})
	m = mm.(Model)
	m.alt = altWorktree
	if f := liveField(t, m); f != "≥1" {
		t.Fatalf("capped LIVE=%q\n%s", f, wtView(m))
	}
	r.SessionsTotal = 1
	mm, _ = m.Update(WorktreesMsg{List: WorktreeList{Rows: []WorktreeRow{r}, StateKnown: true}})
	m = mm.(Model)
	if f := liveField(t, m); f != "1" {
		t.Fatalf("uncapped LIVE=%q\n%s", f, wtView(m))
	}
}

// liveField returns the LIVE cell of the selected row.
func liveField(t *testing.T, m Model) string {
	t.Helper()
	for _, ln := range strings.Split(wtView(m), "\n") {
		if f := strings.Fields(ln); len(f) > 0 && f[0] == "▸" {
			sess := 4
			if strings.HasPrefix(f[5], "+") {
				sess = 5
			}
			return f[sess+1]
		}
	}
	t.Fatalf("no selected row:\n%s", wtView(m))
	return ""
}

// Finding 5: the footer reports the selected row's observation, not the
// freshest one, and says so when the selected row has none.
func TestWorktreeFooterObservedIsSelectedRow(t *testing.T) {
	fresh, stale := t0.Add(-2*time.Second), t0.Add(-26*time.Hour)
	a, b, c := row("org/repo", "a", "/p/a"), row("org/repo", "b", "/p/b"), row("org/repo", "c", "/p/c")
	a.LastObserved, b.LastObserved = &fresh, &stale
	m := listModel(true, a, b, c)
	mustContain(t, wtView(m), "observed 2s ago")
	m, _ = keyCmd(m, "down")
	v := wtView(m)
	mustContain(t, v, "observed "+formatAge(26*time.Hour)+" ago")
	mustNotContain(t, v, "observed 2s ago")
	m, _ = keyCmd(m, "down")
	v = wtView(m)
	mustContain(t, v, "observed unknown")
	mustNotContain(t, v, "observed 2s ago")
}

// Finding 6: descending while paused, with the worktree's events held by the
// pause, must say so and not invent an age explanation.
func TestScopedWorktreePausedDescent(t *testing.T) {
	m := wtModel(&fakeSource{})
	m, _ = keyCmd(m, " ")
	m = push(m, wev(1, "claude-code", "s1", "org/repo", "wt1"))
	m = withWorktrees(m, row("org/repo", "wt1", "/p/feature", SessionRef{"claude-code", "s1"}))
	m.alt = altWorktree
	m, _ = keyCmd(m, "enter")
	v := wtView(m)
	mustContain(t, v, "1 event(s) for this worktree held by pause", "space to resume")
	mustNotContain(t, v, "older than the loaded window", "waiting for agent activity")
}
