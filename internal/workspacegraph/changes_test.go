package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func writeText(t *testing.T, root, name, text string) {
	t.Helper()
	p := filepath.Join(root, name)
	if e := os.MkdirAll(filepath.Dir(p), 0o700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(p, []byte(text), 0o600); e != nil {
		t.Fatal(e)
	}
}

// numbered returns n distinct lines so line counts are exact whatever the diff algorithm.
func numbered(prefix string, n int) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&b, "%s %d\n", prefix, i)
	}
	return b.String()
}

func changesByPath(changes []FileChange) map[string]FileChange {
	out := map[string]FileChange{}
	for _, c := range changes {
		out[c.Path] = c
	}
	return out
}

func wantCounts(t *testing.T, c FileChange, status string, add, del int) {
	t.Helper()
	if c.Status != status || c.Additions == nil || c.Deletions == nil || *c.Additions != add || *c.Deletions != del || c.Binary {
		t.Errorf("%s: want %s +%d -%d, got %+v (additions=%v deletions=%v)", c.Path, status, add, del, c, c.Additions, c.Deletions)
	}
}

func wantNoCounts(t *testing.T, c FileChange, status string) {
	t.Helper()
	if c.Status != status || c.Additions != nil || c.Deletions != nil || c.Binary {
		t.Errorf("%s: want %s without counts, got %+v", c.Path, status, c)
	}
}

func snapshotOf(t *testing.T, root string, mode privacy.Mode) (*Service, Snapshot) {
	t.Helper()
	s := New(mode)
	r, e := s.Register(context.Background(), root, "git")
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.Snapshot(context.Background(), r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	return s, v
}

func dirtyRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	git(t, root, "init", "-b", "main")
	writeText(t, root, "a.txt", numbered("a", 8))
	writeText(t, root, "d.txt", numbered("d", 2))
	writeText(t, root, "e.txt", numbered("e", 8))
	writeText(t, root, "keep.txt", numbered("keep", 3))
	git(t, root, "add", ".")
	git(t, root, "commit", "-m", "base")
	return root
}

func TestGitUncommittedChangeStats(t *testing.T) {
	t.Parallel()
	root := dirtyRepo(t)
	// modified: one line replaced and one appended (+2 -1)
	writeText(t, root, "a.txt", strings.Replace(numbered("a", 8), "a 2\n", "a two\n", 1)+"a 9\n")
	// staged add
	writeText(t, root, "new.txt", numbered("new", 3))
	git(t, root, "add", "new.txt")
	// deleted in the working tree only
	os.Remove(filepath.Join(root, "d.txt"))
	// staged rename without edits
	git(t, root, "mv", "e.txt", "e2.txt")
	// untracked
	writeText(t, root, "u.txt", "scratch\n")
	// staged binary
	os.WriteFile(filepath.Join(root, "bin.dat"), []byte{0, 1, 2, 3, 0, 255, 0, 7}, 0o600)
	git(t, root, "add", "bin.dat")

	_, v := snapshotOf(t, root, privacy.ModeFull)
	if len(v.Workspaces) != 1 {
		t.Fatalf("%+v", v.Workspaces)
	}
	w := v.Workspaces[0]
	if !w.Dirty || w.ChangesTruncated {
		t.Fatalf("dirty=%v truncated=%v", w.Dirty, w.ChangesTruncated)
	}
	got := changesByPath(w.Changes)
	if len(w.Changes) != 6 || len(got) != 6 {
		t.Fatalf("want 6 changes, got %+v", w.Changes)
	}
	wantCounts(t, got["a.txt"], "M", 2, 1)
	wantCounts(t, got["new.txt"], "A", 3, 0)
	wantCounts(t, got["d.txt"], "D", 0, 2)
	wantCounts(t, got["e2.txt"], "R", 0, 0)
	wantNoCounts(t, got["u.txt"], "?")
	if b := got["bin.dat"]; b.Status != "A" || !b.Binary || b.Additions != nil || b.Deletions != nil {
		t.Errorf("binary: %+v", b)
	}
	if _, ok := got["e.txt"]; ok {
		t.Errorf("rename source must not be listed as its own change: %+v", w.Changes)
	}
	// zero counts are present on the wire, not omitted
	b, _ := json.Marshal(got["d.txt"])
	if !strings.Contains(string(b), `"additions":0`) || !strings.Contains(string(b), `"deletions":2`) {
		t.Errorf("zero additions must serialize: %s", b)
	}
	b, _ = json.Marshal(got["u.txt"])
	if strings.Contains(string(b), "additions") || strings.Contains(string(b), "deletions") || strings.Contains(string(b), "binary") {
		t.Errorf("untracked must omit counts: %s", b)
	}
}

func TestGitChangeStatusLetters(t *testing.T) {
	t.Parallel()
	root := dirtyRepo(t)
	// staged add then edited again: the working-tree letter wins over the index letter
	writeText(t, root, "n.txt", numbered("n", 2))
	git(t, root, "add", "n.txt")
	writeText(t, root, "n.txt", numbered("n", 4))
	// staged modification (index letter only)
	writeText(t, root, "keep.txt", numbered("keep", 5))
	git(t, root, "add", "keep.txt")
	_, v := snapshotOf(t, root, privacy.ModeFull)
	got := changesByPath(v.Workspaces[0].Changes)
	wantCounts(t, got["n.txt"], "M", 4, 0)
	wantCounts(t, got["keep.txt"], "M", 2, 0)
}

