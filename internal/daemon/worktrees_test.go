package daemon

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/testsupport/capturehistory"
)

func wtGet(t *testing.T, s *Server, method, path string, hdr ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w
}

func wtList(t *testing.T, s *Server) []map[string]any {
	t.Helper()
	w := wtGet(t, s, http.MethodGet, "/worktrees")
	if w.Code != 200 {
		t.Fatalf("GET /worktrees = %d %s", w.Code, w.Body)
	}
	var rows []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode: %v %s", err, w.Body)
	}
	return rows
}

func wtRow(t *testing.T, rows []map[string]any, label string) map[string]any {
	t.Helper()
	for _, r := range rows {
		if r["label"] == label || r["worktree_id"] == label {
			return r
		}
	}
	t.Fatalf("no row labelled %q in %v", label, rows)
	return nil
}

func wtDetail(t *testing.T, s *Server, id string) map[string]any {
	t.Helper()
	w := wtGet(t, s, http.MethodGet, "/worktrees/"+strings.ReplaceAll(strings.ReplaceAll(id, "%", "%25"), "/", "%2F"))
	if w.Code != 200 {
		t.Fatalf("GET detail %q = %d %s", id, w.Code, w.Body)
	}
	var d map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func fixtureEvents(t *testing.T) []event.Event {
	t.Helper()
	return fixtureEventsFrom(t, "../capture/testdata/worktrees_full.ndjson")
}

func fixtureEventsFrom(t *testing.T, path string) []event.Event {
	t.Helper()
	f, err := os.Open(path)
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
	return out
}

func fullConfig(t *testing.T) cli.Config {
	cfg := testConfig(t)
	cfg.PrivacyMode = "full"
	cfg.DaemonAddr = "127.0.0.1:0"
	return cfg
}

func TestWorktreesRouteFixtureWithoutGraph(t *testing.T) {
	cfg := fullConfig(t)
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	for _, ev := range fixtureEvents(t) {
		if _, err := w.Append(ev); err != nil {
			t.Fatal(err)
		}
	}
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	rec := wtGet(t, s, http.MethodGet, "/worktrees")
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("headers: %d %v", rec.Code, rec.Header())
	}
	rows := wtList(t, s)
	if len(rows) != 3 {
		t.Fatalf("rows = %d", len(rows))
	}
	want := map[string][3]float64{ // signal, meta, marks
		"/work/alpha":      {19, 12, 3},
		"/work/alpha-feat": {12, 30, 4},
		"/work/beta-fix":   {10, 8, 3},
	}
	keys := []string{"repo_id", "worktree_id", "first_time", "last_time", "sessions", "sessions_total", "paths", "paths_total", "signal_events", "meta_events", "marks", "marks_total", "marks_available", "state", "state_reason"}
	sort.Strings(keys)
	var last string
	for _, r := range rows {
		id := r["worktree_id"].(string)
		c, ok := want[id]
		if !ok {
			t.Fatalf("unexpected worktree %q", id)
		}
		delete(want, id)
		if r["signal_events"] != c[0] || r["meta_events"] != c[1] || r["marks_total"] != c[2] || len(r["marks"].([]any)) != int(c[2]) {
			t.Fatalf("%s counts: %v", id, r)
		}
		if r["state"] != "unknown" || r["state_reason"] != "repo_unregistered" || r["marks_available"] != true {
			t.Fatalf("%s state: %v", id, r)
		}
		got := make([]string, 0, len(r))
		for k := range r {
			got = append(got, k)
		}
		sort.Strings(got)
		if !reflect.DeepEqual(got, keys) {
			t.Fatalf("%s key set %v want %v", id, got, keys)
		}
		if lt := r["last_time"].(string); last != "" && lt > last {
			t.Fatalf("not ordered by last_time desc: %s after %s", lt, last)
		} else {
			last = lt
		}
		for _, sv := range r["sessions"].([]any) {
			if sv.(map[string]any)["source"] != "claude-code" {
				t.Fatalf("session without source: %v", sv)
			}
		}
	}
	// Empty spool -> [].
	empty := fullConfig(t)
	es := New(testEngine(t, empty), empty, t.TempDir(), "test")
	if body := strings.TrimSpace(wtGet(t, es, http.MethodGet, "/worktrees").Body.String()); body != "[]" {
		t.Fatalf("empty body = %q", body)
	}
}

