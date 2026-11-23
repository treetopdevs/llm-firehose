package tui

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"agentfirehose/internal/event"
)

func selectedCell(t *testing.T, m Model) matrixCell {
	t.Helper()
	cells := buildMatrix(m.liveSessions(m.now())).Cells
	if len(cells) == 0 {
		t.Fatal("no cells")
	}
	return cells[m.selectedCellIndex(cells)]
}

func TestEscClearsTheSelectedRowBeforeClimbing(t *testing.T) {
	m := newTestModel()
	for i := 1; i <= 3; i++ {
		m = push(m, mkEv(i, event.CategoryTool, "x"))
	}
	m = key(m, "k")
	if m.cursor < 0 {
		t.Fatal("setup: a row should be selected")
	}
	m = key(m, "esc")
	if m.alt != altSession || m.cursor != -1 {
		t.Fatalf("first esc should only clear the selection: alt=%v cursor=%d", m.alt, m.cursor)
	}
	m = key(m, "esc")
	if m.alt != altWorkspace {
		t.Fatalf("second esc should climb: alt=%v", m.alt)
	}
}

func TestBackAndForwardReturnToTheExactPlace(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now).WithWorktrees(&fakeSource{})
	m = key(key(m, "esc"), "j")
	m = key(m, "enter") // app · codex
	m = key(m, "w")     // the worktree list drops the cell scope
	if m.alt != altWorktree || m.scope != nil {
		t.Fatalf("setup: alt=%v scope=%v", m.alt, m.scope)
	}
	m = key(m, "[")
	if m.alt != altSession || m.scope == nil || m.scope.Agent != "codex" || !m.lanes {
		t.Fatalf("back should restore the scoped view: alt=%v scope=%+v lanes=%v", m.alt, m.scope, m.lanes)
	}
	m = key(m, "]")
	if m.alt != altWorktree || m.scope != nil {
		t.Fatalf("forward should return to the list: alt=%v scope=%+v", m.alt, m.scope)
	}
	m = key(key(m, "["), "[")
	if m.alt != altWorkspace || selectedCell(t, m).Agent != "codex" {
		t.Fatalf("back should restore the workspace selection: alt=%v cell=%+v", m.alt, selectedCell(t, m))
	}
}

func TestANewMoveClearsForward(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = key(key(m, "w"), "[")
	if len(m.forward) != 1 {
		t.Fatalf("forward = %d", len(m.forward))
	}
	m = key(m, "esc")
	if len(m.forward) != 0 {
		t.Fatalf("a new move should clear forward: %d", len(m.forward))
	}
}

func TestHistoryIsCapped(t *testing.T) {
	m := wtModel(&fakeSource{})
	for range maxPlaces + 10 {
		m = key(key(m, "w"), "esc")
	}
	if len(m.back) != maxPlaces {
		t.Fatalf("back = %d, want %d", len(m.back), maxPlaces)
	}
}

func TestBackRestoresTheSelectedRowByKey(t *testing.T) {
	m := wtModel(&fakeSource{})
	for i := 1; i <= 5; i++ {
		m = push(m, mkEv(i*10, event.CategoryTool, fmt.Sprintf("row %d", i)))
	}
	m = key(key(m, "k"), "k")
	want := m.visibleRows()[m.cursor].Event.ID
	m = key(m, "w")
	m.events = m.events[1:] // the ring moved on while we were away
	m = key(m, "[")
	if m.cursor < 0 || m.visibleRows()[m.cursor].Event.ID != want {
		t.Fatalf("cursor=%d, want row %s", m.cursor, want)
	}
}

func TestBackFallsToTheNearestRowWhenTheKeyIsGone(t *testing.T) {
	m := wtModel(&fakeSource{})
	for i := 1; i <= 3; i++ {
		m = push(m, mkEv(i*10, event.CategoryTool, fmt.Sprintf("row %d", i)))
	}
	m = key(m, "k") // the middle row
	m = key(m, "w")
	m.events = m.events[:1]
	m = key(m, "[")
	if m.cursor != 0 {
		t.Fatalf("cursor=%d, want the surviving row", m.cursor)
	}
}

func TestWorkspaceSelectionFollowsItsCellWhenTheMatrixReorders(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now)
	m = key(key(key(m, "esc"), "j"), "j")
	if got := selectedCell(t, m); got.Where != digestDir {
		t.Fatalf("setup: %+v", got)
	}
	fresh := mkEv(9, event.CategoryFile, "s3 again")
	fresh.SessionID, fresh.CWD, fresh.Time = "s3", digestDir, now
	m = push(m, fresh)
	if got := buildMatrix(m.liveSessions(now)).Cells[0]; got.Where != digestDir {
		t.Fatalf("setup: the digest row should now lead: %+v", got)
	}
	if got := selectedCell(t, m); got.Where != digestDir {
		t.Fatalf("selection moved to %+v", got)
	}
}

