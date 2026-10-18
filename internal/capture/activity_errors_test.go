package capture

import (
	"agentfirehose/internal/event"
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

// Contract mutations of real normalized file records, not invented adapter payloads.
func TestActivityErrorsKeepHeatSeparateAndUseCanonicalSignatures(t *testing.T) {
	s := realShapes(t)
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	a := shapeAt(t, s, editPost, "error-a", base.Add(time.Minute))
	a.Severity = event.SeverityError
	a.Summary = "failed edit 12"
	b := a
	b.ID = "error-b"
	b.Time = base.Add(16 * time.Minute)
	b.Summary = "failed edit 99"
	c := a
	c.ID = "error-only"
	c.Category = event.CategoryError
	c.Payload = map[string]any{"file_path": "/work/proj/error-only.go"}
	noPath := a
	noPath.ID = "no-path"
	noPath.Payload = nil
	wrongRepo := a
	wrongRepo.ID = "other-repo"
	wrongRepo.RepoID = "other"
	outside := a
	outside.ID = "outside"
	outside.Time = base.Add(time.Hour)
	e, _ := activityEngine(t, []event.Event{a, b, b, c, noPath, wrongRepo, outside})
	r, err := e.Activity(context.Background(), activityQuery(base, base.Add(time.Hour), 15*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if r.FileEvents != 3 || len(r.Paths) != 1 || r.Paths[0].Total != 2 {
		t.Fatalf("Heat changed: %+v", r)
	}
	if len(r.ErrorPaths) != 2 {
		t.Fatalf("error paths: %+v", r.ErrorPaths)
	}
	p := r.ErrorPaths[0]
	if p.Path != "plans/waiting-on-you.html" || p.Total != 2 || len(p.Signatures) != 1 || !reflect.DeepEqual(p.Signatures[0].Counts, [][2]int{{0, 1}, {1, 1}}) {
		t.Fatalf("bad recurrence: %+v", p)
	}
	sigs := e.projection.ErrorSignatures("")
	found := false
	for _, sig := range sigs {
		if sig.Key == p.Signatures[0].Key {
			found = true
		}
	}
	if !found {
		t.Fatalf("not canonical: %s", p.Signatures[0].Key)
	}
	if r.ErrorPaths[1].Path != "error-only.go" {
		t.Fatalf("error-only path missing: %+v", r.ErrorPaths)
	}
}

func TestActivityErrorCapsAreDeterministic(t *testing.T) {
	// Aggregation contract seam: counts are normalized observations, not raw source payloads.
	counts := map[activityPathKey]map[string]map[int]int{}
	for i := 0; i < ActivityPathCap+1; i++ {
		counts[activityPathKey{"", fmt.Sprintf("%04d", i)}] = map[string]map[int]int{"one": {0: 1}}
	}
	for i := 0; i < 22; i++ {
		counts[activityPathKey{"", "0000"}][fmt.Sprintf("signature-%02d", i)] = map[int]int{0: 1}
	}
	paths, omitted := activityErrorPaths(counts)
	if len(paths) != ActivityPathCap || omitted != 1 || paths[0].Path != "0000" || len(paths[0].Signatures) != 20 || paths[0].OmittedSignatures != 3 {
		t.Fatalf("caps: %d %d %+v", len(paths), omitted, paths[0])
	}
	again, _ := activityErrorPaths(counts)
	if !reflect.DeepEqual(paths, again) {
		t.Fatal("nondeterministic")
	}
}

func TestActivityErrorsCountAnObservationOncePerResolvedPath(t *testing.T) {
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	ev := shapeAt(t, realShapes(t), "codex patch_apply_end", "alias-error", base)
	ev.Severity = event.SeverityError
	ev.Payload = map[string]any{"changes": map[string]any{"/work/a.go": true, "a.go": true}}
	e, _ := activityEngine(t, []event.Event{ev})
	q := activityQuery(base, base.Add(time.Hour), time.Minute)
	q.Resolve = func(event.Event, string) (string, string) { return "", "a.go" }
	r, err := e.Activity(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.ErrorPaths) != 1 || r.ErrorPaths[0].Total != 1 {
		t.Fatalf("one observation must not fabricate recurrence: %+v", r.ErrorPaths)
	}
}
