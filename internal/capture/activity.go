package capture

import (
	"agentfirehose/internal/capture/internal/projection"
	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"context"
	"fmt"
	"sort"
	"time"
)

// ActivityPathCap bounds the paths in one Activity result; the hottest are kept.
const ActivityPathCap = 2000

// ActivityQuery scopes Heat to one repository identity and a [From, To) window.
type ActivityQuery struct {
	RepoID, WorkspaceID           string
	RepoAliases, WorkspaceAliases []string
	From, To                      time.Time
	Bucket                        time.Duration
	// Resolve maps one captured path to its display group and path.
	Resolve func(ev event.Event, path string) (group, rel string)
}

// ActivityPath is one path's Heat: sparse [bucket_index, count] pairs in
// ascending index order, and their sum.
type ActivityPath struct {
	Path  string   `json:"path"`
	Group string   `json:"group"`
	Total int      `json:"total"`
	Heat  [][2]int `json:"heat"`
}

type ActivityResult struct {
	From, To             time.Time
	BucketSeconds        int
	Buckets              int
	Paths                []ActivityPath
	FileEvents           int
	UnreadableFileEvents int
	Truncated            bool
	TruncatedTotal       int
	ErrorPaths           []ActivityErrorPath
	OmittedErrorPaths    int
	CaptureGap           bool
}

// ActivityWindow floors from to a multiple of bucket in UTC, so a live refresh
// never shifts columns, and returns the bucket count covering [from, to).
func ActivityWindow(from, to time.Time, bucket time.Duration) (time.Time, int) {
	if bucket <= 0 {
		return from.UTC(), 0
	}
	floored := from.UTC().Truncate(bucket)
	span := to.Sub(floored)
	if span <= 0 {
		return floored, 0
	}
	return floored, int((span + bucket - 1) / bucket)
}

// Activity counts file-category observations per path per time bucket.
//
// Like Timeline it never reads the whole spool: the Projection's identity
// index names the day files that can hold a matching event, and only those
// UTC days that overlap [From, To) are read. Cost is bounded by the window's
// days, and ctx is honoured between and inside day files.
func (e *Engine) Activity(ctx context.Context, q ActivityQuery) (ActivityResult, error) {
	out := ActivityResult{Paths: []ActivityPath{}}
	if q.RepoID == "" {
		return out, fmt.Errorf("activity requires a repository")
	}
	if q.Bucket <= 0 || !q.From.Before(q.To) {
		return out, fmt.Errorf("activity requires from < to and a positive bucket")
	}
	from, buckets := ActivityWindow(q.From, q.To, q.Bucket)
	out.From, out.To, out.Buckets, out.BucketSeconds = from, q.To.UTC(), buckets, int(q.Bucket/time.Second)
	if err := ctx.Err(); err != nil {
		return out, err
	}
	resolve := q.Resolve
	if resolve == nil {
		resolve = func(_ event.Event, path string) (string, string) { return "", path }
	}

	repo := identityValues(q.RepoID, q.RepoAliases)
	workspace := identityValues(q.WorkspaceID, q.WorkspaceAliases)
	var groups [][]string
	var filter spool.Prefilter
	for _, values := range [][]string{repo, workspace} {
		if values == nil {
			continue
		}
		groups = append(groups, values)
		if needles, ok := spool.IdentityNeedles(values); ok {
			filter = append(filter, needles)
		}
	}
	firstDay, lastDay := from.Format("2006-01-02"), out.To.Add(-time.Nanosecond).Format("2006-01-02")

	type key struct{ group, path string }
	heat := map[key]map[int]int{}
	errorCounts := map[activityPathKey]map[string]map[int]int{}
	seen := map[string]bool{}
	onGap := func() { out.CaptureGap = true }
	for _, day := range e.projection.TimelineDays(groups, "") {
		if day < firstDay || day > lastDay {
			continue // no event in this file can fall inside the window
		}
		if err := ctx.Err(); err != nil {
			return out, err
		}
		err := e.scanDay(ctx, e.spoolDir, day, filter, onGap, func(ev event.Event) {
			if !identityMatches(q.RepoID, q.RepoAliases, ev.RepoID, ev.JJRepoID) || !identityMatches(q.WorkspaceID, q.WorkspaceAliases, ev.WorktreeID, ev.JJWorkspaceID) {
				return
			}
			if ev.Time.Before(from) || !ev.Time.Before(out.To) {
				return
			}
			signature, isError := projection.ErrorObservationKey(ev)
			if ev.Category != event.CategoryFile && !isError {
				return // unrelated history never enters the aggregation dedupe set
			}
			if ev.ID != "" {
				// A stable ID replayed into a different day file keeps its
				// first (canonical) record, exactly as Timeline does.
				if canonical := e.projection.EventDay(ev.ID); (canonical != "" && canonical != day) || seen[ev.ID] {
					return
				}
				seen[ev.ID] = true
			}
			paths := projection.EventActivityPaths(ev)
			bucket := int(ev.Time.Sub(from) / q.Bucket)
			if isError {
				// Read explicit path fields on this error only; keep its original
				// category for signature identity and Heat eligibility.
				pathEvent := ev
				pathEvent.Category = event.CategoryFile
				paths = projection.EventActivityPaths(pathEvent)
				resolved := map[activityPathKey]bool{}
				for _, p := range paths {
					group, rel := resolve(ev, p)
					k := activityPathKey{group, rel}
					if resolved[k] {
						continue
					}
					resolved[k] = true
					if errorCounts[k] == nil {
						errorCounts[k] = map[string]map[int]int{}
					}
					if errorCounts[k][signature] == nil {
						errorCounts[k][signature] = map[int]int{}
					}
					errorCounts[k][signature][bucket]++
				}
			}
			if ev.Category != event.CategoryFile {
				return
			}
			out.FileEvents++
			if len(paths) == 0 {
				out.UnreadableFileEvents++
				return
			}
			for _, p := range paths {
				group, rel := resolve(ev, p)
				k := key{group, rel}
				if heat[k] == nil {
					heat[k] = map[int]int{}
				}
				heat[k][bucket]++
			}
		})
		if err != nil {
			return out, err
		}
	}
	if e.projection.ReadGap() {
		out.CaptureGap = true
	}

	out.ErrorPaths, out.OmittedErrorPaths = activityErrorPaths(errorCounts)
	for k, counts := range heat {
		p := ActivityPath{Path: k.path, Group: k.group, Heat: make([][2]int, 0, len(counts))}
		for i, n := range counts {
			p.Heat = append(p.Heat, [2]int{i, n})
			p.Total += n
		}
		sort.Slice(p.Heat, func(i, j int) bool { return p.Heat[i][0] < p.Heat[j][0] })
		out.Paths = append(out.Paths, p)
	}
	layoutOrder := func(a, b ActivityPath) bool {
		if a.Group != b.Group {
			return a.Group < b.Group
		}
		return a.Path < b.Path
	}
	if len(out.Paths) > ActivityPathCap {
		sort.Slice(out.Paths, func(i, j int) bool {
			a, b := out.Paths[i], out.Paths[j]
			if a.Total != b.Total {
				return a.Total > b.Total
			}
			return layoutOrder(a, b)
		})
		for _, p := range out.Paths[ActivityPathCap:] {
			out.TruncatedTotal += p.Total
		}
		out.Paths, out.Truncated = out.Paths[:ActivityPathCap], true
	}
	sort.Slice(out.Paths, func(i, j int) bool { return layoutOrder(out.Paths[i], out.Paths[j]) })
	return out, nil
}
