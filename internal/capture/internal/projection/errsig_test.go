package projection

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

const errsigFixture = "testdata/errsig.ndjson"

const (
	keyTurnAborted = "codex|error|turn_aborted|turn_aborted"
	keyRateLimit   = "claude-code|error|StopFailure|rate_limit"
	keyAuthFailed  = "claude-code|error|StopFailure|authentication_failed"
	keyMixTest     = "codex|shell|PostToolUse|failed: mix test"
	keySed         = "codex|shell|PostToolUse|failed: sed -n '#,#p' src/assets/vue/pages/profile.vue"
)

func loadErrsigFixture(t *testing.T) []event.Event {
	t.Helper()
	f, err := os.Open(errsigFixture)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var evs []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) == "" {
			continue
		}
		var ev event.Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("decode fixture line: %v", err)
		}
		evs = append(evs, ev)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if len(evs) != 11 {
		t.Fatalf("fixture has %d events, want 11", len(evs))
	}
	return evs
}

func fixtureEvent(t *testing.T, id string) event.Event {
	t.Helper()
	for _, ev := range loadErrsigFixture(t) {
		if ev.ID == id {
			return ev
		}
	}
	t.Fatalf("fixture event %s not found", id)
	return event.Event{}
}

func sigByKey(t *testing.T, sigs []ErrorSignature) map[string]ErrorSignature {
	t.Helper()
	out := map[string]ErrorSignature{}
	for _, s := range sigs {
		if _, dup := out[s.Key]; dup {
			t.Fatalf("duplicate signature key %q", s.Key)
		}
		out[s.Key] = s
	}
	return out
}

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatal(err)
	}
	return tm
}

func TestIsErrorObservation(t *testing.T) {
	cases := []struct {
		name string
		ev   event.Event
		want bool
	}{
		{"error category", event.Event{Category: event.CategoryError}, true},
		{"error severity on shell", event.Event{Category: event.CategoryShell, Severity: event.SeverityError}, true},
		{"warn severity", event.Event{Category: event.CategoryShell, Severity: event.SeverityWarn}, false},
		{"plain tool", event.Event{Category: event.CategoryTool}, false},
		{"error category with info severity", event.Event{Category: event.CategoryError, Severity: event.SeverityInfo}, true},
	}
	for _, c := range cases {
		if got := isErrorObservation(c.ev); got != c.want {
			t.Errorf("%s: isErrorObservation = %v, want %v", c.name, got, c.want)
		}
	}
	// The attention overlay must use the very same predicate.
	for _, c := range cases {
		next, _ := Transition(Attention{State: StateWorking}, c.ev)
		if next.HasError != c.want {
			t.Errorf("%s: Transition HasError = %v, want %v", c.name, next.HasError, c.want)
		}
	}
}

