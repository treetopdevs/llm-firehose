package capture

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func sha(s string) string { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:]) }

// The real-shape fixture is one sanitized spool record per file-event shape
// seen in a real capture (see testdata/README.md). Its identities are the
// balanced-mode digests of /work/proj/.git and /work/proj, except antigravity's,
// which was recorded in full mode and keeps the raw paths.
var (
	shapeRepo     = sha("/work/proj/.git")
	shapeWorktree = sha("/work/proj")
)

func realShapes(t *testing.T) map[string]event.Event {
	t.Helper()
	f, err := os.Open("testdata/activity_real_shapes.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out := map[string]event.Event{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var ev event.Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatal(err)
		}
		out[ev.Source+" "+ev.Name] = ev
	}
	if len(out) != 7 {
		t.Fatalf("fixture shapes: %d", len(out))
	}
	return out
}

// shapeAt clones a real record under a new stable ID and time.
func shapeAt(t *testing.T, shapes map[string]event.Event, key, id string, at time.Time) event.Event {
	t.Helper()
	ev, ok := shapes[key]
	if !ok {
		t.Fatalf("no fixture shape %q", key)
	}
	payload := make(map[string]any, len(ev.Payload))
	for k, v := range ev.Payload {
		payload[k] = v
	}
	ev.Payload, ev.ID, ev.Time = payload, id, at
	return ev
}

// stripRoot is the test resolver: paths under /work/proj are relative to it.
func stripRoot(_ event.Event, path string) (string, string) {
	if rel, ok := strings.CutPrefix(path, "/work/proj/"); ok {
		return "", rel
	}
	return "unknown", path
}

func activityQuery(from, to time.Time, bucket time.Duration) ActivityQuery {
	return ActivityQuery{RepoID: shapeRepo, RepoAliases: []string{"/work/proj/.git"}, From: from, To: to, Bucket: bucket, Resolve: stripRoot}
}

func heatOf(r ActivityResult) map[string][][2]int {
	out := map[string][][2]int{}
	for _, p := range r.Paths {
		out[p.Group+"|"+p.Path] = p.Heat
	}
	return out
}

func activityEngine(t *testing.T, evs []event.Event) (*Engine, *scanRecorder) {
	t.Helper()
	dir := t.TempDir()
	writeSpool(t, dir, evs)
	rec := &scanRecorder{}
	return newRecordingEngine(t, dir, rec), rec
}

const editPre, editPost = "claude-code PreToolUse:Edit", "claude-code PostToolUse:Edit"

func TestActivityCountsFileEventsPerPathPerBucket(t *testing.T) {
	s := realShapes(t)
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	e, _ := activityEngine(t, []event.Event{
		shapeAt(t, s, editPre, "a1", base.Add(1*time.Minute)),
		shapeAt(t, s, editPost, "a2", base.Add(2*time.Minute)),
		shapeAt(t, s, editPre, "a3", base.Add(31*time.Minute)),
		shapeAt(t, s, "codex patch_apply_end", "c1", base.Add(16*time.Minute)),
	})
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), 15*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][][2]int{
		"|plans/waiting-on-you.html":                    {{0, 2}, {2, 1}},
		"|test/pipeline/identifier_resolution_test.exs": {{1, 1}},
	}
	if got := heatOf(r); !reflect.DeepEqual(got, want) {
		t.Fatalf("heat = %v", got)
	}
	if r.Paths[0].Path != "plans/waiting-on-you.html" || r.Paths[0].Total != 3 || r.Paths[1].Total != 1 {
		t.Fatalf("paths sorted by group then path, total = sum of heat: %+v", r.Paths)
	}
	if r.Buckets != 4 || r.BucketSeconds != 900 || r.FileEvents != 4 || r.UnreadableFileEvents != 0 || r.Truncated {
		t.Fatalf("result = %+v", r)
	}
}