func TestWorktreeDetailRoute(t *testing.T) {
	cfg := fullConfig(t)
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	for _, ev := range fixtureEvents(t) {
		if _, err := w.Append(ev); err != nil {
			t.Fatal(err)
		}
	}
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	rec := wtGet(t, s, http.MethodGet, "/worktrees/%2Fwork%2Falpha-feat")
	if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-store" || !strings.Contains(rec.Body.String(), `"commits":[]`) {
		t.Fatalf("detail: %d %v %s", rec.Code, rec.Header(), rec.Body)
	}
	d := wtDetail(t, s, "/work/alpha-feat")
	if d["worktree_id"] != "/work/alpha-feat" || d["signal_events"] != float64(12) || d["meta_events"] != float64(30) {
		t.Fatalf("detail row: %v", d)
	}
	nf := wtGet(t, s, http.MethodGet, "/worktrees/nope")
	if nf.Code != 404 || strings.TrimSpace(nf.Body.String()) != "worktree not found" {
		t.Fatalf("404: %d %q", nf.Code, nf.Body)
	}
	if p := wtGet(t, s, http.MethodPost, "/worktrees/%2Fwork%2Falpha-feat"); p.Code != 405 {
		t.Fatalf("POST detail = %d", p.Code)
	}
	if p := wtGet(t, s, http.MethodPost, "/worktrees"); p.Code != 405 {
		t.Fatalf("POST list = %d", p.Code)
	}
	for _, path := range []string{"/worktrees", "/worktrees/%2Fwork%2Falpha-feat"} {
		if o := wtGet(t, s, http.MethodGet, path, "Origin", "https://attacker.example"); o.Code != 403 {
			t.Fatalf("origin %s = %d", path, o.Code)
		}
	}
}

