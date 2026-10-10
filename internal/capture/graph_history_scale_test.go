package capture

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

// scanRecorder wraps the production day scanner so tests can prove exactly
// which spool day files a query opened.
type scanRecorder struct {
	mu     sync.Mutex
	days   []string
	before func(day string)
}

func (r *scanRecorder) scanner() dayScanner {
	return func(ctx context.Context, dir, day string, filter spool.Prefilter, onGap func(), yield func(event.Event)) error {
		r.mu.Lock()
		r.days = append(r.days, day)
		before := r.before
		r.mu.Unlock()
		if before != nil {
			before(day)
		}
		return spool.ScanDay(ctx, dir, day, filter, onGap, yield)
	}
}

func (r *scanRecorder) scanned() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.days...)
}

func (r *scanRecorder) reset() {
	r.mu.Lock()
	r.days = nil
	r.mu.Unlock()
}

func writeSpool(t *testing.T, dir string, evs []event.Event) {
	t.Helper()
	w := spool.NewWriter(dir)
	for _, ev := range evs {
		if _, err := w.Append(ev); err != nil {
			t.Fatal(err)
		}
	}
}

func newRecordingEngine(t *testing.T, dir string, rec *scanRecorder) *Engine {
	t.Helper()
	e, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: rec.scanner()})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func dayOf(d, h, m, s int) time.Time { return time.Date(2026, 6, d, h, m, s, 0, time.UTC) }

func dayName(d int) string { return fmt.Sprintf("2026-06-%02d", d) }

func ids(evs []event.Event) []string {
	out := make([]string, len(evs))
	for i, ev := range evs {
		out[i] = ev.ID
	}
	return out
}

