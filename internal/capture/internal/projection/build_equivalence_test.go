package projection

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/capture/internal/spool"
)

// TestBuildAllocationsPerEvent bounds the bytes one Build allocates per spool
// event. Materializing the whole spool costs about 8 KB/event; streaming it
// into Apply stays well under the bound.
func TestBuildAllocationsPerEvent(t *testing.T) {
	const days, perDay = 5, 10000
	dir := t.TempDir()
	writeSyntheticSpool(t, dir, days, perDay)

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	ix, err := Build(dir)
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatal(err)
	}
	runtime.KeepAlive(ix)

	perEvent := float64(after.TotalAlloc-before.TotalAlloc) / (days * perDay)
	if perEvent >= 5000 {
		t.Fatalf("Build allocated %.0f B/event, want < 5000", perEvent)
	}
}

// referenceBuild is the materializing Build that streaming replaced: read the
// whole spool, record the read gap, then Apply every event in order.
func referenceBuild(t *testing.T, dir string) *Projection {
	t.Helper()
	evs, gaps, err := spool.ReadForProjection(dir)
	if err != nil {
		t.Fatal(err)
	}
	ix := New()
	if gaps {
		ix.gap = &CaptureGap{Source: "firehose", Time: buildNow().UTC(), Summary: "Some spool records could not be read while rebuilding history."}
		ix.readGap = true
	}
	for _, ev := range evs {
		ix.Apply(ev)
	}
	return ix
}

func assertBuildEquivalent(t *testing.T, dir string) {
	t.Helper()
	// Both builds stamp the read gap from the same fixed clock, so every gap,
	// captured or synthetic, compares exactly. 10:30 sits between the legacy
	// fixtures' times so the clock boundary is exercised.
	defer setBuildNow(time.Date(2026, 9, 1, 10, 30, 0, 0, time.UTC))()
	want := referenceBuild(t, dir)
	got, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(want.seen) == 0 {
		t.Fatal("reference projection is empty; fixture spool not read")
	}

	if !reflect.DeepEqual(got.gap, want.gap) {
		t.Fatalf("gap=%+v, reference gap=%+v", got.gap, want.gap)
	}

	state := []struct {
		name      string
		got, want any
	}{
		{"sessions", got.sessions, want.sessions},
		{"traces", got.traces, want.traces},
		{"files", got.files, want.files},
		{"fileSessions", got.fileSessions, want.fileSessions},
		{"errSigs", got.errSigs, want.errSigs},
		{"seen", got.seen, want.seen},
		{"inbox", got.inbox, want.inbox},
		{"warnings", got.warnings, want.warnings},
		{"identityDays", got.identityDays, want.identityDays},
		{"allDays", got.allDays, want.allDays},
		{"readGap", got.readGap, want.readGap},
	}
	for _, s := range state {
		if !reflect.DeepEqual(s.got, s.want) {
			t.Errorf("%s differs:\n got=%+v\nwant=%+v", s.name, s.got, s.want)
		}
	}

	gotInbox, wantInbox := got.Inbox(), want.Inbox()
	views := []struct {
		name      string
		got, want any
	}{
		{"Sessions", got.Sessions(), want.Sessions()},
		{"Traces", got.Traces(), want.Traces()},
		{"Files", got.Files(), want.Files()},
		{"Inbox", gotInbox, wantInbox},
		{"ErrorSignatures", got.ErrorSignatures(""), want.ErrorSignatures("")},
		{"TimelineDays", got.TimelineDays(nil, ""), want.TimelineDays(nil, "")},
		{"ReadGap", got.ReadGap(), want.ReadGap()},
	}
	for id := range want.sessions {
		views = append(views,
			struct {
				name      string
				got, want any
			}{"ErrorSignatures(" + id + ")", got.ErrorSignatures(id), want.ErrorSignatures(id)},
			struct {
				name      string
				got, want any
			}{"SessionDays(" + id + ")", got.SessionDays(id), want.SessionDays(id)})
	}
	for id := range want.traces {
		views = append(views, struct {
			name      string
			got, want any
		}{"TraceDays(" + id + ")", got.TraceDays(id), want.TraceDays(id)})
	}
	for key := range want.identityDays {
		views = append(views, struct {
			name      string
			got, want any
		}{"IdentityDays(" + key + ")", got.IdentityDays([]string{key}), want.IdentityDays([]string{key})})
	}
	for id := range want.seen {
		if g, w := got.EventDay(id), want.EventDay(id); g != w {
			t.Errorf("EventDay(%s)=%q, reference %q", id, g, w)
		}
	}
	for _, v := range views {
		if !reflect.DeepEqual(v.got, v.want) {
			t.Errorf("%s differs:\n got=%+v\nwant=%+v", v.name, v.got, v.want)
		}
	}
}

// fixtureFiles are the real, sanitized spool records shared with the
// synthetic spool.
func fixtureFiles(t *testing.T) [][]byte {
	t.Helper()
	var out [][]byte
	for _, path := range syntheticFixtures {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, data)
	}
	return out
}

