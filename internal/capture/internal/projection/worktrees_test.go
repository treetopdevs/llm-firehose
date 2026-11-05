package projection

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

const worktreeFixture = "../../testdata/worktrees_full.ndjson"

func loadWorktreeFixture(t testing.TB) []event.Event {
	t.Helper()
	f, err := os.Open(worktreeFixture)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		var ev event.Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatal(err)
		}
		out = append(out, ev)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func worktreeRow(t testing.TB, rows []WorktreeLifetime, id string) WorktreeLifetime {
	t.Helper()
	for _, r := range rows {
		if r.WorktreeID == id {
			return r
		}
	}
	t.Fatalf("no worktree row %q in %d rows", id, len(rows))
	return WorktreeLifetime{}
}

func markKinds(r WorktreeLifetime) []string {
	out := []string{}
	for _, m := range r.Marks {
		out = append(out, m.Kind)
	}
	return out
}

func TestWorktreeFixtureIsScrubbedAndBounded(t *testing.T) {
	data, err := os.ReadFile(worktreeFixture)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > 150000 {
		t.Fatalf("fixture is %d bytes, cap 150000", len(data))
	}
	for _, bad := range []string{"/Users/", "nicholas", ".agentfirehose", "@", "SECRET"} {
		if strings.Contains(string(data), bad) {
			t.Errorf("fixture contains %q", bad)
		}
	}
	evs := loadWorktreeFixture(t)
	if len(evs) > 300 {
		t.Fatalf("fixture has %d lines, cap 300", len(evs))
	}
	ids := map[string]bool{}
	repos, wts := map[string]bool{}, map[string]map[string]bool{}
	meta, longPath, longCmd := 0, false, false
	for _, ev := range evs {
		if err := ev.Validate(); err != nil {
			t.Fatalf("%s: %v", ev.ID, err)
		}
		if ev.ID == "" || ids[ev.ID] {
			t.Fatalf("missing or duplicate id %q", ev.ID)
		}
		ids[ev.ID] = true
		if ev.Category == event.CategoryMeta {
			meta++
		}
		if ev.RepoID != "" {
			repos[ev.RepoID] = true
		}
		if ev.WorktreeID != "" {
			if wts[ev.WorktreeID] == nil {
				wts[ev.WorktreeID] = map[string]bool{}
			}
			wts[ev.WorktreeID][ev.SessionID] = true
		}
		for _, p := range EventFilePaths(ev) {
			if len([]rune(p)) > 240 {
				longPath = true
			}
		}
		if ev.Raw != "" {
			var raw struct {
				ToolInput struct {
					Command string `json:"command"`
				} `json:"tool_input"`
			}
			if err := json.Unmarshal([]byte(ev.Raw), &raw); err != nil {
				t.Fatalf("%s raw: %v", ev.ID, err)
			}
			if len([]rune(raw.ToolInput.Command)) > 240 {
				longCmd = true
			}
		}
	}
	if len(repos) != 2 || len(wts) != 3 {
		t.Errorf("repos=%d worktrees=%d, want 2 and 3", len(repos), len(wts))
	}
	got := map[string]int{}
	for id, s := range wts {
		got[id] = len(s)
	}
	if want := map[string]int{"/work/alpha": 3, "/work/alpha-feat": 2, "/work/beta-fix": 2}; !reflect.DeepEqual(got, want) {
		t.Errorf("sessions per worktree = %v, want %v", got, want)
	}
	if meta < 40 {
		t.Errorf("meta events = %d, want >= 40", meta)
	}
	if !longPath || !longCmd {
		t.Errorf("long path=%v long command=%v, want both", longPath, longCmd)
	}
}