// Every real file-event shape, pinned: which ones yield a path and in what form.
func TestActivityPinsRealCaptureShapes(t *testing.T) {
	s := realShapes(t)
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	var evs []event.Event
	for _, key := range []string{editPre, editPost, "codex patch_apply_end", "codex custom_tool_call:apply_patch", "codex custom_tool_call_output:apply_patch", "codex PreToolUse", "antigravity PostToolUse:view_file"} {
		evs = append(evs, shapeAt(t, s, key, "id-"+key, base.Add(time.Duration(len(evs))*time.Minute)))
	}
	e, _ := activityEngine(t, evs)
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][][2]int{
		// claude-code: absolute file_path on both PreToolUse and PostToolUse (2 Heat per edit).
		"|plans/waiting-on-you.html": {{0, 2}},
		// codex rollout patch_apply_end: absolute keys of the changes map.
		"|test/pipeline/identifier_resolution_test.exs": {{0, 1}},
		// antigravity: view_file (a read) is file-category with an absolute file_path,
		// and its full-mode raw repo identity matches through the alias.
		"|docs/plan.md": {{0, 1}},
		// codex rollout custom_tool_call:apply_patch: the patch header in its input,
		// read up to the balanced-mode truncation; and its custom_tool_call_output:
		// the first line of the "Updated the following files:" summary (the second
		// was cut by truncation).
		"|test/contract_test.exs": {{0, 2}},
		// codex hook PreToolUse for apply_patch: the header in tool_input.command.
		"|docs/README.md": {{0, 1}},
	}
	if got := heatOf(r); !reflect.DeepEqual(got, want) {
		t.Fatalf("heat = %v", got)
	}
	if r.FileEvents != 7 || r.UnreadableFileEvents != 0 {
		t.Fatalf("file=%d unreadable=%d", r.FileEvents, r.UnreadableFileEvents)
	}
}

// applyPatchShapes holds real apply_patch records (see testdata/README.md): the
// calls, or the rollout custom_tool_call_output records when outputs is true.
func applyPatchShapes(t *testing.T, outputs bool) []event.Event {
	t.Helper()
	b, err := os.ReadFile("testdata/activity_apply_patch_shapes.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	var out []event.Event
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 12 {
		t.Fatalf("apply_patch shapes: %d", len(lines))
	}
	for _, line := range lines {
		var ev event.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatal(err)
		}
		if (ev.Name == "custom_tool_call_output:apply_patch") == outputs {
			out = append(out, ev)
		}
	}
	return out
}

// Codex apply_patch paths come from the patch's file headers, and for a hook
// PostToolUse also from its output summary. Each event adds 1 to every distinct
// path it names; a header cut by balanced-mode truncation (the last line,
// ending in "…") is no path.
func TestActivityReadsApplyPatchHeaders(t *testing.T) {
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	e, _ := activityEngine(t, applyPatchShapes(t, false))
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][][2]int{
		// Update File + Move to: the source and the destination.
		"|test/support/tab_client.exs": {{0, 1}},
		"|test_support/tab_client.exs": {{0, 1}},
		// Two Delete File headers in an untruncated patch, outside the repository.
		"unknown|/tmp/analyst_browser_boot.exs": {{0, 1}},
		"unknown|/tmp/analyst_chrome_cdp.mjs":   {{0, 1}},
		// A relative header passes through raw; the daemon resolver roots it.
		"unknown|MEMORY.md": {{0, 1}},
		// The first header survives truncation; the cut second one does not.
		"|lib/code_normalizer.ex": {{0, 1}},
		// A PostToolUse whose patch was cut before its second header: the output
		// names both files, the header one of them.
		"|mix.exs":                          {{0, 1}},
		"|test/toolchain_contract_test.exs": {{0, 1}},
	}
	if got := heatOf(r); !reflect.DeepEqual(got, want) {
		t.Fatalf("heat = %v", got)
	}
	// The hook record whose only header was cut by truncation is unreadable.
	if r.FileEvents != 6 || r.UnreadableFileEvents != 1 {
		t.Fatalf("file=%d unreadable=%d", r.FileEvents, r.UnreadableFileEvents)
	}
}

