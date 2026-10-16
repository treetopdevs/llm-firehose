package capture

import (
	"agentfirehose/internal/capture/internal/projection"
	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strings"
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
			if ev.Category != event.CategoryFile || !identityMatches(q.RepoID, q.RepoAliases, ev.RepoID, ev.JJRepoID) || !identityMatches(q.WorkspaceID, q.WorkspaceAliases, ev.WorktreeID, ev.JJWorkspaceID) {
				return
			}
			if ev.Time.Before(from) || !ev.Time.Before(out.To) {
				return
			}
			if ev.ID != "" {
				// A stable ID replayed into a different day file keeps its
				// first (canonical) record, exactly as Timeline does.
				if canonical := e.projection.EventDay(ev.ID); (canonical != "" && canonical != day) || seen[ev.ID] {
					return
				}
				seen[ev.ID] = true
			}
			out.FileEvents++
			paths := activityPaths(ev)
			if len(paths) == 0 {
				out.UnreadableFileEvents++
				return
			}
			bucket := int(ev.Time.Sub(from) / q.Bucket)
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

// activityPaths extracts an event's paths. A minimal-mode record holds a
// {sha256,len} digest where a codex changes map was; that is no path at all.
// A Codex apply_patch call names its paths only in its patch text, and its
// rollout output only in its result text; both are read here and not by the
// projection, so /artifacts/files is unchanged.
func activityPaths(ev event.Event) []string {
	if changes, ok := ev.Payload["changes"].(map[string]any); ok && isDigest(changes) {
		ev.Payload = maps.Clone(ev.Payload)
		delete(ev.Payload, "changes")
	}
	if paths := projection.EventFilePaths(ev); len(paths) > 0 {
		return paths
	}
	if paths := applyPatchPaths(applyPatchText(ev.Payload)); len(paths) > 0 {
		return paths
	}
	return applyPatchSummaryPaths(applyPatchOutput(ev.Payload))
}

// applyPatchText is a Codex apply_patch call's patch: the rollout
// custom_tool_call's input, or the hook's tool_input.command. A minimal-mode
// digest is not a string and yields nothing.
func applyPatchText(payload map[string]any) string {
	if payload["tool_name"] != "apply_patch" {
		return ""
	}
	if s, ok := payload["input"].(string); ok {
		return s
	}
	if in, ok := payload["tool_input"].(map[string]any); ok {
		s, _ := in["command"].(string)
		return s
	}
	return ""
}

var applyPatchHeaders = []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "}

// applyPatchPaths returns the paths a patch's file headers name, in order and
// once each. Only newline-terminated lines count: balanced mode cuts long text
// at 240 runes and ends it with "…", so an unterminated last line may hold a
// cut path.
func applyPatchPaths(text string) []string {
	var out []string
	for {
		line, rest, ok := strings.Cut(text, "\n")
		if !ok {
			return out
		}
		text = rest
		for _, h := range applyPatchHeaders {
			if p, ok := strings.CutPrefix(line, h); ok && p != "" && !slices.Contains(out, p) {
				out = append(out, p)
			}
		}
	}
}

// applyPatchOutput is the result text of a Codex rollout
// custom_tool_call_output for apply_patch, which carries no patch text. The
// hook's PostToolUse also has an output, but only its patch text is read.
func applyPatchOutput(payload map[string]any) string {
	if payload["tool_name"] != "apply_patch" || payload["input"] != nil || payload["tool_input"] != nil {
		return ""
	}
	s, _ := payload["output"].(string)
	return s
}

const applyPatchSummary = "Success. Updated the following files:\n"

// applyPatchSummaryPaths returns the paths an apply_patch result lists after
// its "Success. Updated the following files:" line, one "A ", "M " or "D " line
// each, in order and once each. Older captures wrap the text in
// {"output": ...}. As for headers, only newline-terminated lines count, so a
// line cut by truncation is no path; a failure lists nothing.
func applyPatchSummaryPaths(output string) []string {
	if strings.HasPrefix(output, "{") {
		output = unwrapApplyPatchOutput(output)
	}
	text, ok := strings.CutPrefix(output, applyPatchSummary)
	if !ok {
		if _, text, ok = strings.Cut(output, "\n"+applyPatchSummary); !ok {
			return nil
		}
	}
	var out []string
	for {
		line, rest, ok := strings.Cut(text, "\n")
		if !ok || len(line) < 2 || !strings.ContainsRune("AMD", rune(line[0])) || line[1] != ' ' {
			return out
		}
		text = rest
		if p := line[2:]; p != "" && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
}

// unwrapApplyPatchOutput returns the "output" string of a JSON-wrapped result.
// A wrapper cut by truncation inside that string is read up to its last
// complete "\n" escape.
func unwrapApplyPatchOutput(s string) string {
	var w struct {
		Output string `json:"output"`
	}
	if json.Unmarshal([]byte(s), &w) == nil {
		return w.Output
	}
	lit, ok := strings.CutPrefix(s, `{"output":"`)
	if !ok {
		return ""
	}
	end := 0
scan:
	for i := 0; i < len(lit); i++ {
		switch lit[i] {
		case '"':
			end = i
			break scan
		case '\\':
			i++
			if i < len(lit) && lit[i] == 'n' {
				end = i + 1
			}
		}
	}
	var out string
	if json.Unmarshal([]byte(`"`+lit[:end]+`"`), &out) != nil {
		return ""
	}
	return out
}

func isDigest(v map[string]any) bool {
	_, hasSum := v["sha256"].(string)
	_, hasLen := v["len"]
	return len(v) == 2 && hasSum && hasLen
}