func TestWorktreeLifetimeCountsFromFixture(t *testing.T) {
	ix := foldProjection(loadWorktreeFixture(t))
	rows := ix.Worktrees()
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3: %+v", len(rows), rows)
	}
	cases := []struct {
		id, repo     string
		signal, meta int
		sessions     int
		marks        []string
	}{
		{"/work/alpha", "/work/alpha/.git", 19, 12, 3, []string{"worktree_add", "push", "pr_merge"}},
		{"/work/alpha-feat", "/work/alpha/.git", 12, 30, 2, []string{"commit", "commit", "push", "pr_create"}},
		{"/work/beta-fix", "/work/beta/.git", 10, 8, 2, []string{"commit", "worktree_remove", "push"}},
	}
	signal, meta := 0, 0
	for _, c := range cases {
		r := worktreeRow(t, rows, c.id)
		signal += r.SignalEvents
		meta += r.MetaEvents
		if r.RepoID != c.repo || r.SignalEvents != c.signal || r.MetaEvents != c.meta || r.SessionsTotal != c.sessions || len(r.Sessions) != c.sessions {
			t.Errorf("%s: repo=%q signal=%d meta=%d sessions=%d/%d", c.id, r.RepoID, r.SignalEvents, r.MetaEvents, r.SessionsTotal, len(r.Sessions))
		}
		if got := markKinds(r); !reflect.DeepEqual(got, c.marks) || r.MarksTotal != len(c.marks) {
			t.Errorf("%s: marks=%v total=%d, want %v", c.id, got, r.MarksTotal, c.marks)
		}
		if one, ok := ix.Worktree(c.id); !ok || !reflect.DeepEqual(one, r) {
			t.Errorf("%s: Worktree() disagrees with Worktrees()", c.id)
		}
	}
	if signal != 41 || meta != 50 {
		t.Errorf("totals signal=%d meta=%d, want 41 and 50", signal, meta)
	}
	for i := 1; i < len(rows); i++ {
		if rows[i].LastTime.After(rows[i-1].LastTime) {
			t.Errorf("rows not ordered by last_time desc: %v", rows)
		}
	}
}

func wtEvent(id string, at time.Time, cat event.Category, session string) event.Event {
	return event.Event{ID: id, Time: at, Source: "claude-code", SessionID: session, Category: cat,
		RepoID: "/r/.git", WorktreeID: "/r", Name: "X", Summary: "s"}
}

func TestWorktreeMetaNeverMovesTimeSessionsOrPaths(t *testing.T) {
	d := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	meta := wtEvent("m1", d.Add(8*time.Hour+59*time.Minute), event.CategoryMeta, "meta-only-sess")
	meta.Payload = map[string]any{"file_path": "/r/meta-path.go"}
	late := wtEvent("m2", d.Add(20*time.Hour), event.CategoryMeta, "meta-only-sess")
	sig := wtEvent("s1", d.Add(9*time.Hour), event.CategoryFile, "sess-a")
	sig.Payload = map[string]any{"file_path": "/r/a.go"}
	metaOnly := wtEvent("m3", d, event.CategoryMeta, "meta-only-sess")
	metaOnly.WorktreeID = "/only-meta"
	ix := foldProjection([]event.Event{meta, late, sig, metaOnly})
	rows := ix.Worktrees()
	if len(rows) != 1 {
		t.Fatalf("rows=%+v, want just /r", rows)
	}
	r := rows[0]
	if !r.FirstTime.Equal(d.Add(9*time.Hour)) || !r.LastTime.Equal(d.Add(9*time.Hour)) {
		t.Errorf("times moved by meta: %v..%v", r.FirstTime, r.LastTime)
	}
	if r.MetaEvents != 2 || r.SignalEvents != 1 || len(r.Sessions) != 1 || r.Sessions[0].SessionID != "sess-a" || !reflect.DeepEqual(r.Paths, []string{"/r/a.go"}) {
		t.Errorf("row=%+v", r)
	}
	if _, ok := ix.Worktree("/only-meta"); ok {
		t.Error("meta-only worktree must be absent from Worktree()")
	}
}

func bashEvent(id string, at time.Time, name, session, cmd string) event.Event {
	raw, _ := json.Marshal(map[string]any{"session_id": session, "hook_event_name": strings.SplitN(name, ":", 2)[0], "tool_name": "Bash",
		"tool_input": map[string]any{"command": cmd}, "tool_response": map[string]any{"stdout": "ok"}})
	ev := wtEvent(id, at, event.CategoryShell, session)
	ev.Name = name
	ev.Raw = string(raw)
	return ev
}