// referenceTimeline is the pre-index implementation: read the whole spool,
// dedupe, filter, sort, and cut one cursor page. The indexed engine must agree.
func referenceTimeline(t *testing.T, dir string, q TimelineQuery) TimelinePage {
	t.Helper()
	if q.Limit <= 0 {
		q.Limit = 200
	}
	if q.Limit > 1000 {
		q.Limit = 1000
	}
	var cursor timelineCursor
	if q.Cursor != "" {
		data, err := base64.RawURLEncoding.DecodeString(q.Cursor)
		if err != nil || json.Unmarshal(data, &cursor) != nil {
			t.Fatalf("reference cursor %q", q.Cursor)
		}
	}
	events, gap, err := spool.ReadForProjection(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := TimelinePage{Events: []event.Event{}, Order: "newest_first", CaptureGap: gap}
	seen := map[string]bool{}
	search := strings.ToLower(q.Search)
	for _, ev := range events {
		if ev.ID != "" && seen[ev.ID] {
			continue
		}
		if ev.ID != "" {
			seen[ev.ID] = true
		}
		if !identityMatches(q.RepoID, q.RepoAliases, ev.RepoID, ev.JJRepoID) || !identityMatches(q.WorkspaceID, q.WorkspaceAliases, ev.WorktreeID, ev.JJWorkspaceID) || q.Source != "" && ev.Source != q.Source || q.SessionID != "" && ev.SessionID != q.SessionID || q.Category != "" && string(ev.Category) != q.Category {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(ev.Summary+" "+ev.Name+" "+ev.Agent+" "+ev.Source+" "+ev.SessionID), search) {
			continue
		}
		if !cursor.Time.IsZero() && (ev.Time.After(cursor.Time) || ev.Time.Equal(cursor.Time) && ev.ID >= cursor.ID) {
			continue
		}
		out.Events = append(out.Events, ev)
	}
	sort.Slice(out.Events, func(i, j int) bool {
		a, b := out.Events[i], out.Events[j]
		if a.Time.Equal(b.Time) {
			return a.ID > b.ID
		}
		return a.Time.After(b.Time)
	})
	if len(out.Events) > q.Limit {
		out.HasMore = true
		out.Events = out.Events[:q.Limit]
		last := out.Events[len(out.Events)-1]
		data, _ := json.Marshal(timelineCursor{last.Time, last.ID})
		out.NextCursor = base64.RawURLEncoding.EncodeToString(data)
	}
	return out
}

// fixtureEvents builds a deterministic multi-day spool with sparse repos,
// historical aliases, JJ identities, same-instant ties, midnight boundaries and
// replayed (duplicate) stable IDs.
func fixtureEvents() []event.Event {
	rng := rand.New(rand.NewSource(7))
	sources := []string{"codex", "claude-code"}
	categories := []event.Category{event.CategoryMeta, event.CategoryTool, event.CategoryPrompt}
	words := []string{"alpha build", "beta deploy", "gamma review"}
	type identity struct{ repo, worktree, jjRepo, jjWorkspace string }
	identities := []identity{
		{repo: "repoA", worktree: "wsA1"},
		{repo: "repoA", worktree: "wsA2"},
		{repo: "repoA-old", worktree: "wsA1-old"},
		{repo: "repoB", worktree: "wsB1"},
		{jjRepo: "jj:repoC", jjWorkspace: "jj:wsC1"},
		{jjRepo: "jj:repoC", jjWorkspace: "jj:wsC2"},
		{},
	}
	// Per-day identity availability makes repos sparse across the 12 days.
	available := func(day, i int) bool {
		switch i {
		case 0, 1:
			return day >= 3
		case 2:
			return day <= 4
		case 3:
			return day <= 4 || day == 12
		case 4, 5:
			return day >= 8
		}
		return true
	}
	var evs []event.Event
	n := 0
	for day := 1; day <= 12; day++ {
		var last time.Time
		for k := 0; k < 60; k++ {
			i := rng.Intn(len(identities))
			if !available(day, i) {
				continue
			}
			id := identities[i]
			ts := dayOf(day, rng.Intn(24), rng.Intn(60), rng.Intn(60))
			if k%9 == 0 && !last.IsZero() {
				ts = last // same-instant tie broken only by ID
			}
			last = ts
			n++
			evs = append(evs, event.Event{
				ID: fmt.Sprintf("e%05d-%x", n, rng.Intn(4096)), Time: ts,
				Source: sources[rng.Intn(2)], Category: categories[rng.Intn(3)],
				SessionID: fmt.Sprintf("s%d", 1+rng.Intn(4)), Summary: words[rng.Intn(3)],
				RepoID: id.repo, WorktreeID: id.worktree, JJRepoID: id.jjRepo, JJWorkspaceID: id.jjWorkspace,
			})
		}
		// Midnight boundaries: last nanosecond of the day and the first of the next.
		evs = append(evs,
			event.Event{ID: fmt.Sprintf("edge-end-%02d", day), Time: dayOf(day, 23, 59, 59).Add(999999999 * time.Nanosecond), Source: "codex", Category: event.CategoryMeta, SessionID: "s1", Summary: "alpha edge", RepoID: "repoA", WorktreeID: "wsA1"},
			event.Event{ID: fmt.Sprintf("edge-start-%02d", day), Time: dayOf(day, 0, 0, 0), Source: "codex", Category: event.CategoryMeta, SessionID: "s1", Summary: "beta edge", RepoID: "repoA", WorktreeID: "wsA1"},
		)
	}
	// Replayed stable IDs (crash-window duplicates), including one whose second
	// physical record lands in a different day file.
	evs = append(evs, evs[len(evs)/10], evs[len(evs)/10+1], evs[len(evs)/3])
	moved := evs[len(evs)/2]
	moved.Time = moved.Time.Add(72 * time.Hour)
	evs = append(evs, moved)
	return evs
}

func TestTimelineMatchesFullScanReferenceAcrossPagesAndFilters(t *testing.T) {
	for _, withGap := range []bool{false, true} {
		t.Run(fmt.Sprintf("corrupt_record=%v", withGap), func(t *testing.T) {
			dir := t.TempDir()
			writeSpool(t, dir, fixtureEvents())
			if withGap {
				f, err := os.OpenFile(filepath.Join(dir, dayName(6)+".ndjson"), os.O_APPEND|os.O_WRONLY, 0o644)
				if err != nil {
					t.Fatal(err)
				}
				f.WriteString("{not json at all\n")
				f.Close()
			}
			rec := &scanRecorder{}
			e := newRecordingEngine(t, dir, rec)
			queries := map[string]TimelineQuery{
				"unscoped":        {},
				"repo":            {RepoID: "repoA"},
				"repo+aliases":    {RepoID: "repoA", RepoAliases: []string{"repoA-old"}},
				"repo+workspace":  {RepoID: "repoA", RepoAliases: []string{"repoA-old"}, WorkspaceID: "wsA1", WorkspaceAliases: []string{"wsA1-old"}},
				"jj":              {RepoID: "jj:repoC", WorkspaceID: "jj:wsC1"},
				"mixed git+jj":    {RepoID: "repoB", RepoAliases: []string{"jj:repoC", "repoA-old"}},
				"source+session":  {RepoID: "repoB", Source: "codex", SessionID: "s2"},
				"category":        {RepoID: "repoA", Category: "tool"},
				"search":          {RepoID: "repoA", Search: "ALPHA"},
				"workspace only":  {WorkspaceID: "wsB1"},
				"missing repo":    {RepoID: "repoMissing"},
				"session only":    {Source: "claude-code", SessionID: "s3"},
				"search no match": {RepoID: "repoA", Search: "zzz-none"},
			}
			names := make([]string, 0, len(queries))
			for name := range queries {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				for _, limit := range []int{1, 7, 50, 1000} {
					// Page through at most maxPages: enough to cross many day boundaries
					// without re-reading the whole reference spool hundreds of times.
					const maxPages = 25
					q := queries[name]
					q.Limit = limit
					for pageNo := 0; pageNo < maxPages; pageNo++ {
						want := referenceTimeline(t, dir, q)
						got, err := e.Timeline(context.Background(), q)
						if err != nil {
							t.Fatalf("%s/limit=%d page %d: %v", name, limit, pageNo, err)
						}
						if !reflect.DeepEqual(ids(got.Events), ids(want.Events)) || got.HasMore != want.HasMore || got.NextCursor != want.NextCursor || got.CaptureGap != want.CaptureGap || got.Order != want.Order {
							t.Fatalf("%s/limit=%d page %d diverged from full scan:\n got  %v more=%v cursor=%q gap=%v\n want %v more=%v cursor=%q gap=%v", name, limit, pageNo, ids(got.Events), got.HasMore, got.NextCursor, got.CaptureGap, ids(want.Events), want.HasMore, want.NextCursor, want.CaptureGap)
						}
						if !reflect.DeepEqual(got.Events, want.Events) {
							t.Fatalf("%s/limit=%d page %d: event bodies differ", name, limit, pageNo)
						}
						if !want.HasMore {
							break
						}
						q.Cursor = want.NextCursor
					}
				}
			}
			if withGap {
				page, _ := e.Timeline(context.Background(), TimelineQuery{RepoID: "repoB"})
				if !page.CaptureGap {
					t.Fatal("capture_gap must stay true when the spool holds an unreadable record")
				}
			}
		})
	}
}

func TestTimelineReadsOnlyDaysThatMentionTheRepository(t *testing.T) {
	var evs []event.Event
	for day := 1; day <= 8; day++ { // old days: only an unrelated repository
		for k := 0; k < 30; k++ {
			evs = append(evs, event.Event{ID: fmt.Sprintf("other-%d-%d", day, k), Time: dayOf(day, 10, k, 0), Source: "codex", Category: event.CategoryMeta, RepoID: "other", WorktreeID: "other-ws"})
		}
	}
	for day := 9; day <= 10; day++ {
		for k := 0; k < 5; k++ {
			evs = append(evs, event.Event{ID: fmt.Sprintf("target-%d-%d", day, k), Time: dayOf(day, 11, k, 0), Source: "codex", Category: event.CategoryMeta, RepoID: "target"})
			evs = append(evs, event.Event{ID: fmt.Sprintf("noise-%d-%d", day, k), Time: dayOf(day, 11, k, 30), Source: "codex", Category: event.CategoryMeta, RepoID: "other"})
		}
	}
	dir := t.TempDir()
	writeSpool(t, dir, evs)
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)

	page, err := e.Timeline(context.Background(), TimelineQuery{RepoID: "target", Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids(page.Events), []string{"target-10-4", "target-10-3", "target-10-2"}) || !page.HasMore {
		t.Fatalf("page = %v more=%v", ids(page.Events), page.HasMore)
	}
	if got := rec.scanned(); !reflect.DeepEqual(got, []string{dayName(10)}) {
		t.Fatalf("limit+1 matches all live in the newest day, so only that day may be read; read %v", got)
	}

	rec.reset()
	page, err = e.Timeline(context.Background(), TimelineQuery{RepoID: "target", Limit: 1000})
	if err != nil || len(page.Events) != 10 || page.HasMore {
		t.Fatalf("all: %v %v", ids(page.Events), err)
	}
	if got := rec.scanned(); !reflect.DeepEqual(got, []string{dayName(10), dayName(9)}) {
		t.Fatalf("days 1-8 never mention the repository and must not be opened; read %v", got)
	}

	rec.reset()
	if page, err = e.Timeline(context.Background(), TimelineQuery{RepoID: "unknown-repo"}); err != nil || len(page.Events) != 0 || len(rec.scanned()) != 0 {
		t.Fatalf("unknown repo read %v: %v %v", rec.scanned(), ids(page.Events), err)
	}
}

func TestTimelineStopsAtLimitPlusOneAndSkipsDaysNewerThanTheCursor(t *testing.T) {
	var evs []event.Event
	for day := 1; day <= 10; day++ {
		for k := 0; k < 5; k++ {
			evs = append(evs, event.Event{ID: fmt.Sprintf("r-%02d-%d", day, k), Time: dayOf(day, 12, k, 0), Source: "codex", Category: event.CategoryMeta, RepoID: "repo"})
		}
	}
	dir := t.TempDir()
	writeSpool(t, dir, evs)
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)

	page, err := e.Timeline(context.Background(), TimelineQuery{RepoID: "repo", Limit: 7})
	if err != nil || len(page.Events) != 7 || !page.HasMore {
		t.Fatalf("page 1: %v %v", ids(page.Events), err)
	}
	if got := rec.scanned(); !reflect.DeepEqual(got, []string{dayName(10), dayName(9)}) {
		t.Fatalf("8 matches are available after two days; read %v", got)
	}

	// Page 2 resumes inside 06-09; the newer 06-10 file must not be reopened.
	rec.reset()
	page2, err := e.Timeline(context.Background(), TimelineQuery{RepoID: "repo", Limit: 7, Cursor: page.NextCursor})
	if err != nil || len(page2.Events) != 7 || page2.Events[0].ID != "r-09-2" {
		t.Fatalf("page 2: %v %v", ids(page2.Events), err)
	}
	if got := rec.scanned(); len(got) == 0 || got[0] != dayName(9) {
		t.Fatalf("days newer than the cursor must be skipped; read %v", got)
	}
	for _, d := range rec.scanned() {
		if d > dayName(9) {
			t.Fatalf("read %s, newer than the cursor day", d)
		}
	}
}