func TestNormalizeErrorSummary(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  Failed:   Mix\tTest \n", "failed: mix test"},
		{"sed -n '670,1010p' a.vue", "sed -n '#,#p' a.vue"},
		{"sed -n '890,1055p' a.vue", "sed -n '#,#p' a.vue"},
		// hex runs of 6+ collapse before digits are replaced, so ids group.
		{"object ea400e9dd0a6 missing", "object # missing"},
		{"object 5440b6eae6c8 missing", "object # missing"},
		{"at 0x7ffd1234abcd", "at #x#"},
		// short hex-looking runs are not ids; digits still collapse.
		{"abc12 failed", "abc# failed"},
		// ordinary words survive.
		{"failed: mix test", "failed: mix test"},
		{"", ""},
		{"turn_aborted", "turn_aborted"},
	}
	for _, c := range cases {
		if got := normalizeErrorSummary(c.in); got != c.want {
			t.Errorf("normalizeErrorSummary(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	long := strings.Repeat("é", 400)
	if got := []rune(normalizeErrorSummary(long)); len(got) != 160 {
		t.Errorf("long summary truncated to %d runes, want 160", len(got))
	}
}

func TestErrorClassForms(t *testing.T) {
	digest := map[string]any{"sha256": "0123456789abcdef0123456789abcdef", "len": float64(10)}
	cases := []struct {
		name string
		ev   event.Event
		want string
	}{
		{"string class", event.Event{Summary: "x", Payload: map[string]any{"error_class": "rate_limit"}}, "rate_limit"},
		{"digest class", event.Event{Summary: "x", Payload: map[string]any{"error_class": digest}}, "0123456789abcdef"},
		{"string-map digest", event.Event{Summary: "x", Payload: map[string]any{"error_class": map[string]string{"sha256": "fedcba9876543210ffff"}}}, "fedcba9876543210"},
		{"short digest used whole", event.Event{Summary: "x", Payload: map[string]any{"error_class": map[string]any{"sha256": "abc"}}}, "abc"},
		{"empty class falls to summary", event.Event{Summary: "Boom 42", Payload: map[string]any{"error_class": ""}}, "boom #"},
		{"non-string class falls to summary", event.Event{Summary: "Boom 42", Payload: map[string]any{"error_class": 7}}, "boom #"},
		{"map without sha falls to summary", event.Event{Summary: "Boom", Payload: map[string]any{"error_class": map[string]any{"len": 3}}}, "boom"},
		{"no payload", event.Event{Summary: "Boom"}, "boom"},
		{"no class no summary", event.Event{}, ""},
	}
	for _, c := range cases {
		if got := errorClass(c.ev); got != c.want {
			t.Errorf("%s: errorClass = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestErrorSignaturesFixture(t *testing.T) {
	ix := foldProjection(loadErrsigFixture(t))
	sigs := ix.ErrorSignatures("")
	if len(sigs) != 5 {
		t.Fatalf("got %d signatures, want 5: %+v", len(sigs), sigs)
	}

	// Sorted by LastTime desc, then Key asc.
	wantOrder := []string{keyAuthFailed, keyRateLimit, keyMixTest, keySed, keyTurnAborted}
	for i, k := range wantOrder {
		if sigs[i].Key != k {
			t.Errorf("order[%d] = %q, want %q", i, sigs[i].Key, k)
		}
	}

	by := sigByKey(t, sigs)
	want := []struct {
		key      string
		source   string
		category string
		name     string
		class    string
		count    int
		sessions int
		first    string
		last     string
	}{
		{keyTurnAborted, "codex", "error", "turn_aborted", "turn_aborted", 2, 0,
			"2025-11-03T13:37:37.178Z", "2025-11-13T22:08:51.349Z"},
		{keyRateLimit, "claude-code", "error", "StopFailure", "rate_limit", 2, 2,
			"2026-09-06T17:17:30.489543Z", "2026-09-06T17:18:20.588487Z"},
		{keyAuthFailed, "claude-code", "error", "StopFailure", "authentication_failed", 2, 2,
			"2026-09-29T19:38:38.493951Z", "2026-10-04T08:42:38.680527Z"},
		{keyMixTest, "codex", "shell", "PostToolUse", "failed: mix test", 3, 2,
			"2026-07-30T06:32:13.793447Z", "2026-08-05T13:56:47.146775Z"},
		{keySed, "codex", "shell", "PostToolUse", "failed: sed -n '#,#p' src/assets/vue/pages/profile.vue", 2, 1,
			"2026-07-29T23:17:54.12435Z", "2026-07-30T00:03:51.631074Z"},
	}
	for _, w := range want {
		got, ok := by[w.key]
		if !ok {
			t.Errorf("missing signature %q", w.key)
			continue
		}
		if got.Source != w.source || got.Category != w.category || got.Name != w.name || got.Class != w.class {
			t.Errorf("%s: identity fields wrong: %+v", w.key, got)
		}
		if got.Count != w.count || got.Sessions != w.sessions {
			t.Errorf("%s: count/sessions = %d/%d, want %d/%d", w.key, got.Count, got.Sessions, w.count, w.sessions)
		}
		if !got.FirstTime.Equal(mustTime(t, w.first)) || !got.LastTime.Equal(mustTime(t, w.last)) {
			t.Errorf("%s: times = %v..%v, want %s..%s", w.key, got.FirstTime, got.LastTime, w.first, w.last)
		}
		if len(got.Paths) != 0 {
			t.Errorf("%s: error/shell events carry no file paths, got %v", w.key, got.Paths)
		}
	}

	// Sample is the first non-empty raw summary seen, not the normalized form.
	if by[keySed].Sample != "failed: sed -n '670,1010p' src/assets/vue/pages/profile.vue" {
		t.Errorf("sed sample = %q", by[keySed].Sample)
	}
	if by[keyMixTest].Sample != "failed: mix test" {
		t.Errorf("mix sample = %q", by[keyMixTest].Sample)
	}

	// The same command against a different file stays a distinct signature.
	other := fixtureEvent(t, "84b0e3e3218a1d107795159e885a1d69")
	other.ID = "other-file"
	other.Summary = "failed: sed -n '1,20p' src/other.vue"
	ix.Apply(other)
	if n := len(ix.ErrorSignatures("")); n != 6 {
		t.Errorf("different file should add a signature, got %d total", n)
	}
}

func TestErrorSignaturesSessionFilter(t *testing.T) {
	ix := foldProjection(loadErrsigFixture(t))

	sed := ix.ErrorSignatures("019faa0f-4b75-75b0-b8b3-48f248fb6916")
	if len(sed) != 1 || sed[0].Key != keySed {
		t.Errorf("sed session filter wrong: %+v", sed)
	}
	mix := ix.ErrorSignatures("019fd182-8513-7461-a816-e786f1fe439e")
	if len(mix) != 1 || mix[0].Key != keyMixTest {
		t.Fatalf("mix session filter wrong: %+v", mix)
	}
	// Counts are global, not re-scoped to the filtered session.
	if mix[0].Count != 3 || mix[0].Sessions != 2 {
		t.Errorf("filtered signature must keep global counts: %+v", mix[0])
	}

	none := ix.ErrorSignatures("no-such-session")
	if none == nil || len(none) != 0 {
		t.Errorf("unknown session must yield empty non-nil slice, got %#v", none)
	}
	if empty := New().ErrorSignatures(""); empty == nil || len(empty) != 0 {
		t.Errorf("empty projection must yield empty non-nil slice, got %#v", empty)
	}
}

func TestErrorSignaturesIgnoreNonErrors(t *testing.T) {
	ix := foldProjection(seedEvents())
	if sigs := ix.ErrorSignatures(""); len(sigs) != 0 {
		t.Errorf("non-error events produced signatures: %+v", sigs)
	}
	ix.Apply(event.Event{ID: "w1", Time: time.Now(), Source: "codex", SessionID: "s",
		Category: event.CategoryShell, Severity: event.SeverityWarn, Summary: "warn only"})
	if sigs := ix.ErrorSignatures(""); len(sigs) != 0 {
		t.Errorf("warn severity must not qualify: %+v", sigs)
	}
}

func TestErrorSignaturesDeterminism(t *testing.T) {
	evs := loadErrsigFixture(t)
	want := foldProjection(evs).ErrorSignatures("")

	// Build over a spool directory holding the fixture agrees with the fold on
	// every field.
	dir := t.TempDir()
	raw, err := os.ReadFile(errsigFixture)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "2026-10-16.ndjson"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	built, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := built.ErrorSignatures(""); !reflect.DeepEqual(got, want) {
		t.Errorf("Build vs fold mismatch:\n%+v\n%+v", got, want)
	}

	// Per-event ApplyResult in reversed and rotated order agrees on every
	// field: Sample is pinned to the earliest (Time, ID) carrier, so it must
	// not depend on application order.
	orders := map[string][]event.Event{}
	rev := make([]event.Event, len(evs))
	for i, ev := range evs {
		rev[len(evs)-1-i] = ev
	}
	orders["reversed"] = rev
	orders["rotated"] = append(append([]event.Event{}, evs[5:]...), evs[:5]...)
	for name, order := range orders {
		ix := New()
		for _, ev := range order {
			if _, isNew := ix.ApplyResult(ev); !isNew {
				t.Fatalf("%s: event %s reported as replay", name, ev.ID)
			}
		}
		if got := ix.ErrorSignatures(""); !reflect.DeepEqual(got, want) {
			t.Errorf("%s order mismatch:\n%+v\n%+v", name, got, want)
		}
	}

	// Replaying every id a second time changes nothing.
	ix := foldProjection(evs)
	before := ix.ErrorSignatures("")
	for _, ev := range evs {
		if _, isNew := ix.ApplyResult(ev); isNew {
			t.Fatalf("replay of %s reported as new", ev.ID)
		}
	}
	if after := ix.ErrorSignatures(""); !reflect.DeepEqual(before, after) {
		t.Errorf("replay changed signatures:\n%+v\n%+v", before, after)
	}
}

func TestErrorSignatureMinimalModeDigest(t *testing.T) {
	a := privacy.Redact(fixtureEvent(t, "f8dba170217e34a1a442ee787b2efd68"), privacy.ModeMinimal)
	b := privacy.Redact(fixtureEvent(t, "6b90610ce93e0df10d6496cdb83ef4ca"), privacy.ModeMinimal)

	digest, ok := a.Payload["error_class"].(map[string]any)
	if !ok {
		t.Fatalf("minimal redaction should digest error_class, got %#v", a.Payload["error_class"])
	}
	sum, _ := digest["sha256"].(string)
	if len(sum) < 16 {
		t.Fatalf("digest sha256 too short: %q", sum)
	}

	ix := New()
	ix.Apply(a)
	ix.Apply(b)
	sigs := ix.ErrorSignatures("")
	if len(sigs) != 1 {
		t.Fatalf("both redacted copies must share one signature, got %+v", sigs)
	}
	got := sigs[0]
	if got.Class != sum[:16] || got.Key != "claude-code|error|StopFailure|"+sum[:16] {
		t.Errorf("digest class wrong: %+v (want token %s)", got, sum[:16])
	}
	if got.Count != 2 || got.Sessions != 2 {
		t.Errorf("count/sessions = %d/%d, want 2/2", got.Count, got.Sessions)
	}

	// A different original class digests to a different signature.
	c := privacy.Redact(fixtureEvent(t, "91190ace920ed9c07811fa6172f2a30f"), privacy.ModeMinimal)
	ix.Apply(c)
	if n := len(ix.ErrorSignatures("")); n != 2 {
		t.Errorf("distinct classes must stay distinct under digest, got %d signatures", n)
	}

	// The shape survives a JSON round trip (what a spool read produces).
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	var round event.Event
	if err := json.Unmarshal(raw, &round); err != nil {
		t.Fatal(err)
	}
	round.ID = "round-trip"
	ix.Apply(round)
	by := sigByKey(t, ix.ErrorSignatures(""))
	if by[got.Key].Count != 3 {
		t.Errorf("round-tripped digest should join the same signature: %+v", by[got.Key])
	}
}

func TestErrorSignatureTimesAreMonotonic(t *testing.T) {
	early := fixtureEvent(t, "f8dba170217e34a1a442ee787b2efd68") // 17:17:30
	late := fixtureEvent(t, "6b90610ce93e0df10d6496cdb83ef4ca")  // 17:18:20

	ix := New()
	ix.Apply(late)
	ix.Apply(early) // out of order: extends FirstTime backwards only
	sig := sigByKey(t, ix.ErrorSignatures(""))[keyRateLimit]
	if !sig.FirstTime.Equal(early.Time) {
		t.Errorf("FirstTime = %v, want %v", sig.FirstTime, early.Time)
	}
	if !sig.LastTime.Equal(late.Time) {
		t.Errorf("LastTime dragged backwards: %v, want %v", sig.LastTime, late.Time)
	}
	if sig.Count != 2 {
		t.Errorf("Count = %d, want 2", sig.Count)
	}
	// Sample is the first raw summary seen, which was applied first.
	if sig.Sample != late.Summary {
		t.Errorf("Sample = %q, want %q", sig.Sample, late.Summary)
	}
}

func fileErrorEvent(id, path string, at time.Time) event.Event {
	return event.Event{ID: id, Time: at, Source: "claude-code", SessionID: "s1",
		Category: event.CategoryFile, Severity: event.SeverityError, Name: "PostToolUse",
		Summary: "write failed", Payload: map[string]any{"file_path": path}}
}

func TestErrorSignaturePathsTieOnlyToOwnEventPaths(t *testing.T) {
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	ix := New()
	ix.Apply(fileErrorEvent("p1", "/repo/b.go", base))
	ix.Apply(fileErrorEvent("p2", "/repo/a.go", base.Add(time.Second)))
	ix.Apply(fileErrorEvent("p3", "/repo/a.go", base.Add(2*time.Second)))
	// A neighbouring non-error file event must not donate its path.
	ix.Apply(event.Event{ID: "n1", Time: base.Add(3 * time.Second), Source: "claude-code", SessionID: "s1",
		Category: event.CategoryFile, Payload: map[string]any{"file_path": "/repo/zzz.go"}})

	sigs := ix.ErrorSignatures("")
	if len(sigs) != 1 {
		t.Fatalf("want 1 signature, got %+v", sigs)
	}
	if want := []string{"/repo/a.go", "/repo/b.go"}; !reflect.DeepEqual(sigs[0].Paths, want) {
		t.Errorf("Paths = %v, want %v (sorted, deduped, own-event only)", sigs[0].Paths, want)
	}
	if sigs[0].Count != 3 {
		t.Errorf("Count = %d, want 3", sigs[0].Count)
	}
}

func TestErrorSignaturePathsCapAtTwentyKeepsSmallest(t *testing.T) {
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	forward := New()
	backward := New()
	for i := 0; i < 25; i++ {
		forward.Apply(fileErrorEvent(fmt.Sprintf("f%d", i), fmt.Sprintf("/repo/f%02d.go", i), base.Add(time.Duration(i)*time.Second)))
	}
	for i := 24; i >= 0; i-- {
		backward.Apply(fileErrorEvent(fmt.Sprintf("f%d", i), fmt.Sprintf("/repo/f%02d.go", i), base.Add(time.Duration(i)*time.Second)))
	}
	fp := forward.ErrorSignatures("")[0].Paths
	bp := backward.ErrorSignatures("")[0].Paths
	if len(fp) != 20 || !reflect.DeepEqual(fp, bp) {
		t.Fatalf("cap must be 20 and order-independent:\n%v\n%v", fp, bp)
	}
	if fp[0] != "/repo/f00.go" || fp[19] != "/repo/f19.go" {
		t.Errorf("cap should keep the 20 smallest sorted paths, got %v", fp)
	}
}

func TestErrorSignatureReturnsCopies(t *testing.T) {
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	ix := New()
	ix.Apply(fileErrorEvent("p1", "/repo/a.go", base))
	got := ix.ErrorSignatures("")
	got[0].Paths[0] = "mutated"
	got[0].Count = 99
	again := ix.ErrorSignatures("")
	if again[0].Paths[0] != "/repo/a.go" || again[0].Count != 1 {
		t.Errorf("accessor leaked internal state: %+v", again[0])
	}
}