func TestWorktreeLifecycleMarksFromFullModeBash(t *testing.T) {
	d := time.Date(2026, 10, 30, 9, 0, 0, 0, time.UTC)
	type c struct {
		name, cmd string
		want      []string
	}
	cases := []c{
		{"PostToolUse:Bash", "ls -la", nil},
		{"PostToolUse:Bash", "git status", nil},
		{"PostToolUse:Bash", `echo "git commit -m x"`, nil},
		{"PreToolUse:Bash", "git worktree add ../x -b x", nil},
		{"PostToolUseFailure:Bash", `git commit -m "fail"`, nil},
		{"PostToolUse:Bash", "git worktree add ../x -b x", []string{"worktree_add"}},
		{"PostToolUse:Bash", `cd /work/alpha-feat && git commit -am "wip; git push"`, []string{"commit"}},
		{"PostToolUse:Bash", "git commit -m \"$(cat <<'EOF'\nmsg\n\nMentions \"git push\" prose\nEOF\n)\"", []string{"commit"}},
		{"PostToolUse:Bash", "git push 2>&1 | tail -5", []string{"push"}},
	}
	var evs []event.Event
	for i, cs := range cases {
		evs = append(evs, bashEvent(fmt.Sprintf("e%02d", i), d.Add(time.Duration(i)*time.Minute), cs.name, fmt.Sprintf("sess-%d", i), cs.cmd))
	}
	ix := foldProjection(evs)
	r := worktreeRow(t, ix.Worktrees(), "/r")
	var want []WorktreeMark
	for i, cs := range cases {
		for _, k := range cs.want {
			want = append(want, WorktreeMark{Kind: k, SessionID: fmt.Sprintf("sess-%d", i), Time: d.Add(time.Duration(i) * time.Minute), EventID: fmt.Sprintf("e%02d", i)})
		}
	}
	if !reflect.DeepEqual(r.Marks, want) {
		t.Errorf("marks=%+v\nwant=%+v", r.Marks, want)
	}
	// Only Post shell events of claude-code with raw can mark.
	other := bashEvent("o1", d.Add(time.Hour), "PostToolUse:Bash", "s", "git commit -m x")
	other.Source = "codex"
	noRaw := bashEvent("o2", d.Add(time.Hour), "PostToolUse:Bash", "s", "git commit -m x")
	noRaw.Raw = ""
	r = worktreeRow(t, foldProjection([]event.Event{other, noRaw}).Worktrees(), "/r")
	if len(r.Marks) != 0 {
		t.Errorf("non-claude or raw-less events marked: %+v", r.Marks)
	}
}