func writeDayFile(t *testing.T, dir, day string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, day+".ndjson"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBuildEquivalenceFixtureDayFiles(t *testing.T) {
	dir := t.TempDir()
	for i, data := range fixtureFiles(t) {
		writeDayFile(t, dir, time.Date(2026, 10, 1+i, 0, 0, 0, 0, time.UTC).Format("2006-01-02"), data)
	}
	assertBuildEquivalent(t, dir)
}

func TestBuildEquivalenceFixturesInOneDay(t *testing.T) {
	dir := t.TempDir()
	var all []byte
	for _, data := range fixtureFiles(t) {
		all = append(all, data...)
		if !bytes.HasSuffix(all, []byte("\n")) {
			all = append(all, '\n')
		}
	}
	writeDayFile(t, dir, "2026-10-01", all)
	assertBuildEquivalent(t, dir)
}

func TestBuildEquivalenceSyntheticSpool(t *testing.T) {
	dir := t.TempDir()
	writeSyntheticSpool(t, dir, 3, 2000)
	assertBuildEquivalent(t, dir)
}

func TestBuildEquivalenceWithReadGapsAndDuplicateIDs(t *testing.T) {
	dir := t.TempDir()
	writeSyntheticSpool(t, dir, 2, 500)
	first, err := os.ReadFile(filepath.Join(dir, "2026-09-01.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.SplitAfter(string(first), "\n")
	// The spool reader caps records at 8 MiB; this one is past it.
	oversized := `{"schema_version":1,"id":"huge","time":"2026-09-03T10:00:00Z","source":"generic","category":"meta","summary":"` +
		strings.Repeat("x", 9<<20) + `"}` + "\n"
	day3 := strings.Join([]string{
		"{corrupt\n",
		`{"schema_version":1,"id":"invalid","time":"2026-09-03T10:00:00Z","category":"meta"}` + "\n", // no source: fails Validate
		oversized,
		// Ids already applied from 2026-09-01; the later copies must lose.
		lines[0], lines[1], lines[17],
	}, "")
	writeDayFile(t, dir, "2026-09-03", []byte(day3))
	assertBuildEquivalent(t, dir)

	ix, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !ix.ReadGap() || ix.gap == nil {
		t.Fatal("expected a read gap for undecodable, invalid, and oversized records")
	}
}

// applyInbox reads gap for id-less legacy records and overwrites it for
// parse-error records, so the read gap Build records must fold in as if it had
// been set before any event was applied.
func TestBuildEquivalenceReadGapMeetsInboxGaps(t *testing.T) {
	const (
		corrupt     = "{corrupt\n"
		legacyPast  = `{"schema_version":1,"time":"2026-09-01T10:00:00Z","source":"generic","category":"meta","summary":"old"}` + "\n"
		legacyLater = `{"schema_version":1,"time":"2026-09-01T11:00:00Z","source":"generic","category":"meta","summary":"later"}` + "\n"
		legacyAtClk = `{"schema_version":1,"time":"2026-09-01T10:30:00Z","source":"generic","category":"meta","summary":"at clock"}` + "\n"
		legacyFut   = `{"schema_version":1,"time":"2099-01-01T00:00:00Z","source":"generic","category":"meta","summary":"future"}` + "\n"
		parseErr    = `{"schema_version":1,"id":"pe1","time":"2026-09-01T09:00:00Z","source":"firehose","name":"parse-error","category":"meta","severity":"warn","summary":"bad record"}` + "\n"
		parseErrDup = `{"schema_version":1,"id":"pe1","time":"2026-09-01T09:00:00Z","source":"firehose","name":"parse-error","category":"meta","severity":"warn","summary":"bad record"}` + "\n"
		idlessParse = `{"schema_version":1,"time":"2026-09-01T09:30:00Z","source":"firehose","name":"parse-error","category":"meta","severity":"warn","summary":"id-less"}` + "\n"
		plain       = `{"schema_version":1,"id":"p1","time":"2026-09-01T08:00:00Z","source":"generic","category":"meta","summary":"plain"}` + "\n"
	)
	cases := map[string]string{
		"gap only":                   corrupt + plain,
		"past legacy":                corrupt + plain + legacyPast,
		"future legacy":              corrupt + plain + legacyFut,
		"legacy at the clock":        corrupt + plain + legacyAtClk,
		"later legacy":               corrupt + plain + legacyLater,
		"parse-error then legacy":    corrupt + parseErr + legacyPast,
		"legacy then parse-error":    corrupt + legacyPast + parseErr + legacyLater,
		"future then parse-error":    legacyFut + parseErr + corrupt,
		"id-less parse-error":        corrupt + plain + idlessParse,
		"duplicate parse-error":      parseErr + legacyLater + corrupt + parseErrDup,
		"no read gap, legacy":        plain + legacyPast + legacyFut,
		"no read gap, parse-error":   plain + legacyPast + parseErr,
		"no read gap, id-less parse": plain + idlessParse,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeDayFile(t, dir, "2026-09-01", []byte(content))
			assertBuildEquivalent(t, dir)
		})
	}
}

// setBuildNow pins the rebuild clock and returns a restore func.
func setBuildNow(at time.Time) func() {
	prev := buildNow
	buildNow = func() time.Time { return at }
	return func() { buildNow = prev }
}

// The materializing Build stamped the read gap after reading the whole spool,
// and which gap survives depends on that instant (an id-less record replaces
// it only when strictly newer). Streaming must sample the clock after the
// scan too. The clock here repairs the spool when called: sampled before the
// scan, the scan would see no unreadable record and record no read gap.
func TestBuildStampsReadGapAfterScan(t *testing.T) {
	dir := t.TempDir()
	plain := `{"schema_version":1,"id":"p1","time":"2026-09-01T08:00:00Z","source":"generic","category":"meta","summary":"plain"}` + "\n"
	writeDayFile(t, dir, "2026-09-01", []byte("{corrupt\n"+plain))
	at := time.Date(2026, 9, 1, 10, 30, 0, 0, time.UTC)
	prev := buildNow
	defer func() { buildNow = prev }()
	buildNow = func() time.Time {
		writeDayFile(t, dir, "2026-09-01", []byte(plain))
		return at
	}
	ix, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !ix.ReadGap() || ix.gap == nil || !ix.gap.Time.Equal(at) || ix.gap.Source != "firehose" {
		t.Fatalf("read gap=%v gap=%+v, want the read gap stamped at %v after the scan", ix.ReadGap(), ix.gap, at)
	}
}