func TestTimelineCancellationStopsScanningPromptly(t *testing.T) {
	var evs []event.Event
	for day := 1; day <= 10; day++ {
		evs = append(evs, event.Event{ID: fmt.Sprintf("r-%02d", day), Time: dayOf(day, 12, 0, 0), Source: "codex", Category: event.CategoryMeta, RepoID: "repo", Summary: "rare"})
	}
	dir := t.TempDir()
	writeSpool(t, dir, evs)

	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	_, err := e.Timeline(cancelled, TimelineQuery{RepoID: "repo"})
	if !errors.Is(err, context.Canceled) || time.Since(start) > time.Second || len(rec.scanned()) != 0 {
		t.Fatalf("pre-cancelled: err=%v read=%v after %v", err, rec.scanned(), time.Since(start))
	}

	// Cancelled between day files: no further day is opened.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rec.reset()
	rec.before = func(day string) {
		if day == dayName(8) {
			cancel()
		}
	}
	_, err = e.Timeline(ctx, TimelineQuery{RepoID: "repo", Search: "no-match-forces-a-full-walk", Limit: 5})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("mid-scan: err = %v", err)
	}
	if got := rec.scanned(); !reflect.DeepEqual(got, []string{dayName(10), dayName(9), dayName(8)}) {
		t.Fatalf("scan continued after cancellation: %v", got)
	}

	// An expired deadline is reported the same way.
	expired, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer stop()
	if _, err = e.Timeline(expired, TimelineQuery{RepoID: "repo"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
}

func TestTimelineAliasesSpanGitAndJJIdentitiesAcrossDays(t *testing.T) {
	evs := []event.Event{
		{ID: "old", Time: dayOf(1, 9, 0, 0), RepoID: "old-repo", WorktreeID: "old-ws"},
		{ID: "digest", Time: dayOf(2, 9, 0, 0), RepoID: "current-digest", WorktreeID: "ws-digest"},
		{ID: "jj", Time: dayOf(3, 9, 0, 0), JJRepoID: "jj:r", JJWorkspaceID: "jj:w"},
		{ID: "unrelated", Time: dayOf(4, 9, 0, 0), RepoID: "elsewhere", WorktreeID: "elsewhere-ws"},
	}
	for i := range evs {
		evs[i].Source = "codex"
		evs[i].Category = event.CategoryMeta
	}
	dir := t.TempDir()
	writeSpool(t, dir, evs)
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)

	page, err := e.Timeline(context.Background(), TimelineQuery{RepoID: "current-digest", RepoAliases: []string{"old-repo", "jj:r"}})
	if err != nil || !reflect.DeepEqual(ids(page.Events), []string{"jj", "digest", "old"}) {
		t.Fatalf("aliases: %v %v", ids(page.Events), err)
	}
	if got := rec.scanned(); !reflect.DeepEqual(got, []string{dayName(3), dayName(2), dayName(1)}) {
		t.Fatalf("alias union must read exactly the three alias days; read %v", got)
	}

	rec.reset()
	page, err = e.Timeline(context.Background(), TimelineQuery{RepoID: "current-digest", RepoAliases: []string{"old-repo", "jj:r"}, WorkspaceID: "ws-now", WorkspaceAliases: []string{"old-ws"}})
	if err != nil || !reflect.DeepEqual(ids(page.Events), []string{"old"}) {
		t.Fatalf("scoped aliases: %v %v", ids(page.Events), err)
	}
	if got := rec.scanned(); !reflect.DeepEqual(got, []string{dayName(1)}) {
		t.Fatalf("repo and workspace day sets must intersect; read %v", got)
	}

	rec.reset()
	page, err = e.Timeline(context.Background(), TimelineQuery{RepoID: "jj:r", WorkspaceID: "jj:w"})
	if err != nil || !reflect.DeepEqual(ids(page.Events), []string{"jj"}) || !reflect.DeepEqual(rec.scanned(), []string{dayName(3)}) {
		t.Fatalf("jj: %v read=%v %v", ids(page.Events), rec.scanned(), err)
	}
}