func TestLifecycleKindsTable(t *testing.T) {
	bash := func(cmd string) string {
		b, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": cmd}})
		return string(b)
	}
	cases := []struct {
		name, raw string
		want      []string
	}{
		{"commit-tree", bash("git commit-tree abc"), nil},
		{"global -c", bash("git -c user.name=x commit -m m"), []string{"commit"}},
		{"env prefix", bash("FOO=1 git push"), []string{"push"}},
		{"abs path git", bash("/usr/bin/git commit --amend"), []string{"commit"}},
		{"quoted &&", bash("git commit -m 'a && git push'"), []string{"commit"}},
		{"chain", bash("git add . && git commit -m x && git push origin HEAD"), []string{"commit", "push"}},
		{"dup kinds", bash("git commit -m a; git commit -m b"), []string{"commit"}},
		{"quoted heredoc msg", bash("git commit -F - <<'EOF'\nfix\ngit push\nEOF"), []string{"commit"}},
		{"unquoted heredoc", bash("cat <<EOF\ngit push\nEOF"), nil},
		{"heredoc then command", bash("cat <<EOF > f\ngit push\nEOF\ngit commit -m x"), []string{"commit"}},
		{"gh pr create heredoc", bash("gh pr create --title t --body \"$(cat <<'EOF'\ngit commit\nEOF\n)\""), []string{"pr_create"}},
		{"gh pr create body-file heredoc", bash("gh pr create --body-file - <<'EOF'\ngit commit\nEOF"), []string{"pr_create"}},
		{"pipeline", bash("git push 2>&1 | tail"), []string{"push"}},
		{"gh -R merge", bash("gh -R o/r pr merge 3"), []string{"pr_merge"}},
		{"gh pr view", bash("gh pr view 3"), nil},
		{"worktree list", bash("git worktree list"), nil},
		{"worktree add", bash("git worktree add x"), []string{"worktree_add"}},
		{"worktree remove", bash("git worktree remove --force x"), []string{"worktree_remove"}},
		{"git -C worktree remove", bash("git -C /a worktree remove /b"), []string{"worktree_remove"}},
		{"comment", bash("ls # git push"), nil},
		{"escaped quote", bash(`echo \"; git push`), []string{"push"}},
		{"commit or true", bash("git commit -m x || true"), nil},
		{"push or echo", bash("git push || echo failed"), nil},
		{"or then and", bash("git commit -m x || true && git push"), []string{"push"}},
		{"push dry-run", bash("git push --dry-run"), nil},
		{"push -n", bash("git push -n origin HEAD"), nil},
		{"commit dry-run", bash("git commit --dry-run"), nil},
		{"commit -n is no-verify", bash("git commit -n -m x"), []string{"commit"}},
		{"pr merge help", bash("gh pr merge --help"), nil},
		{"pr merge squash", bash("gh pr merge 3 --squash --delete-branch"), []string{"pr_merge"}},
		{"Shell tool", `{"tool_name":"Shell","tool_input":{"command":"git push"}}`, []string{"push"}},
		{"Read tool", `{"tool_name":"Read","tool_input":{"command":"git push"}}`, nil},
		{"empty", "", nil},
		{"invalid json with git", "git {", nil},
		{"non-string command", `{"tool_name":"Bash","tool_input":{"command":["git","push"]}}`, nil},
		{"no tool_input", `{"tool_name":"Bash","git":1}`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := lifecycleKinds(c.raw); !reflect.DeepEqual(got, c.want) {
				t.Errorf("lifecycleKinds=%v, want %v", got, c.want)
			}
		})
	}
}

func hugeRaw(big string, tail string) string {
	return `{"tool_response":{"stdout":"` + big + `"},"tool_name":"Bash","tool_input":{"command":"git commit -m x"}` + tail + `}`
}

func TestLifecycleParserIsBoundedOnHugeToolResponse(t *testing.T) {
	big := strings.Repeat("x", 5<<20)
	raw := hugeRaw(big, `,"tool_response2":{"stdout":"`+big+`"}`)
	if got := lifecycleKinds(raw); !reflect.DeepEqual(got, []string{"commit"}) {
		t.Fatalf("got %v", got)
	}
	// Streaming stops after tool_input: garbage after it is never read.
	if got := lifecycleKinds(hugeRaw("", `,garbage not json`)); !reflect.DeepEqual(got, []string{"commit"}) {
		t.Fatalf("decoder read past tool_input: %v", got)
	}
	// tool_name after tool_input is still found.
	late := `{"tool_input":{"command":"git push"},"tool_response":"` + big + `","tool_name":"Bash"}`
	if got := lifecycleKinds(late); !reflect.DeepEqual(got, []string{"push"}) {
		t.Fatalf("late tool_name: %v", got)
	}
	// No git/gh substring: no decoding, so invalid JSON is simply none.
	if got := lifecycleKinds(`{{{ not json ` + strings.Repeat("a", 1<<20)); got != nil {
		t.Fatalf("prefilter: %v", got)
	}
}

func BenchmarkLifecycleKinds(b *testing.B) {
	raw := hugeRaw(strings.Repeat("x", 5<<20), "")
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if len(lifecycleKinds(raw)) != 1 {
			b.Fatal("no commit")
		}
	}
}

