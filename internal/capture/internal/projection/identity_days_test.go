package projection

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
)

func identityEvents() []event.Event {
	day := func(d int, h int) time.Time { return time.Date(2026, 7, d, h, 0, 0, 0, time.UTC) }
	return []event.Event{
		{ID: "g1", Time: day(1, 9), Source: "codex", Category: event.CategoryMeta, SessionID: "s-git", RepoID: "repo-git", WorktreeID: "wt-main"},
		{ID: "g2", Time: day(3, 9), Source: "codex", Category: event.CategoryMeta, SessionID: "s-git", RepoID: "repo-git", WorktreeID: "wt-feature"},
		{ID: "j1", Time: day(2, 9), Source: "claude-code", Category: event.CategoryMeta, SessionID: "s-jj", JJRepoID: "jj:repo", JJWorkspaceID: "jj:ws-a"},
		{ID: "j2", Time: day(5, 23), Source: "claude-code", Category: event.CategoryMeta, SessionID: "s-jj", JJRepoID: "jj:repo", JJWorkspaceID: "jj:ws-b"},
		{ID: "n1", Time: day(4, 9), Source: "generic", Category: event.CategoryMeta, SessionID: "s-none"},
	}
}

func TestIdentityDaysIndexesEveryIdentityFieldOldestFirst(t *testing.T) {
	ix := foldProjection(identityEvents())
	cases := []struct {
		name   string
		values []string
		want   []string
	}{
		{"repo id", []string{"repo-git"}, []string{"2026-07-01", "2026-07-03"}},
		{"worktree id", []string{"wt-feature"}, []string{"2026-07-03"}},
		{"jj repo id", []string{"jj:repo"}, []string{"2026-07-02", "2026-07-05"}},
		{"jj workspace id", []string{"jj:ws-b"}, []string{"2026-07-05"}},
		{"union of aliases", []string{"wt-main", "jj:ws-a", "unknown"}, []string{"2026-07-01", "2026-07-02"}},
		{"empty and unknown", []string{"", "unknown"}, nil},
	}
	for _, tc := range cases {
		got := ix.IdentityDays(tc.values)
		if len(got) == 0 && len(tc.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: IdentityDays(%v) = %v, want %v", tc.name, tc.values, got, tc.want)
		}
	}
}

func TestTimelineDaysIntersectsGroupsAndSessionNewestFirst(t *testing.T) {
	ix := foldProjection(identityEvents())
	cases := []struct {
		name    string
		groups  [][]string
		session string
		want    []string
	}{
		{"unscoped lists every day newest first", nil, "", []string{"2026-07-05", "2026-07-04", "2026-07-03", "2026-07-02", "2026-07-01"}},
		{"repo group", [][]string{{"repo-git"}}, "", []string{"2026-07-03", "2026-07-01"}},
		{"repo and workspace intersect", [][]string{{"repo-git"}, {"wt-feature"}}, "", []string{"2026-07-03"}},
		{"alias union inside a group", [][]string{{"repo-git", "jj:repo"}}, "", []string{"2026-07-05", "2026-07-03", "2026-07-02", "2026-07-01"}},
		{"disjoint groups", [][]string{{"repo-git"}, {"jj:ws-a"}}, "", nil},
		{"session narrows", [][]string{{"repo-git", "jj:repo"}}, "s-jj", []string{"2026-07-05", "2026-07-02"}},
		{"session alone", nil, "s-none", []string{"2026-07-04"}},
		{"unknown session", nil, "missing", nil},
		{"unknown identity", [][]string{{"nope"}}, "", nil},
	}
	for _, tc := range cases {
		got := ix.TimelineDays(tc.groups, tc.session)
		if len(got) == 0 && len(tc.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: TimelineDays(%v, %q) = %v, want %v", tc.name, tc.groups, tc.session, got, tc.want)
		}
	}
}

func TestIdentityDaysIgnoreReplayedIDsAndStayIncremental(t *testing.T) {
	ix := New()
	ev := identityEvents()[0]
	ix.Apply(ev)
	ix.Apply(ev)
	if got := ix.IdentityDays([]string{"repo-git"}); !reflect.DeepEqual(got, []string{"2026-07-01"}) {
		t.Fatalf("after replay: %v", got)
	}
	ix.Apply(identityEvents()[1])
	if got := ix.IdentityDays([]string{"repo-git"}); !reflect.DeepEqual(got, []string{"2026-07-01", "2026-07-03"}) {
		t.Fatalf("incremental Apply did not extend the index: %v", got)
	}
}

func TestBuildRebuildsIdentityIndexEqualToFold(t *testing.T) {
	dir := t.TempDir()
	w := spool.NewWriter(dir)
	for _, ev := range identityEvents() {
		if _, err := w.Append(ev); err != nil {
			t.Fatal(err)
		}
	}
	built, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	folded := foldProjection(identityEvents())
	for _, id := range []string{"repo-git", "wt-main", "wt-feature", "jj:repo", "jj:ws-a", "jj:ws-b"} {
		if !reflect.DeepEqual(built.IdentityDays([]string{id}), folded.IdentityDays([]string{id})) {
			t.Errorf("Build index for %q = %v, fold = %v", id, built.IdentityDays([]string{id}), folded.IdentityDays([]string{id}))
		}
	}
	if !reflect.DeepEqual(built.TimelineDays(nil, ""), folded.TimelineDays(nil, "")) || len(built.TimelineDays(nil, "")) != 5 {
		t.Errorf("Build day set = %v, fold = %v", built.TimelineDays(nil, ""), folded.TimelineDays(nil, ""))
	}
}

func TestReadGapReportsUnreadableSpoolRecords(t *testing.T) {
	if ix := foldProjection(identityEvents()); ix.ReadGap() {
		t.Fatal("a clean fold must not report a read gap")
	}
	dir := t.TempDir()
	clean := `{"id":"ok","time":"2026-07-02T10:00:00Z","source":"generic","category":"meta"}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "2026-07-02.ndjson"), []byte(clean), 0o644); err != nil {
		t.Fatal(err)
	}
	ix, err := Build(dir)
	if err != nil || ix.ReadGap() {
		t.Fatalf("clean spool: gap=%v err=%v", ix.ReadGap(), err)
	}
	if err := os.WriteFile(filepath.Join(dir, "2026-07-02.ndjson"), []byte(clean+"{corrupt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ix, err = Build(dir)
	if err != nil || !ix.ReadGap() {
		t.Fatalf("corrupt spool line must be a read gap: gap=%v err=%v", ix.ReadGap(), err)
	}
	// A live tailer reports an unreadable appended record as a parse-error event.
	live := foldProjection(nil)
	live.Apply(event.Event{ID: "pe", Time: time.Now().UTC(), Source: SourceFirehose, Category: event.CategoryMeta, Name: "parse-error", Severity: event.SeverityWarn})
	if !live.ReadGap() {
		t.Fatal("a live parse-error event must be a read gap")
	}
}