func TestNeedsYouKeyOpensTheLongestWaitAndCycles(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now)
	m = push(m, stateTransitionAt(now.Add(-5*time.Minute), "s3", stateNeedsInput, "older ask"))
	m = key(m, "n")
	if m.alt != altSession || m.scope == nil || m.scope.Where != digestDir {
		t.Fatalf("n should open the longest wait: alt=%v scope=%+v", m.alt, m.scope)
	}
	m = key(m, "n")
	if m.scope == nil || m.scope.Agent != "codex" {
		t.Fatalf("n again should move to the next: %+v", m.scope)
	}
	m = key(m, "[")
	if m.scope == nil || m.scope.Where != digestDir {
		t.Fatalf("back should undo one jump: %+v", m.scope)
	}
}

func TestNeedsYouKeyWithNothingWaitingStaysPut(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryTool, "x"))
	m = key(m, "n")
	if m.alt != altSession || m.scope != nil || len(m.back) != 0 {
		t.Fatalf("alt=%v scope=%v back=%d", m.alt, m.scope, len(m.back))
	}
	if !strings.Contains(plain(m.View()), "nothing needs you") {
		t.Fatalf("should say so:\n%s", plain(m.View()))
	}
	m = key(m, "t")
	if strings.Contains(plain(m.View()), "nothing needs you") {
		t.Fatal("the note should clear on the next key")
	}
}

func TestGoToAllActivityKeepsTheReadersStrip(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now)
	m = key(key(m, "esc"), "enter")
	if !m.lanes || m.scope == nil {
		t.Fatalf("setup: lanes=%v scope=%v", m.lanes, m.scope)
	}
	m = key(m, "g")
	if m.alt != altSession || m.scope != nil || m.wscope != nil || m.lanes {
		t.Fatalf("g should open the whole feed with the band: alt=%v scope=%v lanes=%v", m.alt, m.scope, m.lanes)
	}
	before := len(m.back)
	if m = key(m, "g"); len(m.back) != before {
		t.Fatal("g on the whole feed is not a move")
	}
}

func TestEscOutOfAScopeRestoresTheReadersStrip(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now)
	m = key(key(key(m, "esc"), "enter"), "esc")
	if m.lanes {
		t.Fatal("leaving a scope should put the band back")
	}
}

func TestFilterAndLaneWindowSurviveEveryMove(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now).WithWorktrees(&fakeSource{})
	m = key(key(m, "f"), "+")
	cat, win := m.filter.Category, m.laneIdx
	for _, k := range []string{"esc", "enter", "w", "[", "]", "n", "g"} {
		if m = key(m, k); m.filter.Category != cat || m.laneIdx != win {
			t.Fatalf("%q changed the filter or window", k)
		}
	}
}

func TestFooterSaysWhereEscGoes(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now)
	mustContain(t, plain(m.viewFooter()), "esc workspace", "n needs you")
	m = key(m, "k")
	mustContain(t, plain(m.viewFooter()), "esc follow")
	m = key(key(m, "esc"), "esc")
	mustContain(t, plain(m.viewFooter()), "[ back")
}

func TestPlaceKeysDoNothingInsideSearch(t *testing.T) {
	m := wtModel(&fakeSource{})
	m = key(m, "/")
	for _, k := range []string{"[", "]", "n", "g"} {
		m = key(m, k)
	}
	if m.buf != "[]ng" || len(m.back) != 0 {
		t.Fatalf("buf=%q back=%d", m.buf, len(m.back))
	}
}

func TestHeaderKeepsThePlaceAheadOfALongNeedsYouReason(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := workspaceFixture(now)
	m = push(m, stateTransitionAt(now.Add(-time.Minute), "s2", stateNeedsInput, strings.Repeat("approve this long command ", 4)))
	m = key(key(key(m, "esc"), "j"), "enter")
	head := plain(m.viewHeader())
	place, needs := strings.Index(head, "…/dev/app · codex"), strings.Index(head, "NEEDS YOU")
	if place < 0 || needs < 0 || place > needs {
		t.Fatalf("the place should come before the needs-you reason: %q", head)
	}
}

func TestEscFollowedQuicklyByABracketIsBothKeys(t *testing.T) {
	m := wtModel(&fakeSource{})
	for i := 1; i <= 3; i++ {
		m = push(m, mkEv(i, event.CategoryTool, "x"))
	}
	m = key(key(m, "w"), "esc") // the workspace, with the feed and list behind it
	m = key(m, "k")
	before := len(m.back)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("["), Alt: true})
	m = mm.(Model)
	if m.alt != altWorktree || len(m.back) != before-1 {
		t.Fatalf("alt+[ should act as esc then [: alt=%v back=%d", m.alt, len(m.back))
	}
	mm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("]"), Alt: true})
	m = mm.(Model)
	if m.alt != altWorkspace {
		t.Fatalf("alt+] should act as esc then ]: alt=%v", m.alt)
	}
}