func hexSum(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestWorktreeBalancedAndMinimalRedaction(t *testing.T) {
	full := loadWorktreeFixture(t)
	for _, mode := range []privacy.Mode{privacy.ModeBalanced, privacy.ModeMinimal} {
		t.Run(string(mode), func(t *testing.T) {
			var red []event.Event
			wantPaths := map[string]map[string]bool{}
			for _, ev := range full {
				r := privacy.Redact(ev, mode)
				red = append(red, r)
				if r.WorktreeID != "" {
					if wantPaths[r.WorktreeID] == nil {
						wantPaths[r.WorktreeID] = map[string]bool{}
					}
					if r.Category != event.CategoryMeta {
						for _, p := range EventFilePaths(r) {
							wantPaths[r.WorktreeID][p] = true
						}
					}
				}
			}
			rows := foldProjection(red).Worktrees()
			if len(rows) != 3 {
				t.Fatalf("rows=%d", len(rows))
			}
			signal, meta := 0, 0
			for _, raw := range []string{"/work/alpha", "/work/alpha-feat", "/work/beta-fix"} {
				r := worktreeRow(t, rows, hexSum(raw))
				signal += r.SignalEvents
				meta += r.MetaEvents
				if len(r.Marks) != 0 || r.MarksTotal != 0 {
					t.Errorf("%s: marks outside full mode: %+v", raw, r.Marks)
				}
				if r.PathsTotal != len(wantPaths[r.WorktreeID]) {
					t.Errorf("%s: paths_total=%d, want %d (%v)", raw, r.PathsTotal, len(wantPaths[r.WorktreeID]), r.Paths)
				}
				for _, p := range r.Paths {
					if !wantPaths[r.WorktreeID][p] {
						t.Errorf("%s: unexpected path %q", raw, p)
					}
				}
			}
			if signal != 41 || meta != 50 {
				t.Errorf("signal=%d meta=%d", signal, meta)
			}
			if mode == privacy.ModeBalanced {
				long := false
				for _, r := range rows {
					for _, p := range r.Paths {
						if strings.HasSuffix(p, "…") && len([]rune(p)) == 241 {
							long = true
						}
					}
				}
				if !long {
					t.Error("balanced mode should hold the >240 rune path truncated")
				}
			}
		})
	}
}

func shuffled(evs []event.Event, seed int64) []event.Event {
	out := append([]event.Event(nil), evs...)
	rand.New(rand.NewSource(seed)).Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

func TestWorktreeFoldIsOrderIndependentAndDeduped(t *testing.T) {
	evs := loadWorktreeFixture(t)
	rev := make([]event.Event, len(evs))
	for i, ev := range evs {
		rev[len(evs)-1-i] = ev
	}
	want := foldProjection(evs).Worktrees()
	for name, order := range map[string][]event.Event{"reverse": rev, "shuffle": shuffled(evs, 7)} {
		if got := foldProjection(order).Worktrees(); !reflect.DeepEqual(got, want) {
			t.Errorf("%s order differs:\n got=%+v\nwant=%+v", name, got, want)
		}
	}
	twice := foldProjection(append(append([]event.Event(nil), evs...), evs...))
	if got := twice.Worktrees(); !reflect.DeepEqual(got, want) {
		t.Errorf("replay changed counts")
	}
	ix := foldProjection(evs)
	rows := ix.Worktrees()
	rows[0].Paths = append(rows[0].Paths, "mutated")
	rows[0].Marks = append(rows[0].Marks[:0], WorktreeMark{Kind: "x"})
	rows[0].Sessions[0].Events = 999
	if got := ix.Worktrees(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutating results leaked into projection")
	}
	one, _ := ix.Worktree(rows[0].WorktreeID)
	one.Paths[0] = "mutated"
	if got := ix.Worktrees(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutating Worktree() leaked into projection")
	}
	if rows := New().Worktrees(); rows == nil || len(rows) != 0 {
		t.Errorf("empty projection must return non-nil empty slice, got %#v", rows)
	}
}

func TestWorktreeBoundsAndCaps(t *testing.T) {
	d := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	var marks, paths, sessions []event.Event
	for i := 0; i < 250; i++ {
		marks = append(marks, bashEvent(fmt.Sprintf("c%03d", i), d.Add(time.Duration(i)*time.Minute), "PostToolUse:Bash", "s", "git commit -m x"))
	}
	for i := 0; i < 700; i++ {
		e := wtEvent(fmt.Sprintf("p%03d", i), d.Add(time.Duration(i)*time.Second), event.CategoryFile, "s")
		e.Payload = map[string]any{"file_path": fmt.Sprintf("/r/f%04d.go", (i*37)%700)}
		paths = append(paths, e)
	}
	for i := 0; i < 250; i++ {
		sessions = append(sessions, wtEvent(fmt.Sprintf("x%03d", i), d.Add(time.Duration(i)*time.Minute), event.CategoryTool, fmt.Sprintf("sess-%03d", i)))
	}
	rev := func(evs []event.Event) []event.Event {
		out := make([]event.Event, len(evs))
		for i, e := range evs {
			out[len(evs)-1-i] = e
		}
		return out
	}
	r := worktreeRow(t, foldProjection(marks).Worktrees(), "/r")
	if len(r.Marks) != 200 || r.MarksTotal != 250 || r.Marks[0].EventID != "c050" || r.Marks[199].EventID != "c249" {
		t.Errorf("marks len=%d total=%d first=%s", len(r.Marks), r.MarksTotal, r.Marks[0].EventID)
	}
	if rr := worktreeRow(t, foldProjection(rev(marks)).Worktrees(), "/r"); !reflect.DeepEqual(rr, r) {
		t.Error("marks cap depends on order")
	}
	r = worktreeRow(t, foldProjection(paths).Worktrees(), "/r")
	if len(r.Paths) != 500 || r.PathsTotal != 700 || r.Paths[0] != "/r/f0000.go" || r.Paths[499] != "/r/f0499.go" {
		t.Errorf("paths len=%d total=%d first=%s last=%s", len(r.Paths), r.PathsTotal, r.Paths[0], r.Paths[len(r.Paths)-1])
	}
	r = worktreeRow(t, foldProjection(sessions).Worktrees(), "/r")
	if len(r.Sessions) != 200 || r.SessionsTotal != 250 || r.Sessions[0].SessionID != "sess-050" || r.Sessions[199].SessionID != "sess-249" {
		t.Errorf("sessions len=%d total=%d first=%s", len(r.Sessions), r.SessionsTotal, r.Sessions[0].SessionID)
	}
	if rr := worktreeRow(t, foldProjection(rev(sessions)).Worktrees(), "/r"); !reflect.DeepEqual(rr, r) {
		t.Error("session cap depends on order")
	}
	// The same session id under two sources is two sessions.
	a, b := wtEvent("a", d, event.CategoryTool, "same"), wtEvent("b", d, event.CategoryTool, "same")
	b.Source = "codex"
	if r := worktreeRow(t, foldProjection([]event.Event{a, b}).Worktrees(), "/r"); r.SessionsTotal != 2 {
		t.Errorf("sessions_total=%d, want 2", r.SessionsTotal)
	}
}

func TestBuildEquivalenceCoversWorktrees(t *testing.T) {
	data, err := os.ReadFile(worktreeFixture)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("one day file", func(t *testing.T) {
		dir := t.TempDir()
		writeDayFile(t, dir, "2026-10-30", data)
		assertBuildEquivalent(t, dir)
		ix, err := Build(dir)
		if err != nil || len(ix.Worktrees()) != 3 {
			t.Fatalf("Build rows=%d err=%v", len(ix.Worktrees()), err)
		}
	})
	lines := strings.SplitAfter(string(data), "\n")
	half := len(lines) / 2
	t.Run("split across two day files", func(t *testing.T) {
		dir := t.TempDir()
		writeDayFile(t, dir, "2026-10-30", []byte(strings.Join(lines[:half], "")))
		writeDayFile(t, dir, "2026-10-31", []byte(strings.Join(lines[half:], "")))
		assertBuildEquivalent(t, dir)
	})
	t.Run("duplicates re-appended", func(t *testing.T) {
		dir := t.TempDir()
		writeDayFile(t, dir, "2026-10-30", data)
		writeDayFile(t, dir, "2026-10-31", []byte(strings.Join(lines[:half], "")))
		assertBuildEquivalent(t, dir)
		ix, _ := Build(dir)
		if !reflect.DeepEqual(ix.Worktrees(), foldProjection(loadWorktreeFixture(t)).Worktrees()) {
			t.Error("duplicate records changed the worktree view")
		}
	})
	_ = filepath.Join
}

// Codex apply_patch names its paths only in the patch text and the result text;
// the worktree lifetime must read them from the real captured shapes.
func TestWorktreeReadsApplyPatchPathsFromCapturedShapes(t *testing.T) {
	f, err := os.Open("../../testdata/activity_apply_patch_shapes.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var evs []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		var ev event.Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatal(err)
		}
		evs = append(evs, ev)
	}
	rows := foldProjection(evs).Worktrees()
	if len(rows) == 0 {
		t.Fatal("no worktree rows")
	}
	total := 0
	var all []string
	for _, r := range rows {
		total += r.PathsTotal
		all = append(all, r.Paths...)
		if len(r.Paths) != r.PathsTotal {
			t.Errorf("paths=%v total=%d", r.Paths, r.PathsTotal)
		}
	}
	if total == 0 {
		t.Fatal("apply_patch events produced paths_total 0")
	}
	found := false
	for _, p := range all {
		found = found || p == "/work/proj/test_support/tab_client.exs"
	}
	if !found {
		t.Errorf("patch header path missing from %v", all)
	}
}

// D95: only the signal allowlist counts. Message-only history makes no row and
// moves nothing; meta stays separate.
func TestWorktreeMessageIsNeitherSignalNorMeta(t *testing.T) {
	d := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	msg := wtEvent("g1", d, event.CategoryMessage, "chat")
	if rows := foldProjection([]event.Event{msg}).Worktrees(); len(rows) != 0 {
		t.Fatalf("message-only history made rows: %+v", rows)
	}
	sig := wtEvent("g2", d.Add(time.Hour), event.CategoryTool, "work")
	late := wtEvent("g3", d.Add(5*time.Hour), event.CategoryMessage, "chat")
	r := worktreeRow(t, foldProjection([]event.Event{msg, sig, late}).Worktrees(), "/r")
	if r.SignalEvents != 1 || r.MetaEvents != 0 || r.SessionsTotal != 1 || !r.LastTime.Equal(d.Add(time.Hour)) {
		t.Errorf("message counted: %+v", r)
	}
}

// Past the memory guard the set keeps the smallest paths, so a lexically
// smaller late path still appears, in any order, and saturation is reported.
func TestWorktreePathGuardKeepsSmallestAndReportsSaturation(t *testing.T) {
	d := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	var evs []event.Event
	for i := 0; i < maxWorktreePathGuard+10; i++ {
		e := wtEvent(fmt.Sprintf("p%05d", i), d.Add(time.Duration(i)*time.Second), event.CategoryFile, "s")
		e.Payload = map[string]any{"file_path": fmt.Sprintf("/r/f%06d.go", i+1000)}
		evs = append(evs, e)
	}
	small := wtEvent("small", d.Add(24*time.Hour), event.CategoryFile, "s")
	small.Payload = map[string]any{"file_path": "/r/a-smallest.go"}
	evs = append(evs, small)
	r := worktreeRow(t, foldProjection(evs).Worktrees(), "/r")
	if r.Paths[0] != "/r/a-smallest.go" || len(r.Paths) != maxWorktreePaths || r.PathsTotal != maxWorktreePathGuard || !r.PathsSaturated {
		t.Errorf("first=%s len=%d total=%d saturated=%v", r.Paths[0], len(r.Paths), r.PathsTotal, r.PathsSaturated)
	}
	rev := make([]event.Event, len(evs))
	for i, e := range evs {
		rev[len(evs)-1-i] = e
	}
	if rr := worktreeRow(t, foldProjection(rev).Worktrees(), "/r"); !reflect.DeepEqual(rr, r) {
		t.Error("guarded path set depends on order")
	}
	exact := worktreeRow(t, foldProjection(evs[:maxWorktreePathGuard]).Worktrees(), "/r")
	if exact.PathsSaturated || exact.PathsTotal != maxWorktreePathGuard {
		t.Errorf("exactly the guard is not saturated: %+v", exact.PathsTotal)
	}
}

// Skipped branches and uncalled function bodies run nothing, so they leave no
// mark; commands that did run still do.
func TestLifecycleSkipsUnestablishedExecution(t *testing.T) {
	bash := func(cmd string) string {
		b, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": cmd}})
		return string(b)
	}
	cases := []struct {
		name, cmd string
		want      []string
	}{
		{"if false then merge", "if false; then gh pr merge 3; fi", nil},
		{"else branch", "if true; then :; else git push; fi", nil},
		{"elif branch", "if true; then :; elif x; then git commit -m x; fi", nil},
		{"if condition runs", "if git commit -m x; then echo ok; fi", []string{"commit"}},
		{"for body", "for f in a; do git commit -m $f; done", nil},
		{"while body", "while false; do git push; done", nil},
		{"case arm", "case x in y) git commit -m x;; esac", nil},
		{"function body not called", "f() { git commit -m x; }; echo hi", nil},
		{"function body one line", "f() { git push; }", nil},
		{"function keyword", "function f { git push; }\ntrue", nil},
		{"function keyword parens", "function f() {\n git push\n}\ngit commit -m x", []string{"commit"}},
		{"after function", "f() { git push; }; git commit -m x", []string{"commit"}},
		{"brace group runs", "{ git commit -m x; }", []string{"commit"}},
		{"subshell runs", "(cd x && git commit -m x)", []string{"commit"}},
		{"and in earlier list", "false && git commit -m x; true", nil},
		{"and in final list", "git add . && git commit -m x", []string{"commit"}},
		{"or fallback", "false || git commit -m x", nil},
		{"or in earlier list", "a || b; git push", []string{"push"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := lifecycleKinds(bash(c.cmd)); !reflect.DeepEqual(got, c.want) {
				t.Errorf("lifecycleKinds(%q)=%v, want %v", c.cmd, got, c.want)
			}
		})
	}
}

// Only a plain `gh pr merge` that targets the current branch, as the command's
// last step, is a verified self-merge.
func TestLifecycleSelfMerge(t *testing.T) {
	bash := func(cmd string) string {
		b, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": cmd}})
		return string(b)
	}
	cases := []struct {
		cmd  string
		want bool
	}{
		{"gh pr merge --squash --delete-branch", true},
		{"git push && gh pr merge --squash", true},
		{"gh pr merge -t 'a title' -d", true},
		{"gh -R o/r pr merge --squash", true},
		{"gh pr merge 123", false},
		{"gh pr merge https://github.com/o/r/pull/9", false},
		{"gh pr merge some-branch --squash", false},
		{"gh pr merge --auto --squash", false},
		{"gh pr merge --squash || true", false},
		{"gh pr merge --squash; echo done", false},
		{"gh pr merge --squash &", false},
		{"! gh pr merge --squash", false},
		{"if false; then gh pr merge --squash; fi", false},
		{"gh pr merge --dry-run", false},
		{"git commit -m x", false},
	}
	for _, c := range cases {
		if _, got := lifecycle(bash(c.cmd)); got != c.want {
			t.Errorf("selfMerge(%q)=%v, want %v", c.cmd, got, c.want)
		}
	}
}

// Classification evidence is kept apart from the capped marks list: a commit
// followed by 300 pushes still reports its commit time.
func TestWorktreeEvidenceSurvivesMarkCap(t *testing.T) {
	d := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	evs := []event.Event{
		bashEvent("c", d, "PostToolUse:Bash", "s", "git commit -m x"),
		bashEvent("m", d.Add(time.Minute), "PostToolUse:Bash", "s", "gh pr merge --squash"),
		bashEvent("other", d.Add(2*time.Minute), "PostToolUse:Bash", "s", "gh pr merge 77"),
	}
	for i := 0; i < 300; i++ {
		evs = append(evs, bashEvent(fmt.Sprintf("p%03d", i), d.Add(time.Hour+time.Duration(i)*time.Minute), "PostToolUse:Bash", "s", "git push"))
	}
	r := worktreeRow(t, foldProjection(evs).Worktrees(), "/r")
	for _, m := range r.Marks {
		if m.Kind == "commit" {
			t.Fatal("commit mark should have left the capped list")
		}
	}
	if !r.LastCommitMark.Equal(d) || !r.LastMergeMark.Equal(d.Add(time.Minute)) {
		t.Errorf("evidence commit=%v merge=%v", r.LastCommitMark, r.LastMergeMark)
	}
}