// A rollout custom_tool_call_output names its files after "Success. Updated the
// following files:", as plain text or, in older captures, inside a JSON
// {"output": ...} wrapper. A line cut by balanced-mode truncation is no path,
// and a failure output names none.
func TestActivityReadsApplyPatchOutputSummaries(t *testing.T) {
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	e, _ := activityEngine(t, applyPatchShapes(t, true))
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][][2]int{
		// Plain text with relative paths; the fourth line was cut.
		"unknown|priv/repo/migrations/20260522210000_create_pow_sessions.exs": {{0, 1}},
		"unknown|lib/analyst/pow/session.ex":                                  {{0, 1}},
		"unknown|lib/analyst/pow/postgres_credentials_store.ex":               {{0, 1}},
		// JSON-wrapped, untruncated.
		"|lib/isx_leads/types/case_code.ex": {{0, 1}},
		"|lib/isx_leads/normalization.ex":   {{0, 1}},
		// JSON-wrapped, cut in its metadata: the output string is whole.
		"|test/cadence_web/controllers/api/v1/simulation_persona_controller_test.exs": {{0, 1}},
		// JSON-wrapped, cut inside the output string: the third line is lost.
		"|test/isx_leads_web/live/notification_bell_component_test.exs": {{0, 1}},
		"|test/isx_leads/notifications/dispatcher_test.exs":             {{0, 1}},
	}
	if got := heatOf(r); !reflect.DeepEqual(got, want) {
		t.Fatalf("heat = %v", got)
	}
	// A verification failure naming a path and a JSON-wrapped timeout.
	if r.FileEvents != 6 || r.UnreadableFileEvents != 2 {
		t.Fatalf("file=%d unreadable=%d", r.FileEvents, r.UnreadableFileEvents)
	}
}