// admitSession writes a session of three signal events spanning [start, end]
// with cwd set, so Capture stamps the real repo/worktree identity.
func admitSession(t *testing.T, a interface {
	Append(event.Event) (event.Event, error)
}, id, cwd, start, end string) {
	t.Helper()
	st, _ := time.Parse(time.RFC3339, start)
	en, _ := time.Parse(time.RFC3339, end)
	for i, at := range []time.Time{st, st.Add(en.Sub(st) / 2), en} {
		if _, err := a.Append(event.Event{
			ID: id + "-" + string(rune('a'+i)), Time: at, Source: "claude-code", SessionID: id,
			Category: event.CategoryTool, Name: "PostToolUse:Read", Summary: "read", CWD: cwd,
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func admitForkSessions(t *testing.T, a interface {
	Append(event.Event) (event.Event, error)
}, f *worktreeGitFixture) {
	admitSession(t, a, "sess-landed", f.Wt["feat-landed"], "2026-10-31T09:55:00Z", "2026-10-31T10:20:00Z")
	admitSession(t, a, "sess-open-a", f.Wt["feat-open"], "2026-10-31T11:00:00Z", "2026-10-31T11:20:00Z")
	admitSession(t, a, "sess-open-b", f.Wt["feat-open"], "2026-10-31T11:30:00Z", "2026-10-31T11:50:00Z")
	admitSession(t, a, "sess-abandoned", f.Wt["feat-abandoned"], "2026-10-31T12:10:00Z", "2026-10-31T12:30:00Z")
}

func TestWorktreesHandlersAreReadOnly(t *testing.T) {
	f := newWorktreeGitFixture(t)
	cfg := fullConfig(t)
	admitForkSessions(t, capturehistory.NewAdmitter(cfg.SpoolDir), f)
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	registerFixture(t, s, f.Main)

	rows := wtList(t, s)
	row := wtRow(t, rows, f.Wt["feat-open"])
	if row["state"] != "unknown" {
		t.Fatalf("before observation: %v", row)
	}
	d := wtDetail(t, s, f.Wt["feat-open"])
	if d["state"] != "unknown" || len(d["commits"].([]any)) != 0 {
		t.Fatalf("detail before observation: %v", d)
	}
	if _, err := os.Stat(worktreeStatesPath(home)); !os.IsNotExist(err) {
		t.Fatalf("handlers must not create the state file: %v", err)
	}
	if s.worktrees.compareCalls != 0 || s.worktrees.detailCompares.Load() != 0 {
		t.Fatalf("handlers ran compare: %d %d", s.worktrees.compareCalls, s.worktrees.detailCompares.Load())
	}

	s.observeWorktrees(t.Context())
	before, _ := os.ReadFile(worktreeStatesPath(home))
	info, _ := os.Stat(worktreeStatesPath(home))
	calls := s.worktrees.compareCalls
	if wtRow(t, wtList(t, s), f.Wt["feat-open"])["state"] != "open" {
		t.Fatal("expected open after observation")
	}
	wtDetail(t, s, f.Wt["feat-open"])
	after, _ := os.ReadFile(worktreeStatesPath(home))
	info2, _ := os.Stat(worktreeStatesPath(home))
	if string(before) != string(after) || !info.ModTime().Equal(info2.ModTime()) || s.worktrees.compareCalls != calls {
		t.Fatal("handlers must not write or compare through the observer")
	}
}

func TestWorktreesJoinRealGitFork(t *testing.T) {
	f := newWorktreeGitFixture(t)
	cfg := fullConfig(t)
	admitForkSessions(t, capturehistory.NewAdmitter(cfg.SpoolDir), f)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	registerFixture(t, s, f.Main)
	refreshObserve(t, s)

	row := wtRow(t, wtList(t, s), f.Wt["feat-open"])
	head := f.git(f.Wt["feat-open"], "", "rev-parse", "HEAD")
	if row["state"] != "open" || row["ahead"] != float64(2) || row["behind"] != float64(0) || row["dirty"] != true ||
		row["default_target_ref"] != "main" || row["head"] != head || row["repo_id"] != f.Common || row["worktree_id"] != f.Wt["feat-open"] {
		t.Fatalf("open row: %v", row)
	}
	if _, has := row["outcome"]; has {
		t.Fatalf("outcome only when gone: %v", row)
	}
	if _, err := time.Parse(time.RFC3339, row["last_observed"].(string)); err != nil {
		t.Fatalf("last_observed: %v", row)
	}
	if row["sessions_total"] != float64(2) {
		t.Fatalf("sessions: %v", row)
	}
	for _, r := range wtList(t, s) {
		if r["label"] == f.Wt["feat-idle"] {
			t.Fatal("idle has no events and must not be listed")
		}
	}
}

func TestWorktreesJoinRealGitForkLifecycle(t *testing.T) {
	f := newWorktreeGitFixture(t)
	cfg := fullConfig(t)
	admitForkSessions(t, capturehistory.NewAdmitter(cfg.SpoolDir), f)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	registerFixture(t, s, f.Main)
	refreshObserve(t, s)

	d := wtDetail(t, s, f.Wt["feat-open"])
	commits := d["commits"].([]any)
	if len(commits) != 2 {
		t.Fatalf("commits: %v", commits)
	}
	c0, c1 := commits[0].(map[string]any), commits[1].(map[string]any)
	if c0["time"] != "2026-10-31T11:40:00Z" || c1["time"] != "2026-10-31T11:10:00Z" ||
		c0["session_id"] != "sess-open-b" || c1["session_id"] != "sess-open-a" ||
		c0["attribution"] != "time_join" || c0["subject"] != "add open2.txt" || len(c0["commit_id"].(string)) != 40 {
		t.Fatalf("commits: %v", commits)
	}
	if got := s.worktrees.detailCompares.Load(); got != 1 {
		t.Fatalf("detail compares = %d", got)
	}
	// A list never carries commits.
	if _, has := wtRow(t, wtList(t, s), f.Wt["feat-open"])["commits"]; has {
		t.Fatal("list item must not contain commits")
	}
	// A commit outside every session window has no session_id.
	f.commit(f.Wt["feat-open"], "late.txt", "2026-10-31T13:00:00Z")
	refreshObserve(t, s)
	d = wtDetail(t, s, f.Wt["feat-open"])
	late := d["commits"].([]any)[0].(map[string]any)
	if late["time"] != "2026-10-31T13:00:00Z" || late["attribution"] != "time_join" {
		t.Fatalf("late: %v", late)
	}
	if _, has := late["session_id"]; has {
		t.Fatalf("late commit must be unattributed: %v", late)
	}
	// Non-open worktrees get an empty array.
	if idle := wtDetail(t, s, f.Wt["feat-landed"]); idle["state"] != "open" {
		t.Fatalf("landed branch is still open before merge: %v", idle)
	}

	f.git(f.Main, "2026-10-31T13:30:00Z", "merge", "-q", "--ff-only", "feat-landed")
	refreshObserve(t, s)
	landed := wtDetail(t, s, f.Wt["feat-landed"])
	if landed["state"] != "landed" || len(landed["commits"].([]any)) != 0 || !strings.Contains(mustJSON(t, landed), `"commits":[]`) {
		t.Fatalf("landed: %v", landed)
	}
	f.git(f.Main, "", "worktree", "remove", "--force", f.Wt["feat-abandoned"])
	f.git(f.Main, "", "worktree", "remove", "--force", f.Wt["feat-landed"])
	refreshObserve(t, s)
	rows := wtList(t, s)
	if r := wtRow(t, rows, f.Wt["feat-abandoned"]); r["state"] != "gone" || r["outcome"] != "abandoned" {
		t.Fatalf("abandoned: %v", r)
	}
	if r := wtRow(t, rows, f.Wt["feat-landed"]); r["state"] != "gone" || r["outcome"] != "landed" {
		t.Fatalf("gone landed: %v", r)
	}
}

func mustJSON(t *testing.T, v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestWorktreesMergeAcrossPrivacyModes(t *testing.T) {
	f := newWorktreeGitFixture(t)
	cfg := fullConfig(t)
	a := capturehistory.NewAdmitter(cfg.SpoolDir)
	admitSession(t, a, "sess-full", f.Wt["feat-open"], "2026-10-31T11:00:00Z", "2026-10-31T11:20:00Z")
	if _, err := a.Append(event.Event{
		ID: "mark-1", Time: mustTime("2026-10-31T11:10:00Z"), Source: "claude-code", SessionID: "sess-full",
		Category: event.CategoryShell, Name: "PostToolUse:Bash", Summary: "ran shell tool", CWD: f.Wt["feat-open"],
		Raw: `{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"}}`,
	}); err != nil {
		t.Fatal(err)
	}
	// Unresolvable history in both modes stays separate.
	for _, ev := range []event.Event{
		{ID: "g1", Time: mustTime("2026-10-31T08:00:00Z"), Source: "claude-code", SessionID: "ghost", Category: event.CategoryTool, Name: "PostToolUse:Read", Summary: "r", RepoID: "/gone/repo/.git", WorktreeID: "/gone/wt"},
	} {
		if _, err := a.Append(ev); err != nil {
			t.Fatal(err)
		}
	}

	bal := cfg
	bal.PrivacyMode = "balanced"
	engine := testEngine(t, bal)
	ghost := event.Event{ID: "g2", Time: mustTime("2026-10-31T08:30:00Z"), Source: "claude-code", SessionID: "ghost2", Category: event.CategoryTool, Name: "PostToolUse:Read", Summary: "r", RepoID: "/gone/repo/.git", WorktreeID: "/gone/wt"}
	if _, err := engine.Admit(t.Context(), ghost); err != nil {
		t.Fatal(err)
	}
	for i, at := range []string{"2026-10-31T11:30:00Z", "2026-10-31T11:45:00Z"} {
		if _, err := engine.Admit(t.Context(), event.Event{
			ID: "bal-" + string(rune('a'+i)), Time: mustTime(at), Source: "claude-code", SessionID: "sess-bal",
			Category: event.CategoryTool, Name: "PostToolUse:Read", Summary: "read", CWD: f.Wt["feat-open"],
		}); err != nil {
			t.Fatal(err)
		}
	}
	s := New(engine, bal, t.TempDir(), "test")
	registerFixture(t, s, f.Main)
	refreshObserve(t, s)

	rows := wtList(t, s)
	if len(rows) != 3 {
		t.Fatalf("want merged row + 2 mode-segmented ghosts, got %d: %v", len(rows), rows)
	}
	row := wtRow(t, rows, f.Wt["feat-open"])
	if row["worktree_id"] != sha(f.Wt["feat-open"]) || row["repo_id"] != sha(f.Common) {
		t.Fatalf("ids must be current-mode form: %v", row)
	}
	if row["sessions_total"] != float64(2) || row["signal_events"] != float64(6) || row["marks_total"] != float64(1) || row["marks_available"] != true || row["state"] != "open" {
		t.Fatalf("merged: %v", row)
	}
	if len(row["marks"].([]any)) != 1 || row["first_time"] != "2026-10-31T11:00:00Z" || row["last_time"] != "2026-10-31T11:45:00Z" {
		t.Fatalf("marks/times: %v", row)
	}
	// Every alias reaches the same row.
	for _, id := range []string{f.Wt["feat-open"], sha(f.Wt["feat-open"])} {
		if d := wtDetail(t, s, id); d["label"] != f.Wt["feat-open"] || d["signal_events"] != float64(6) {
			t.Fatalf("alias %q: %v", id, d)
		}
	}
	ghosts := 0
	for _, r := range rows {
		if r["label"] == nil {
			ghosts++
		}
	}
	if ghosts != 2 {
		t.Fatalf("ghost rows = %d", ghosts)
	}
}

func mustTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestWorktreesJoinMatchesDigestedIdentitiesInBalancedMode(t *testing.T) {
	f := newWorktreeGitFixture(t)
	cfg := testConfig(t)
	cfg.PrivacyMode = "balanced"
	engine := testEngine(t, cfg)
	for i, at := range []string{"2026-10-31T11:00:00Z", "2026-10-31T11:20:00Z"} {
		if _, err := engine.Admit(t.Context(), event.Event{
			ID: "b-" + string(rune('a'+i)), Time: mustTime(at), Source: "claude-code", SessionID: "sess-b",
			Category: event.CategoryTool, Name: "PostToolUse:Read", Summary: "read", CWD: f.Wt["feat-open"],
		}); err != nil {
			t.Fatal(err)
		}
	}
	s := New(engine, cfg, t.TempDir(), "test")
	registerFixture(t, s, f.Main)
	refreshObserve(t, s)
	rows := wtList(t, s)
	if len(rows) != 1 {
		t.Fatalf("rows: %v", rows)
	}
	row := rows[0]
	id, repo := row["worktree_id"].(string), row["repo_id"].(string)
	if row["state"] != "open" || row["ahead"] != float64(2) || row["label"] != f.Wt["feat-open"] || len(id) != 64 || len(repo) != 64 {
		t.Fatalf("balanced row: %v", row)
	}
	if strings.Contains(id+repo, f.Main) || strings.Contains(id+repo, "feat-open") {
		t.Fatalf("raw path in ids: %s %s", id, repo)
	}
	d := wtDetail(t, s, id)
	if len(d["commits"].([]any)) != 2 {
		t.Fatalf("detail commits: %v", d["commits"])
	}
}

func TestAttributeCommitTimeJoin(t *testing.T) {
	at := func(s string) time.Time { return mustTime("2026-10-31T" + s + "Z") }
	sess := func(id, a, b string) capture.WorktreeSession {
		return capture.WorktreeSession{Source: "claude-code", SessionID: id, FirstTime: at(a), LastTime: at(b)}
	}
	cases := []struct {
		name     string
		sessions []capture.WorktreeSession
		at       time.Time
		want     string
	}{
		{"one window", []capture.WorktreeSession{sess("a", "11:00:00", "11:20:00")}, at("11:10:00"), "a"},
		{"overlapping picks greatest first_time", []capture.WorktreeSession{sess("a", "11:00:00", "11:30:00"), sess("b", "11:10:00", "11:40:00")}, at("11:20:00"), "b"},
		{"overlap, later not yet started", []capture.WorktreeSession{sess("a", "11:00:00", "11:30:00"), sess("b", "11:25:00", "11:40:00")}, at("11:20:00"), "a"},
		{"inside trailing grace", []capture.WorktreeSession{sess("a", "11:00:00", "11:20:00")}, at("11:28:00"), "a"},
		{"after grace", []capture.WorktreeSession{sess("a", "11:00:00", "11:20:00")}, at("11:30:01"), ""},
		{"before all", []capture.WorktreeSession{sess("a", "11:00:00", "11:20:00")}, at("10:59:59"), ""},
		{"empty", nil, at("11:00:00"), ""},
		{"inclusive first_time", []capture.WorktreeSession{sess("a", "11:00:00", "11:20:00")}, at("11:00:00"), "a"},
		{"inclusive last_time+grace", []capture.WorktreeSession{sess("a", "11:00:00", "11:20:00")}, at("11:30:00"), "a"},
		{"tie breaks on source then id", []capture.WorktreeSession{sess("z", "11:00:00", "11:20:00"), sess("m", "11:00:00", "11:20:00")}, at("11:10:00"), "m"},
	}
	for _, c := range cases {
		if got := attributeCommit(c.sessions, c.at); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestWorktreesHandlersHoldGraphResponseGate(t *testing.T) {
	cfg := fullConfig(t)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	for _, path := range []string{"/worktrees", "/worktrees/x"} {
		s.graphResponseMu.Lock()
		done := make(chan struct{})
		go func() {
			wtGet(t, s, http.MethodGet, path)
			close(done)
		}()
		select {
		case <-done:
			t.Fatalf("%s answered while the gate was held", path)
		case <-time.After(100 * time.Millisecond):
		}
		s.graphResponseMu.Unlock()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s did not resume", path)
		}
	}
}

func TestDocsListWorktreeRoutes(t *testing.T) {
	read := func(p string) string {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	contracts := read("../../docs/contracts.md")
	claude := read("../../CLAUDE.md")
	for _, route := range []string{"GET /worktrees", "GET /worktrees/{id}"} {
		for name, doc := range map[string]string{"contracts.md": contracts, "CLAUDE.md": claude} {
			if !strings.Contains(doc, route) {
				t.Errorf("%s missing %q", name, route)
			}
		}
	}
	for _, w := range []string{"worktree-states.json", "time_join", "marks_available", "paths_total", "sessions_total",
		"primary_worktree", "compare_failed", "open", "landed", "never_diverged", "gone", "unknown",
		"squash", "mode-segmented", "gc", "shell tool: ", "D101"} {
		if !strings.Contains(contracts, w) {
			t.Errorf("contracts.md missing %q", w)
		}
	}
	if !strings.Contains(claude, "/worktrees[/{id}]") {
		t.Error("CLAUDE.md missing /worktrees[/{id}]")
	}
}

// summaryMarkRow admits one session in a worktree plus one PostToolUse:Bash
// event, observes the real git fork, then optionally removes the worktree, and
// returns its /worktrees row. mode "balanced" carries the lifecycle verb only
// in the summary; "full" carries it in Raw.
func summaryMarkRow(t *testing.T, mode, name string, remove bool, summary, raw string) map[string]any {
	t.Helper()
	f := newWorktreeGitFixture(t)
	cfg := fullConfig(t)
	cfg.PrivacyMode = mode
	engine := testEngine(t, cfg)
	cwd := f.Wt[name]
	for i, at := range []string{"2026-10-31T11:00:00Z", "2026-10-31T11:20:00Z"} {
		if _, err := engine.Admit(t.Context(), event.Event{
			ID: "w-" + string(rune('a'+i)), Time: mustTime(at), Source: "claude-code", SessionID: "sess-w",
			Category: event.CategoryTool, Name: "PostToolUse:Read", Summary: "read", CWD: cwd,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := engine.Admit(t.Context(), event.Event{
		ID: "w-mark", Time: mustTime("2026-10-31T11:10:00Z"), Source: "claude-code", SessionID: "sess-w",
		Category: event.CategoryShell, Name: "PostToolUse:Bash", Summary: summary, CWD: cwd, Raw: raw,
	}); err != nil {
		t.Fatal(err)
	}
	s := New(engine, cfg, t.TempDir(), "test")
	registerFixture(t, s, f.Main)
	refreshObserve(t, s)
	if remove {
		f.git(f.Main, "", "worktree", "remove", "--force", cwd)
		refreshObserve(t, s)
	}
	rows := wtList(t, s)
	if len(rows) != 1 {
		t.Fatalf("want one row, got %v", rows)
	}
	return rows[0]
}

func TestSummaryMarksDoNotFeedClassifier(t *testing.T) {
	// Balanced: a summary commit mark is display-only, so a gone worktree that
	// never diverged stays never_diverged.
	row := summaryMarkRow(t, "balanced", "feat-idle", true, "ran shell tool: git commit", "")
	if row["marks_total"] != float64(1) || row["marks_available"] != true || row["state"] != "gone" || row["outcome"] != "never_diverged" {
		t.Fatalf("balanced summary mark: %v", row)
	}
	// Same inputs with a full-mode raw commit are unchanged: landed.
	row = summaryMarkRow(t, "full", "feat-idle", true, "ran shell tool",
		`{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"}}`)
	if row["marks_total"] != float64(1) || row["state"] != "gone" || row["outcome"] != "landed" {
		t.Fatalf("full raw mark: %v", row)
	}
	// An open-by-ahead worktree stays open; a never-ahead one with only a
	// summary commit mark is not promoted to landed.
	row = summaryMarkRow(t, "balanced", "feat-idle", false, "ran shell tool: git commit", "")
	if row["state"] != "never_diverged" {
		t.Fatalf("open worktree with summary mark only: %v", row)
	}
	row = summaryMarkRow(t, "full", "feat-idle", false, "ran shell tool",
		`{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"}}`)
	if row["state"] != "landed" {
		t.Fatalf("full raw mark on idle worktree: %v", row)
	}
}

func TestMarksAvailableUnchangedSemantics(t *testing.T) {
	row := summaryMarkRow(t, "balanced", "feat-idle", false, "ran shell tool", "")
	if row["marks_total"] != float64(0) || row["marks_available"] != false {
		t.Fatalf("pre-change balanced history: %v", row)
	}
	row = summaryMarkRow(t, "balanced", "feat-idle", false, "ran shell tool: git commit", "")
	if row["marks_total"] != float64(1) || row["marks_available"] != true {
		t.Fatalf("suffixed balanced history: %v", row)
	}
	row = summaryMarkRow(t, "full", "feat-idle", false, "ran shell tool", "")
	if row["marks_total"] != float64(0) || row["marks_available"] != true {
		t.Fatalf("full mode: %v", row)
	}
}

// TestWorktreesRouteBalancedFixtureMarks serves the production balanced
// redaction of the fixture: the lifecycle verbs survive in the summary, so the
// marks (display-only) match full mode, with the same response key set.
func TestWorktreesRouteBalancedFixtureMarks(t *testing.T) {
	cfg := fullConfig(t)
	cfg.PrivacyMode = "balanced"
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	for _, ev := range fixtureEventsFrom(t, "../capture/testdata/worktrees_balanced.ndjson") {
		if _, err := w.Append(ev); err != nil {
			t.Fatal(err)
		}
	}
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	rows := wtList(t, s)
	if len(rows) != 3 {
		t.Fatalf("rows = %d", len(rows))
	}
	totals := []float64{}
	keys := []string{"repo_id", "worktree_id", "first_time", "last_time", "sessions", "sessions_total", "paths", "paths_total", "signal_events", "meta_events", "marks", "marks_total", "marks_available", "state", "state_reason"}
	sort.Strings(keys)
	for _, r := range rows {
		totals = append(totals, r["marks_total"].(float64))
		if len(r["marks"].([]any)) != int(r["marks_total"].(float64)) {
			t.Fatalf("marks length: %v", r)
		}
		if r["state"] != "unknown" || r["state_reason"] != "repo_unregistered" || r["marks_available"] != true {
			t.Fatalf("state: %v", r)
		}
		got := make([]string, 0, len(r))
		for k := range r {
			got = append(got, k)
		}
		sort.Strings(got)
		if !reflect.DeepEqual(got, keys) {
			t.Fatalf("key set %v want %v", got, keys)
		}
	}
	sort.Float64s(totals)
	if !reflect.DeepEqual(totals, []float64{3, 3, 4}) {
		t.Fatalf("marks_total = %v, want 3/4/3", totals)
	}
}