func TestTimelineIndexFollowsLiveAdmissionAndReconciliation(t *testing.T) {
	dir := t.TempDir()
	writeSpool(t, dir, []event.Event{
		{ID: "old", Time: dayOf(1, 9, 0, 0), Source: "codex", Category: event.CategoryMeta, RepoID: "repo"},
	})
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- e.Run(ctx) }()
	defer func() {
		cancel()
		<-done
	}()

	// Live Admission to a day the rebuilt index has never seen.
	if _, err := e.Admit(context.Background(), event.Event{ID: "admitted", Time: dayOf(5, 9, 0, 0), Source: "codex", Category: event.CategoryMeta, RepoID: "repo"}); err != nil {
		t.Fatal(err)
	}
	page, err := e.Timeline(context.Background(), TimelineQuery{RepoID: "repo"})
	if err != nil || !reflect.DeepEqual(ids(page.Events), []string{"admitted", "old"}) {
		t.Fatalf("after live Admit: %v %v", ids(page.Events), err)
	}

	// A one-shot writer in another process reconciles through the tailer.
	if _, err := spool.NewWriter(dir).Append(event.Event{ID: "reconciled", Time: dayOf(9, 9, 0, 0), Source: "codex", Category: event.CategoryMeta, RepoID: "repo"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		page, err = e.Timeline(context.Background(), TimelineQuery{RepoID: "repo"})
		if err == nil && len(page.Events) == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reconciled event never reached the timeline: %v %v", ids(page.Events), err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !reflect.DeepEqual(ids(page.Events), []string{"reconciled", "admitted", "old"}) {
		t.Fatalf("after reconciliation: %v", ids(page.Events))
	}

	// A fresh engine rebuilds the same index from the spool alone.
	rebuilt := newRecordingEngine(t, dir, &scanRecorder{})
	again, err := rebuilt.Timeline(context.Background(), TimelineQuery{RepoID: "repo"})
	if err != nil || !reflect.DeepEqual(ids(again.Events), []string{"reconciled", "admitted", "old"}) {
		t.Fatalf("rebuilt: %v %v", ids(again.Events), err)
	}
	if got := rebuilt.projection.IdentityDays([]string{"repo"}); !reflect.DeepEqual(got, []string{dayName(1), dayName(5), dayName(9)}) {
		t.Fatalf("rebuilt index days = %v", got)
	}
}