func TestGitCleanWorkspaceHasNoChanges(t *testing.T) {
	t.Parallel()
	root := dirtyRepo(t)
	_, v := snapshotOf(t, root, privacy.ModeFull)
	w := v.Workspaces[0]
	if w.Dirty || w.Changes != nil || w.ChangesTruncated {
		t.Fatalf("clean workspace: %+v", w)
	}
	b, _ := json.Marshal(w)
	if strings.Contains(string(b), `"changes"`) || strings.Contains(string(b), "changes_truncated") {
		t.Fatalf("clean workspace must omit changes fields: %s", b)
	}
}

func TestGitChangesTruncatedAtTwoHundred(t *testing.T) {
	t.Parallel()
	// git reports an untracked directory as one entry, so use tracked files.
	root := dirtyRepo(t)
	for i := 0; i < 201; i++ {
		writeText(t, root, fmt.Sprintf("bulk/f%03d.txt", i), "x\n")
	}
	git(t, root, "add", "bulk")
	git(t, root, "commit", "-m", "bulk")
	for i := 0; i < 201; i++ {
		writeText(t, root, fmt.Sprintf("bulk/f%03d.txt", i), "y\nz\n")
	}
	_, v := snapshotOf(t, root, privacy.ModeFull)
	w := v.Workspaces[0]
	if len(w.Changes) != 200 || !w.ChangesTruncated {
		t.Fatalf("changes=%d truncated=%v", len(w.Changes), w.ChangesTruncated)
	}
	if w.Changes[0].Path != "bulk/f000.txt" {
		t.Fatalf("truncation must keep git's stable path order: %+v", w.Changes[0])
	}
	wantCounts(t, w.Changes[0], "M", 2, 1)
	if len(w.ChangedFiles) != 201 {
		t.Fatalf("legacy changed_files keeps every entry: %d", len(w.ChangedFiles))
	}
	exactly := dirtyRepo(t)
	for i := 0; i < 200; i++ {
		writeText(t, exactly, fmt.Sprintf("bulk/f%03d.txt", i), "x\n")
	}
	git(t, exactly, "add", "bulk")
	_, v = snapshotOf(t, exactly, privacy.ModeFull)
	if w := v.Workspaces[0]; len(w.Changes) != 200 || w.ChangesTruncated {
		t.Fatalf("exactly 200 is not truncated: %d %v", len(w.Changes), w.ChangesTruncated)
	}
}

// A new directory is one `?? dir/` entry in the default status, which would make
// the structured changes report a single "file" for any number of new files.
func TestGitChangesEnumerateUntrackedDirectories(t *testing.T) {
	t.Parallel()
	root := dirtyRepo(t)
	for i := 0; i < 3; i++ {
		writeText(t, root, fmt.Sprintf("newdir/sub/f%d.txt", i), "x\n")
	}
	_, v := snapshotOf(t, root, privacy.ModeFull)
	w := v.Workspaces[0]
	got := changesByPath(w.Changes)
	if len(w.Changes) != 3 {
		t.Fatalf("each untracked file is its own change: %+v", w.Changes)
	}
	for i := 0; i < 3; i++ {
		wantNoCounts(t, got[fmt.Sprintf("newdir/sub/f%d.txt", i)], "?")
	}
	if len(w.ChangedFiles) != 1 || !strings.HasSuffix(w.ChangedFiles[0], "newdir/") {
		t.Fatalf("legacy changed_files keeps the directory entry: %q", w.ChangedFiles)
	}

	big := dirtyRepo(t)
	for i := 0; i < 201; i++ {
		writeText(t, big, fmt.Sprintf("bulk/f%03d.txt", i), "x\n")
	}
	_, v = snapshotOf(t, big, privacy.ModeFull)
	w = v.Workspaces[0]
	if len(w.Changes) != 200 || !w.ChangesTruncated {
		t.Fatalf("201 untracked files: changes=%d truncated=%v", len(w.Changes), w.ChangesTruncated)
	}
	if w.Changes[0].Path != "bulk/f000.txt" {
		t.Fatalf("stable path order: %+v", w.Changes[0])
	}
}

func TestGitChangesUnbornHeadSkipsCounts(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	git(t, root, "init", "-b", "main")
	writeText(t, root, "first.txt", numbered("x", 3))
	git(t, root, "add", "first.txt")
	writeText(t, root, "second.txt", "y\n")
	_, v := snapshotOf(t, root, privacy.ModeFull)
	w := v.Workspaces[0]
	if !w.Unborn {
		t.Fatalf("expected unborn: %+v", w)
	}
	got := changesByPath(w.Changes)
	if len(got) != 2 {
		t.Fatalf("%+v", w.Changes)
	}
	wantNoCounts(t, got["first.txt"], "A")
	wantNoCounts(t, got["second.txt"], "?")
}

func TestGitChangesSHA256Repository(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	git(t, root, "init", "-b", "main", "--object-format=sha256")
	writeText(t, root, "f.txt", numbered("f", 4))
	git(t, root, "add", ".")
	git(t, root, "commit", "-m", "base")
	writeText(t, root, "f.txt", numbered("f", 6))
	_, v := snapshotOf(t, root, privacy.ModeFull)
	if len(v.Workspaces[0].Changes) != 1 {
		t.Fatalf("%+v", v.Workspaces[0])
	}
	wantCounts(t, v.Workspaces[0].Changes[0], "M", 2, 0)
}