func TestApplyPatchSummaryPaths(t *testing.T) {
	const ok = "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\n"
	for _, tc := range []struct {
		name, output string
		want         []string
	}{
		{"plain", ok + "A a.go\nM /work/proj/b.go\nD c.go\n", []string{"a.go", "/work/proj/b.go", "c.go"}},
		{"cut last line", ok + "M a.go\nM b…", []string{"a.go"}},
		{"marker cut", "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the fol…", nil},
		{"first path cut", ok + "M /work/pr…", nil},
		{"marker not at a line start", "echo Success. Updated the following files:\nM a.go\n", nil},
		{"failure naming a path", "apply_patch verification failed: Failed to find expected lines in /work/proj/a.go:\n  x\n", nil},
		{"list ends at another line", ok + "M a.go\nR b.go\nM c.go\n", []string{"a.go"}},
		{"a path listed twice counts once", ok + "M a.go\nM a.go\n", []string{"a.go"}},
		{"empty path", ok + "M \nM a.go\n", []string{"a.go"}},
		{"json", `{"output":"Success. Updated the following files:\nA a.go\nM b.go\n","metadata":{"exit_code":0}}`, []string{"a.go", "b.go"}},
		{"json cut in metadata", `{"output":"Success. Updated the following files:\nM a.go\n","metadata":{"exit_co…`, []string{"a.go"}},
		{"json cut in output", `{"output":"Success. Updated the following files:\nM a.go\nM b.g…`, []string{"a.go"}},
		{"json cut in an escape", `{"output":"Success. Updated the following files:\nM a.go\nM \u00…`, []string{"a.go"}},
		{"json escaped backslash is no newline", `{"output":"Success. Updated the following files:\nM a\\nb.go\nM c…`, []string{`a\nb.go`}},
		{"json timeout", `{"output":"command timed out after 10005 milliseconds\n","metadata":{"exit_code":124}}`, nil},
		{"json without output", `{"metadata":{"exit_code":0}}`, nil},
	} {
		if got := applyPatchSummaryPaths(tc.output); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestApplyPatchPaths(t *testing.T) {
	for _, tc := range []struct {
		name, text string
		want       []string
	}{
		{"truncated after a header", "*** Begin Patch\n*** Update File: /work/proj/a.go\n@@\n-x…", []string{"/work/proj/a.go"}},
		{"header cut by truncation", "*** Begin Patch\n*** Add File: /work/proj/occ_6f8…", nil},
		{"full patch without trailing newline", "*** Begin Patch\n*** Delete File: test/home_test.exs\n*** End Patch", []string{"test/home_test.exs"}},
		{"move adds the destination", "*** Begin Patch\n*** Update File: a/x.ex\n*** Move to: b/x.ex\n@@\n", []string{"a/x.ex", "b/x.ex"}},
		{"a path named twice counts once", "*** Begin Patch\n*** Update File: a.go\n@@\n*** Update File: a.go\n@@\n*** End Patch\n", []string{"a.go"}},
		{"diff lines are not headers", "*** Begin Patch\n*** Update File: a.go\n+*** Add File: b.go\n- *** Update File: c.go\n*** End Patch\n", []string{"a.go"}},
		{"empty header", "*** Begin Patch\n*** Add File: \n*** End Patch\n", nil},
	} {
		if got := applyPatchPaths(tc.text); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestActivityIgnoresNonFileCategories(t *testing.T) {
	s := realShapes(t)
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	shell := shapeAt(t, s, editPre, "shell", base.Add(time.Minute))
	shell.Category = event.CategoryShell
	tool := shapeAt(t, s, editPre, "tool", base.Add(time.Minute))
	tool.Category = event.CategoryTool
	e, _ := activityEngine(t, []event.Event{shell, tool, shapeAt(t, s, editPre, "file", base.Add(time.Minute))})
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), time.Hour))
	if err != nil || r.FileEvents != 1 || len(r.Paths) != 1 || r.Paths[0].Total != 1 {
		t.Fatalf("only file-category events heat a path: %+v %v", r, err)
	}
}

func TestActivityWindowIsHalfOpen(t *testing.T) {
	s := realShapes(t)
	from := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	to := from.Add(time.Hour)
	e, _ := activityEngine(t, []event.Event{
		shapeAt(t, s, editPre, "before", from.Add(-time.Nanosecond)),
		shapeAt(t, s, editPre, "first", from),
		shapeAt(t, s, editPre, "last", to.Add(-time.Nanosecond)),
		shapeAt(t, s, editPre, "at-to", to),
	})
	r, err := e.Activity(context.Background(), activityQuery(from, to, 15*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got := heatOf(r)["|plans/waiting-on-you.html"]; !reflect.DeepEqual(got, [][2]int{{0, 1}, {3, 1}}) || r.FileEvents != 2 {
		t.Fatalf("[from, to): %v file=%d", got, r.FileEvents)
	}
}

func TestActivityFloorsFromToBucket(t *testing.T) {
	s := realShapes(t)
	from := time.Date(2026, 10, 16, 9, 7, 30, 0, time.FixedZone("EDT", -4*3600))
	floored := time.Date(2026, 10, 16, 13, 0, 0, 0, time.UTC)
	to := floored.Add(46 * time.Minute)
	e, _ := activityEngine(t, []event.Event{shapeAt(t, s, editPre, "early", floored.Add(2*time.Minute))})
	r, err := e.Activity(context.Background(), activityQuery(from, to, 15*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !r.From.Equal(floored) || r.From.Location() != time.UTC || !r.To.Equal(to) || r.Buckets != 4 {
		t.Fatalf("from is floored to the bucket in UTC and reported: from=%v to=%v buckets=%d", r.From, r.To, r.Buckets)
	}
	if got := heatOf(r)["|plans/waiting-on-you.html"]; !reflect.DeepEqual(got, [][2]int{{0, 1}}) {
		t.Fatalf("an event between the floor and the requested from is in bucket 0: %v", got)
	}
	if from, buckets := ActivityWindow(from, to, 15*time.Minute); !from.Equal(floored) || buckets != 4 {
		t.Fatalf("ActivityWindow = %v %d", from, buckets)
	}
}

func TestActivityMultiPathEventCountsEachPath(t *testing.T) {
	s := realShapes(t)
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	ev := shapeAt(t, s, "codex patch_apply_end", "multi", base.Add(time.Minute))
	ev.Payload["changes"] = map[string]any{"/work/proj/a.go": map[string]any{"type": "update"}, "/work/proj/b.go": map[string]any{"type": "add"}}
	e, _ := activityEngine(t, []event.Event{ev})
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if got := heatOf(r); !reflect.DeepEqual(got, map[string][][2]int{"|a.go": {{0, 1}}, "|b.go": {{0, 1}}}) || r.FileEvents != 1 {
		t.Fatalf("one event, two paths, one Heat each: %v file=%d", got, r.FileEvents)
	}
}

func TestActivityDedupesReplayedIDAcrossDays(t *testing.T) {
	s := realShapes(t)
	day1 := time.Date(2026, 10, 15, 23, 50, 0, 0, time.UTC)
	original := shapeAt(t, s, editPre, "replayed", day1)
	moved := original
	moved.Time = day1.Add(20 * time.Minute) // replay lands in the next day file
	sameDay := shapeAt(t, s, editPre, "twice", day1.Add(time.Minute))
	e, _ := activityEngine(t, []event.Event{original, sameDay, sameDay, moved})
	r, err := e.Activity(context.Background(), activityQuery(day1.Add(-time.Hour), day1.Add(2*time.Hour), time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if r.FileEvents != 2 || r.Paths[0].Total != 2 || !reflect.DeepEqual(r.Paths[0].Heat, [][2]int{{1, 2}}) {
		t.Fatalf("a stable ID keeps its first record only: %+v", r)
	}
}

func TestActivityReadsOnlyWindowDays(t *testing.T) {
	s := realShapes(t)
	var evs []event.Event
	for d := 1; d <= 10; d++ {
		evs = append(evs, shapeAt(t, s, editPre, fmt.Sprintf("d%02d", d), time.Date(2026, 10, d, 12, 0, 0, 0, time.UTC)))
	}
	e, rec := activityEngine(t, evs)
	from := time.Date(2026, 10, 4, 18, 0, 0, 0, time.UTC)
	to := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC) // exclusive: day 7 is outside
	r, err := e.Activity(context.Background(), activityQuery(from, to, time.Hour))
	if err != nil || r.FileEvents != 2 {
		t.Fatalf("days 5 and 6 hold the window's events: %+v %v", r, err)
	}
	got := rec.scanned()
	if !reflect.DeepEqual(got, []string{"2026-10-06", "2026-10-05", "2026-10-04"}) {
		t.Fatalf("only UTC days overlapping [from, to) may be read; read %v", got)
	}
	rec.reset()
	q := activityQuery(from, to, time.Hour)
	q.RepoID, q.RepoAliases = "unrelated", nil
	if _, err := e.Activity(context.Background(), q); err != nil || len(rec.scanned()) != 0 {
		t.Fatalf("a repository the index never saw reads nothing: %v %v", rec.scanned(), err)
	}
}

// A file event recorded in minimal mode holds {sha256,len} digests where the
// path was: it adds no Heat (not even to a "sha256" or "len" path) and is counted.
func TestActivityCountsUnreadableMinimalPayloads(t *testing.T) {
	s := realShapes(t)
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	var evs []event.Event
	for i, key := range []string{editPre, "codex patch_apply_end", "codex custom_tool_call:apply_patch", "codex custom_tool_call_output:apply_patch", "codex PreToolUse", "antigravity PostToolUse:view_file"} {
		ev := privacy.Redact(shapeAt(t, s, key, fmt.Sprintf("min%d", i), base.Add(time.Minute)), privacy.ModeMinimal)
		ev.RepoID, ev.WorktreeID = shapeRepo, shapeWorktree
		evs = append(evs, ev)
	}
	evs = append(evs, shapeAt(t, s, editPre, "readable", base.Add(2*time.Minute)))
	e, _ := activityEngine(t, evs)
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if r.FileEvents != 7 || r.UnreadableFileEvents != 6 || len(r.Paths) != 1 || r.Paths[0].Path != "plans/waiting-on-you.html" {
		t.Fatalf("minimal records are unreadable, not heat: %+v", r)
	}
}

func TestActivityHonoursCancel(t *testing.T) {
	s := realShapes(t)
	var evs []event.Event
	for d := 1; d <= 6; d++ {
		evs = append(evs, shapeAt(t, s, editPre, fmt.Sprintf("d%02d", d), time.Date(2026, 10, d, 12, 0, 0, 0, time.UTC)))
	}
	e, rec := activityEngine(t, evs)
	q := activityQuery(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC), time.Hour)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := e.Activity(cancelled, q); !errors.Is(err, context.Canceled) || len(rec.scanned()) != 0 {
		t.Fatalf("pre-cancelled: %v read %v", err, rec.scanned())
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rec.reset()
	rec.before = func(day string) {
		if day == "2026-10-05" {
			cancel()
		}
	}
	if _, err := e.Activity(ctx, q); !errors.Is(err, context.Canceled) {
		t.Fatalf("mid-scan: %v", err)
	}
	if got := rec.scanned(); !reflect.DeepEqual(got, []string{"2026-10-06", "2026-10-05"}) {
		t.Fatalf("scan continued after cancellation: %v", got)
	}
}

func TestActivityCapsPathsAndReportsTruncated(t *testing.T) {
	s := realShapes(t)
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	var evs []event.Event
	n := 0
	add := func(path string, count int) {
		for i := 0; i < count; i++ {
			n++
			ev := shapeAt(t, s, editPre, fmt.Sprintf("e%05d", n), base.Add(time.Duration(n)*time.Millisecond))
			ev.Payload["file_path"] = "/work/proj/" + path
			evs = append(evs, ev)
		}
	}
	for i := 0; i < ActivityPathCap+2; i++ {
		add(fmt.Sprintf("f/%05d.go", i), 1)
	}
	add("z/hot.go", 5)
	e, _ := activityEngine(t, evs)
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Paths) != ActivityPathCap || !r.Truncated || r.TruncatedTotal != 3 {
		t.Fatalf("paths=%d truncated=%v dropped=%d", len(r.Paths), r.Truncated, r.TruncatedTotal)
	}
	// The hottest path survives; ties on total keep the lowest paths; the kept
	// set is re-sorted into layout order.
	if last := r.Paths[len(r.Paths)-1]; last.Path != "z/hot.go" || last.Total != 5 {
		t.Fatalf("hottest dropped or order broken: %+v", last)
	}
	if r.Paths[0].Path != "f/00000.go" || r.Paths[len(r.Paths)-2].Path != fmt.Sprintf("f/%05d.go", ActivityPathCap-2) {
		t.Fatalf("tie-break by path: %s .. %s", r.Paths[0].Path, r.Paths[len(r.Paths)-2].Path)
	}
}

func TestActivityRejectsBadWindow(t *testing.T) {
	e, _ := activityEngine(t, nil)
	at := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	for _, q := range []ActivityQuery{
		activityQuery(at, at, time.Hour),
		activityQuery(at, at.Add(time.Hour), 0),
		{From: at, To: at.Add(time.Hour), Bucket: time.Hour},
	} {
		if _, err := e.Activity(context.Background(), q); err == nil {
			t.Fatalf("accepted %+v", q)
		}
	}
}