func TestGitUnmergedChangeHasNoCounts(t *testing.T) {
	t.Parallel()
	root := dirtyRepo(t)
	git(t, root, "checkout", "-b", "side")
	writeText(t, root, "a.txt", numbered("side", 8))
	git(t, root, "commit", "-am", "side")
	git(t, root, "checkout", "main")
	writeText(t, root, "a.txt", numbered("main", 8))
	git(t, root, "commit", "-am", "main")
	c := exec.Command("git", "merge", "side")
	c.Dir = root
	c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=F", "GIT_AUTHOR_EMAIL=f@example.invalid", "GIT_COMMITTER_NAME=F", "GIT_COMMITTER_EMAIL=f@example.invalid")
	c.CombinedOutput() // conflicts by design
	_, v := snapshotOf(t, root, privacy.ModeFull)
	w := v.Workspaces[0]
	got := changesByPath(w.Changes)
	wantNoCounts(t, got["a.txt"], "U")
	if !w.Conflicted {
		t.Fatalf("workspace should be conflicted: %+v", w)
	}
}

// git diff refreshes (rewrites) the index by default, even with
// GIT_OPTIONAL_LOCKS=0. Scans must leave the real index byte-identical.
func TestGitChangeStatsReadOnly(t *testing.T) {
	t.Parallel()
	root := dirtyRepo(t)
	old := time.Now().Add(-48 * time.Hour)
	if e := os.Chtimes(filepath.Join(root, "keep.txt"), old, old); e != nil { // stat-dirty, content identical
		t.Fatal(e)
	}
	writeText(t, root, "a.txt", numbered("a", 9))
	index := filepath.Join(root, ".git", "index")
	before, e := os.ReadFile(index)
	if e != nil {
		t.Fatal(e)
	}
	_, v := snapshotOf(t, root, privacy.ModeFull)
	wantCounts(t, changesByPath(v.Workspaces[0].Changes)["a.txt"], "M", 1, 0)
	if _, ok := changesByPath(v.Workspaces[0].Changes)["keep.txt"]; ok {
		t.Fatal("stat-only difference must not be a change")
	}
	after, e := os.ReadFile(index)
	if e != nil || !bytes.Equal(before, after) {
		t.Fatal("scan rewrote the git index")
	}
	if _, e := os.Stat(index + ".lock"); e == nil {
		t.Fatal("scan left an index lock")
	}
}

func TestGitChangesNeverRunLiveRepoDiffDrivers(t *testing.T) {
	t.Parallel()
	root := dirtyRepo(t)
	writeText(t, root, ".gitattributes", "a.txt diff=pwn filter=pwn\n")
	git(t, root, "add", ".gitattributes")
	git(t, root, "commit", "-m", "attrs")
	marker := filepath.Join(t.TempDir(), "pwned")
	git(t, root, "config", "diff.pwn.textconv", "touch "+marker+"; cat")
	git(t, root, "config", "diff.pwn.command", "touch "+marker)
	git(t, root, "config", "filter.pwn.clean", "touch "+marker+"; cat")
	git(t, root, "config", "core.fsmonitor", "touch "+marker)
	writeText(t, root, "a.txt", numbered("a", 9))
	ctx := context.Background()
	status, _, numstat, err := gitDirtyState(ctx, root, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, e := os.Stat(marker); e == nil {
		t.Fatal("repo-local diff/filter command was executed")
	}
	if !strings.Contains(status, "a.txt") || !strings.Contains(numstat, "a.txt") {
		t.Fatalf("lost data: %q %q", status, numstat)
	}
}

// Display data is readable and untruncated in every privacy mode: privacy modes
// govern captured history, not the user's own local graph view. Only identities
// (Repository.ID / Workspace.ID) follow the mode, because captured events carry
// the processed identities and session association depends on matching them.
func TestChangeStatsAreReadableInEveryMode(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("d", 100) + "/" + strings.Repeat("e", 100) + "/" + strings.Repeat("f", 100) + "-secret.txt"
	if n := len([]rune(long)); n <= 240 {
		t.Fatalf("fixture path too short: %d", n)
	}
	build := func() string {
		root := dirtyRepo(t)
		writeText(t, root, "a.txt", numbered("a", 10)) // +2 -0
		writeText(t, root, "secret-plan.txt", "x\n")   // untracked
		writeText(t, root, long, numbered("l", 4))
		git(t, root, "add", long)
		return root
	}
	for _, mode := range []privacy.Mode{privacy.ModeMinimal, privacy.ModeBalanced, privacy.ModeFull} {
		root := build()
		_, v := snapshotOf(t, root, mode)
		w := v.Workspaces[0]
		canonicalRoot, _ := canonical(root)
		if v.Repository.Label != canonicalRoot || w.Label != canonicalRoot {
			t.Errorf("%s: labels must be the readable root path: repo=%q workspace=%q want %q", mode, v.Repository.Label, w.Label, canonicalRoot)
		}
		got := changesByPath(w.Changes)
		if len(got) != 3 {
			t.Fatalf("%s: %+v", mode, w.Changes)
		}
		// raw, untruncated paths with structural metadata retained
		wantCounts(t, got["a.txt"], "M", 2, 0)
		wantNoCounts(t, got["secret-plan.txt"], "?")
		wantCounts(t, got[long], "A", 4, 0)
		files := strings.Join(w.ChangedFiles, "\n")
		for _, raw := range []string{"a.txt", "secret-plan.txt", long} {
			if !strings.Contains(files, raw) {
				t.Errorf("%s: changed_files lost the readable path %q: %q", mode, raw, w.ChangedFiles)
			}
		}
	}
}

// changed_files is a frozen representation: raw porcelain entries in every mode.
func TestChangedFilesUnchanged(t *testing.T) {
	t.Parallel()
	root := dirtyRepo(t)
	writeText(t, root, "a.txt", numbered("a", 9))
	writeText(t, root, "u.txt", "x\n")
	_, v := snapshotOf(t, root, privacy.ModeFull)
	if want := []string{" M a.txt", "?? u.txt"}; !reflect.DeepEqual(v.Workspaces[0].ChangedFiles, want) {
		t.Fatalf("legacy changed_files changed: %q", v.Workspaces[0].ChangedFiles)
	}
	for _, mode := range []privacy.Mode{privacy.ModeMinimal, privacy.ModeBalanced} {
		_, v = snapshotOf(t, root, mode)
		if want := []string{" M a.txt", "?? u.txt"}; !reflect.DeepEqual(v.Workspaces[0].ChangedFiles, want) {
			t.Fatalf("%s: %q want %q", mode, v.Workspaces[0].ChangedFiles, want)
		}
	}
	// rename entries keep their one-entry shape (original path skipped)
	git(t, root, "mv", "e.txt", "e2.txt")
	_, v = snapshotOf(t, root, privacy.ModeFull)
	if want := []string{" M a.txt", "R  e2.txt", "?? u.txt"}; !reflect.DeepEqual(v.Workspaces[0].ChangedFiles, want) {
		t.Fatalf("rename entries: %q", v.Workspaces[0].ChangedFiles)
	}
}

func TestSnapshotCloneDeepCopiesChanges(t *testing.T) {
	t.Parallel()
	one, two := 1, 2
	v := Snapshot{Workspaces: []Workspace{{Changes: []FileChange{{Path: "a", Status: "M", Additions: &one, Deletions: &two}}, ChangesTruncated: true}}}
	c := clone(v)
	if !reflect.DeepEqual(v.Workspaces[0].Changes, c.Workspaces[0].Changes) || !c.Workspaces[0].ChangesTruncated {
		t.Fatalf("clone differs: %+v", c.Workspaces[0])
	}
	*c.Workspaces[0].Changes[0].Additions = 99
	c.Workspaces[0].Changes[0].Path = "changed"
	if one != 1 || v.Workspaces[0].Changes[0].Path != "a" {
		t.Fatal("clone shares change storage with the cached snapshot")
	}
	empty := clone(Snapshot{Workspaces: []Workspace{{}}})
	if empty.Workspaces[0].Changes != nil {
		t.Fatal("a nil changes list must stay nil so it is omitted")
	}
}

func TestParsePorcelainChanges(t *testing.T) {
	t.Parallel()
	in := " M a.txt\x00A  b.txt\x00R  new.txt\x00old.txt\x00AM c.txt\x00?? d.txt\x00UU e.txt\x00 D f.txt\x00MM g.txt\x00 T h.txt\x00AA i.txt\x00!! j.txt\x00"
	got := parsePorcelainChanges(in)
	want := []rawChange{{"a.txt", "M"}, {"b.txt", "A"}, {"new.txt", "R"}, {"c.txt", "M"}, {"d.txt", "?"}, {"e.txt", "U"}, {"f.txt", "D"}, {"g.txt", "M"}, {"h.txt", "T"}, {"i.txt", "U"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestParseNumstat(t *testing.T) {
	t.Parallel()
	in := "2\t1\ta.txt\x00-\t-\tbin.dat\x000\t0\t\x00old name.txt\x00new name.txt\x003\t0\twith\ttab.txt\x00"
	got := parseNumstat(in)
	if len(got) != 4 {
		t.Fatalf("%+v", got)
	}
	if n := got["a.txt"]; n.binary || n.add != 2 || n.del != 1 {
		t.Errorf("%+v", n)
	}
	if n := got["bin.dat"]; !n.binary {
		t.Errorf("%+v", n)
	}
	if n := got["new name.txt"]; n.binary || n.add != 0 || n.del != 0 {
		t.Errorf("rename keyed by new path: %+v", got)
	}
	if n, ok := got["with\ttab.txt"]; !ok || n.add != 3 {
		t.Errorf("tab inside path: %+v", got)
	}
}

func TestParseRawChanges(t *testing.T) {
	t.Parallel()
	in := ":100644 100644 71ac1b5 0000000 M\x00a.txt\x00:000000 100644 0000000 ede570b A\x00bin.dat\x00:100644 000000 b77b4eb 0000000 D\x00d.txt\x00:100644 100644 535d2b0 535d2b0 R100\x00e.txt\x00e2.txt\x00:100644 120000 535d2b0 535d2b0 T\x00t\x00"
	got := parseRawChanges(in)
	want := []rawChange{{"a.txt", "M"}, {"bin.dat", "A"}, {"d.txt", "D"}, {"e2.txt", "R"}, {"t", "T"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestParseJJSummaryAndStat(t *testing.T) {
	t.Parallel()
	summary := "M a.txt\nA bin.dat\nR dir/{old.txt => new.txt}\nR plain.txt => moved.txt\nD keep.txt\nA we ird | name.txt\nC {x => y}/z.txt\n"
	entries := parseJJSummary(summary)
	want := []jjEntry{{"a.txt", "a.txt", "M"}, {"bin.dat", "bin.dat", "A"}, {"dir/new.txt", "dir/{old.txt => new.txt}", "R"}, {"moved.txt", "plain.txt => moved.txt", "R"}, {"keep.txt", "keep.txt", "D"}, {"we ird | name.txt", "we ird | name.txt", "A"}, {"y/z.txt", "{x => y}/z.txt", "C"}}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("summary:\n%+v\n%+v", entries, want)
	}
	stat := "a.txt                    | 100 " + strings.Repeat("+", 100) + "\n" +
		"bin.dat                  | (binary) +300 bytes\n" +
		"dir/{old.txt => new.txt} |   0\n" +
		"keep.txt                 |   1 -\n" +
		"we ird | name.txt        |   3 ++-\n" +
		"scaled.txt               |  90 ++++\n" +
		"6 files changed, 103 insertions(+), 2 deletions(-)\n"
	counts := parseJJStat(stat)
	if c := counts["a.txt"]; c.binary || c.add != 100 || c.del != 0 {
		t.Errorf("a.txt %+v", c)
	}
	if c := counts["bin.dat"]; !c.binary {
		t.Errorf("bin %+v", c)
	}
	if c := counts["dir/{old.txt => new.txt}"]; c.binary || c.add != 0 || c.del != 0 {
		t.Errorf("rename %+v", c)
	}
	if c := counts["keep.txt"]; c.add != 0 || c.del != 1 {
		t.Errorf("keep %+v", c)
	}
	if c := counts["we ird | name.txt"]; c.add != 2 || c.del != 1 {
		t.Errorf("pipe in path %+v", c)
	}
	if _, ok := counts["scaled.txt"]; ok {
		t.Errorf("a histogram that does not add up to its total is scaled and must not yield counts")
	}
}

func TestDefaultTargetRefIsReadableInEveryMode(t *testing.T) {
	t.Parallel()
	root := fixture(t)
	for _, mode := range []privacy.Mode{privacy.ModeFull, privacy.ModeBalanced, privacy.ModeMinimal} {
		_, v := snapshotOf(t, root, mode)
		if v.DefaultTargetRef != "main" || v.DefaultTarget == "" {
			t.Errorf("%s: ref=%q target=%q", mode, v.DefaultTargetRef, v.DefaultTarget)
		}
		b, _ := json.Marshal(v)
		if !strings.Contains(string(b), `"default_target_ref":"main"`) {
			t.Errorf("%s: json %s", mode, b)
		}
	}
	master := t.TempDir()
	git(t, master, "init", "-b", "master")
	git(t, master, "commit", "--allow-empty", "-m", "x")
	if _, v := snapshotOf(t, master, privacy.ModeFull); v.DefaultTargetRef != "master" {
		t.Errorf("master: %+v", v.DefaultTargetRef)
	}
	other := t.TempDir()
	git(t, other, "init", "-b", "trunk")
	git(t, other, "commit", "--allow-empty", "-m", "x")
	if _, v := snapshotOf(t, other, privacy.ModeFull); v.DefaultTargetRef != "" || v.DefaultTarget != "" {
		t.Errorf("no main/master: ref=%q target=%q", v.DefaultTargetRef, v.DefaultTarget)
	}
}

func TestCompareChangeStats(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	root := dirtyRepo(t)
	base := git(t, root, "rev-parse", "HEAD")
	git(t, root, "checkout", "-b", "feature")
	writeText(t, root, "a.txt", strings.Replace(numbered("a", 8), "a 3\n", "a three\n", 1)+"a 9\n")
	writeText(t, root, "new.txt", numbered("new", 5))
	os.Remove(filepath.Join(root, "d.txt"))
	git(t, root, "mv", "e.txt", "e2.txt")
	os.WriteFile(filepath.Join(root, "bin.dat"), []byte{0, 1, 2, 0, 3}, 0o600)
	git(t, root, "add", "-A")
	git(t, root, "commit", "-m", "feature work")
	tip := git(t, root, "rev-parse", "HEAD")
	s := New(privacy.ModeFull)
	r, e := s.Register(ctx, root, "git")
	if e != nil {
		t.Fatal(e)
	}
	cmp, e := s.Compare(ctx, r.ID, tip, base)
	if e != nil {
		t.Fatal(e)
	}
	got := changesByPath(cmp.Changes)
	if len(got) != 5 || cmp.ChangesTruncated {
		t.Fatalf("%+v", cmp.Changes)
	}
	wantCounts(t, got["a.txt"], "M", 2, 1)
	wantCounts(t, got["new.txt"], "A", 5, 0)
	wantCounts(t, got["d.txt"], "D", 0, 2)
	wantCounts(t, got["e2.txt"], "R", 0, 0)
	if b := got["bin.dat"]; b.Status != "A" || !b.Binary || b.Additions != nil || b.Deletions != nil {
		t.Errorf("binary: %+v", b)
	}
	// the legacy committed file list keeps its meaning
	legacy := map[string]bool{}
	for _, p := range cmp.ChangedFiles {
		legacy[p] = true
	}
	for _, p := range []string{"a.txt", "bin.dat", "d.txt", "e2.txt", "new.txt"} {
		if !legacy[p] {
			t.Fatalf("changed_files lost %s: %q", p, cmp.ChangedFiles)
		}
	}
	// no differences: omitted
	same, e := s.Compare(ctx, r.ID, tip, tip)
	if e != nil || same.Changes != nil || same.ChangesTruncated {
		t.Fatalf("identical revisions: %+v %v", same, e)
	}
	b, _ := json.Marshal(same)
	if strings.Contains(string(b), `"changes"`) {
		t.Fatalf("empty comparison must omit changes: %s", b)
	}
}

func TestCompareChangeStatsMultipleMergeBases(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	root := t.TempDir()
	git(t, root, "init", "-b", "main")
	writeText(t, root, "a.txt", numbered("a", 6))
	writeText(t, root, "b.txt", numbered("b", 6))
	git(t, root, "add", ".")
	git(t, root, "commit", "-m", "base")
	git(t, root, "checkout", "-b", "side-a")
	writeText(t, root, "a.txt", numbered("a", 7))
	git(t, root, "commit", "-am", "a")
	aTip := git(t, root, "rev-parse", "HEAD")
	git(t, root, "checkout", "-b", "side-b", "main")
	writeText(t, root, "b.txt", numbered("b", 7))
	git(t, root, "commit", "-am", "b")
	bTip := git(t, root, "rev-parse", "HEAD")
	// criss-cross: x merges a into b, y merges b into a
	git(t, root, "checkout", "-b", "x", bTip)
	git(t, root, "merge", "--no-ff", "-m", "x", aTip)
	git(t, root, "checkout", "-b", "y", aTip)
	git(t, root, "merge", "--no-ff", "-m", "y", bTip)
	y := git(t, root, "rev-parse", "HEAD")
	git(t, root, "checkout", "x")
	writeText(t, root, "a.txt", strings.Replace(numbered("a", 7), "a 1\n", "a one\n", 1))
	git(t, root, "commit", "-am", "x2")
	x2 := git(t, root, "rev-parse", "HEAD")
	s := New(privacy.ModeFull)
	r, e := s.Register(ctx, root, "git")
	if e != nil {
		t.Fatal(e)
	}
	cmp, e := s.Compare(ctx, r.ID, x2, y)
	if e != nil {
		t.Fatal(e)
	}
	if len(cmp.MergeBases) != 2 {
		t.Fatalf("want two merge bases: %+v", cmp)
	}
	if len(cmp.Changes) != 1 {
		t.Fatalf("%+v", cmp.Changes)
	}
	wantCounts(t, cmp.Changes[0], "M", 1, 1)
}

func TestCompareChangesTruncated(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	root := dirtyRepo(t)
	base := git(t, root, "rev-parse", "HEAD")
	for i := 0; i < 201; i++ {
		writeText(t, root, fmt.Sprintf("bulk/f%03d.txt", i), "x\n")
	}
	git(t, root, "add", "-A")
	git(t, root, "commit", "-m", "bulk")
	tip := git(t, root, "rev-parse", "HEAD")
	s := New(privacy.ModeFull)
	r, _ := s.Register(ctx, root, "git")
	cmp, e := s.Compare(ctx, r.ID, tip, base)
	if e != nil || len(cmp.Changes) != 200 || !cmp.ChangesTruncated {
		t.Fatalf("%d %v %v", len(cmp.Changes), cmp.ChangesTruncated, e)
	}
	if len(cmp.ChangedFiles) != 201 {
		t.Fatalf("legacy list unchanged: %d", len(cmp.ChangedFiles))
	}
}

func TestCompareChangeStatsAreReadableInEveryMode(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	root := dirtyRepo(t)
	base := git(t, root, "rev-parse", "HEAD")
	long := strings.Repeat("d", 100) + "/" + strings.Repeat("e", 100) + "/" + strings.Repeat("f", 100) + "-secret.txt"
	writeText(t, root, "secret-plan.txt", numbered("s", 3))
	writeText(t, root, long, "x\n")
	git(t, root, "add", "-A")
	git(t, root, "commit", "-m", "secret")
	tip := git(t, root, "rev-parse", "HEAD")
	for _, mode := range []privacy.Mode{privacy.ModeMinimal, privacy.ModeBalanced, privacy.ModeFull} {
		s := New(mode)
		r, _ := s.Register(ctx, root, "git")
		cmp, e := s.Compare(ctx, r.ID, tip, base)
		if e != nil || len(cmp.Changes) != 2 {
			t.Fatalf("%s: %+v %v", mode, cmp, e)
		}
		got := changesByPath(cmp.Changes)
		wantCounts(t, got["secret-plan.txt"], "A", 3, 0)
		wantCounts(t, got[long], "A", 1, 0)
		files := strings.Join(cmp.ChangedFiles, "\n")
		if !strings.Contains(files, "secret-plan.txt") || !strings.Contains(files, long) {
			t.Errorf("%s: changed_files must be raw and untruncated: %q", mode, cmp.ChangedFiles)
		}
	}
}

func jjHeadOp(t *testing.T, root string) string {
	return jj(t, root, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id")
}

func jjCommit(t *testing.T, root, rev string) string {
	return jj(t, root, "--ignore-working-copy", "log", "--no-graph", "-r", rev, "-T", "commit_id")
}

func requireJJ(t *testing.T) {
	t.Helper()
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
}

func TestCompareChangeStatsJJ(t *testing.T) {
	t.Parallel()
	requireJJ(t)
	ctx := context.Background()
	root := t.TempDir()
	jj(t, root, "git", "init")
	writeText(t, root, "a.txt", numbered("a", 8))
	writeText(t, root, "d.txt", numbered("d", 2))
	writeText(t, root, "dir/old.txt", numbered("o", 4))
	jj(t, root, "commit", "-m", "base")
	base := jjCommit(t, root, "@-")
	writeText(t, root, "a.txt", strings.Replace(numbered("a", 8), "a 2\n", "a two\n", 1)+"a 9\n")
	os.Remove(filepath.Join(root, "d.txt"))
	writeText(t, root, "new.txt", numbered("n", 3))
	os.Rename(filepath.Join(root, "dir/old.txt"), filepath.Join(root, "dir/renamed.txt"))
	os.WriteFile(filepath.Join(root, "bin.dat"), []byte{0, 1, 2, 0, 3}, 0o600)
	jj(t, root, "commit", "-m", "work")
	tip := jjCommit(t, root, "@-")
	op := jjHeadOp(t, root)
	s := New(privacy.ModeFull)
	r, e := s.Register(ctx, root, "jj")
	if e != nil {
		t.Fatal(e)
	}
	cmp, e := s.Compare(ctx, r.ID, tip, base)
	if e != nil {
		t.Fatal(e)
	}
	if jjHeadOp(t, root) != op {
		t.Fatal("compare mutated the JJ operation log")
	}
	got := changesByPath(cmp.Changes)
	if len(got) != 5 {
		t.Fatalf("%+v", cmp.Changes)
	}
	wantCounts(t, got["a.txt"], "M", 2, 1)
	wantCounts(t, got["d.txt"], "D", 0, 2)
	wantCounts(t, got["new.txt"], "A", 3, 0)
	wantCounts(t, got["dir/renamed.txt"], "R", 0, 0)
	if b := got["bin.dat"]; b.Status != "A" || !b.Binary || b.Additions != nil {
		t.Errorf("binary %+v", b)
	}
	for _, mode := range []privacy.Mode{privacy.ModeMinimal, privacy.ModeBalanced} {
		s := New(mode)
		r, _ := s.Register(ctx, root, "jj")
		cmp, e := s.Compare(ctx, r.ID, tip, base)
		if e != nil || len(cmp.Changes) != 5 {
			t.Fatalf("%s: %+v %v", mode, cmp, e)
		}
		readable := changesByPath(cmp.Changes)
		wantCounts(t, readable["a.txt"], "M", 2, 1)
		wantCounts(t, readable["dir/renamed.txt"], "R", 0, 0)
		if files := strings.Join(cmp.ChangedFiles, "\n"); !strings.Contains(files, "a.txt") || !strings.Contains(files, "renamed") {
			t.Errorf("%s: JJ changed_files must be readable: %q", mode, cmp.ChangedFiles)
		}
	}
}

func TestCompareChangeStatsJJMultipleMergeBases(t *testing.T) {
	t.Parallel()
	requireJJ(t)
	ctx := context.Background()
	root := t.TempDir()
	jj(t, root, "git", "init")
	writeText(t, root, "a.txt", numbered("a", 6))
	writeText(t, root, "b.txt", numbered("b", 6))
	jj(t, root, "commit", "-m", "base")
	base := jjCommit(t, root, "@-")
	jj(t, root, "new", base, "-m", "side a")
	writeText(t, root, "a.txt", numbered("a", 7))
	jj(t, root, "status")
	a := jjCommit(t, root, "@")
	jj(t, root, "new", base, "-m", "side b")
	writeText(t, root, "b.txt", numbered("b", 7))
	jj(t, root, "status")
	b := jjCommit(t, root, "@")
	// criss-cross merges: x = a+b and y = b+a share no commit ID
	jj(t, root, "new", a, b, "-m", "x")
	jj(t, root, "status")
	x := jjCommit(t, root, "@")
	jj(t, root, "new", b, a, "-m", "y")
	jj(t, root, "status")
	y := jjCommit(t, root, "@")
	jj(t, root, "new", x, "-m", "x2")
	writeText(t, root, "a.txt", strings.Replace(numbered("a", 7), "a 1\n", "a one\n", 1))
	jj(t, root, "status")
	x2 := jjCommit(t, root, "@")
	if x == y {
		t.Fatal("fixture needs distinct revision IDs")
	}
	s := New(privacy.ModeFull)
	r, e := s.Register(ctx, root, "jj")
	if e != nil {
		t.Fatal(e)
	}
	cmp, e := s.Compare(ctx, r.ID, x2, y)
	if e != nil {
		t.Fatal(e)
	}
	bases := map[string]bool{}
	for _, id := range cmp.MergeBases {
		bases[id] = true
	}
	if len(bases) != 2 || !bases[a] || !bases[b] {
		t.Fatalf("want merge bases %s and %s: %+v", a, b, cmp.MergeBases)
	}
	if len(cmp.Changes) != 1 {
		t.Fatalf("%+v", cmp.Changes)
	}
	wantCounts(t, cmp.Changes[0], "M", 1, 1)
	if cmp.Changes[0].Path != "a.txt" {
		t.Fatalf("%+v", cmp.Changes[0])
	}
}

func TestJJWorkspaceChanges(t *testing.T) {
	t.Parallel()
	requireJJ(t)
	ctx := context.Background()
	root := t.TempDir()
	jj(t, root, "git", "init")
	writeText(t, root, "a.txt", numbered("a", 8))
	writeText(t, root, "gone.txt", "x\n")
	jj(t, root, "commit", "-m", "base")
	writeText(t, root, "a.txt", numbered("a", 11))
	os.Remove(filepath.Join(root, "gone.txt"))
	writeText(t, root, "fresh.txt", numbered("f", 2))
	jj(t, root, "status") // records the working copy so the scan (which never snapshots) sees it
	clean := filepath.Join(t.TempDir(), "clean")
	jj(t, root, "workspace", "add", clean)
	s := New(privacy.ModeFull)
	r, e := s.Register(ctx, root, "jj")
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.Snapshot(ctx, r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	var dirty, cleanWs *Workspace
	for i := range v.Workspaces {
		if v.Workspaces[i].Dirty {
			dirty = &v.Workspaces[i]
		} else {
			cleanWs = &v.Workspaces[i]
		}
	}
	if dirty == nil || cleanWs == nil {
		t.Fatalf("workspaces: %+v", v.Workspaces)
	}
	got := changesByPath(dirty.Changes)
	if len(got) != 3 {
		t.Fatalf("%+v", dirty.Changes)
	}
	wantCounts(t, got["a.txt"], "M", 3, 0)
	wantCounts(t, got["gone.txt"], "D", 0, 1)
	wantCounts(t, got["fresh.txt"], "A", 2, 0)
	if cleanWs.Changes != nil || cleanWs.ChangesTruncated {
		t.Fatalf("clean workspace: %+v", cleanWs)
	}
	if v.DefaultTargetRef != "" {
		t.Fatalf("no main bookmark yet: %q", v.DefaultTargetRef)
	}
}

func TestJJChangesReadOnly(t *testing.T) {
	t.Parallel()
	requireJJ(t)
	ctx := context.Background()
	root := t.TempDir()
	jj(t, root, "git", "init")
	writeText(t, root, "a.txt", numbered("a", 8))
	jj(t, root, "commit", "-m", "base")
	writeText(t, root, "a.txt", numbered("a", 10))
	jj(t, root, "status")
	op := jjHeadOp(t, root)
	// edited after the last recorded state: a scan must not snapshot it
	writeText(t, root, "late.txt", "unrecorded\n")
	writeText(t, root, "a.txt", numbered("a", 20))
	s := New(privacy.ModeFull)
	r, e := s.Register(ctx, root, "jj")
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.Snapshot(ctx, r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	if jjHeadOp(t, root) != op {
		t.Fatal("scan snapshotted the JJ working copy")
	}
	got := changesByPath(v.Workspaces[0].Changes)
	if _, ok := got["late.txt"]; ok || len(got) != 1 {
		t.Fatalf("unrecorded state leaked into changes: %+v", v.Workspaces[0].Changes)
	}
	wantCounts(t, got["a.txt"], "M", 2, 0)
	var parent string
	for _, n := range v.Nodes {
		if n.Key == v.Workspaces[0].Revision && len(n.Parents) > 0 {
			parent = n.Parents[0]
		}
	}
	cmp, e := s.Compare(ctx, r.ID, v.Workspaces[0].Revision, parent)
	if e != nil {
		t.Fatal(e)
	}
	if len(cmp.Changes) != 1 {
		t.Fatalf("compare must also read the recorded state only: %+v", cmp.Changes)
	}
	if jjHeadOp(t, root) != op {
		t.Fatal("compare snapshotted the JJ working copy")
	}
}

func TestJJChangesAndDefaultRefAreReadableInEveryMode(t *testing.T) {
	t.Parallel()
	requireJJ(t)
	ctx := context.Background()
	root := t.TempDir()
	jj(t, root, "git", "init")
	writeText(t, root, "base.txt", "x\n")
	jj(t, root, "commit", "-m", "base")
	jj(t, root, "bookmark", "create", "main", "-r", "@-")
	writeText(t, root, "secret-plan.txt", numbered("s", 3))
	jj(t, root, "status")
	for _, mode := range []privacy.Mode{privacy.ModeFull, privacy.ModeBalanced, privacy.ModeMinimal} {
		s := New(mode)
		r, e := s.Register(ctx, root, "jj")
		if e != nil {
			t.Fatal(e)
		}
		v, e := s.Snapshot(ctx, r.ID, "", true)
		if e != nil {
			t.Fatal(e)
		}
		if v.DefaultTargetRef != "main" || v.DefaultTarget == "" {
			t.Errorf("%s: ref %q target %q", mode, v.DefaultTargetRef, v.DefaultTarget)
		}
		wantCounts(t, changesByPath(v.Workspaces[0].Changes)["secret-plan.txt"], "A", 3, 0)
	}
}
