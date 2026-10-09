package capture

import (
	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// TimelineQuery scopes historical observations, never a session's current position.
type TimelineQuery struct {
	RepoID, WorkspaceID, Source, SessionID, Category, Search, Cursor string
	RepoAliases, WorkspaceAliases                                    []string
	Limit                                                            int
}
type TimelinePage struct {
	Events     []event.Event `json:"events"`
	NextCursor string        `json:"next_cursor,omitempty"`
	HasMore    bool          `json:"has_more"`
	Order      string        `json:"order"`
	CaptureGap bool          `json:"capture_gap"`
}
type timelineCursor struct {
	Time time.Time `json:"time"`
	ID   string    `json:"id"`
}

// Timeline returns one newest-first page of historical observations.
//
// It never reads the whole spool. The Projection's identity index names the UTC
// day files that can hold a matching event (the repository identity plus its
// aliases, intersected with the workspace identity and session when scoped).
// Those days are read newest first and the walk stops as soon as limit+1
// matching events strictly older than the cursor are in hand: every event in an
// older day file sorts after every event in a newer one, so nothing later can
// enter the page. Cost is bounded by the days actually needed for the page, not
// by spool size, and ctx is honoured between and inside day files.
func (e *Engine) Timeline(ctx context.Context, q TimelineQuery) (TimelinePage, error) {
	out := TimelinePage{Events: []event.Event{}, Order: "newest_first"}
	if q.SessionID != "" && q.Source == "" {
		return out, fmt.Errorf("session_id requires source")
	}
	if q.Limit <= 0 {
		q.Limit = 200
	}
	if q.Limit > 1000 {
		q.Limit = 1000
	}
	var cursor timelineCursor
	cursorDay := ""
	if q.Cursor != "" {
		data, err := base64.RawURLEncoding.DecodeString(q.Cursor)
		if err != nil {
			return out, fmt.Errorf("invalid cursor")
		}
		if json.Unmarshal(data, &cursor) != nil || cursor.Time.IsZero() {
			return out, fmt.Errorf("invalid cursor")
		}
		cursorDay = cursor.Time.UTC().Format("2006-01-02")
	}
	if err := ctx.Err(); err != nil {
		return out, err
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
	days := e.projection.TimelineDays(groups, q.SessionID)

	seen := map[string]bool{}
	search := strings.ToLower(q.Search)
	onGap := func() { out.CaptureGap = true }
	matched := []event.Event{}
	for _, day := range days {
		if cursorDay != "" && day > cursorDay {
			continue // every event in this file is newer than the cursor
		}
		if err := ctx.Err(); err != nil {
			return out, err
		}
		err := e.scanDay(ctx, e.spoolDir, day, filter, onGap, func(ev event.Event) {
			if !identityMatches(q.RepoID, q.RepoAliases, ev.RepoID, ev.JJRepoID) || !identityMatches(q.WorkspaceID, q.WorkspaceAliases, ev.WorktreeID, ev.JJWorkspaceID) || q.Source != "" && ev.Source != q.Source || q.SessionID != "" && ev.SessionID != q.SessionID || q.Category != "" && string(ev.Category) != q.Category {
				return
			}
			if search != "" && !strings.Contains(strings.ToLower(ev.Summary+" "+ev.Name+" "+ev.Agent+" "+ev.Source+" "+ev.SessionID), search) {
				return
			}
			if !cursor.Time.IsZero() && (ev.Time.After(cursor.Time) || ev.Time.Equal(cursor.Time) && ev.ID >= cursor.ID) {
				return
			}
			if ev.ID != "" {
				// A stable ID replayed into a different day file keeps its
				// first (canonical) record, exactly as a full read in file
				// order would; replays within one file collapse here too.
				if canonical := e.projection.EventDay(ev.ID); (canonical != "" && canonical != day) || seen[ev.ID] {
					return
				}
				seen[ev.ID] = true
			}
			matched = append(matched, ev)
		})
		if err != nil {
			return out, err
		}
		if len(matched) > q.Limit {
			break
		}
	}
	// Unreadable records seen at rebuild or by the live tailer are missing
	// evidence for any query, scanned here or not.
	if e.projection.ReadGap() {
		out.CaptureGap = true
	}
	sort.SliceStable(matched, func(i, j int) bool {
		a, b := matched[i], matched[j]
		if a.Time.Equal(b.Time) {
			return a.ID > b.ID
		}
		return a.Time.After(b.Time)
	})
	out.Events = matched
	if len(out.Events) > q.Limit {
		out.HasMore = true
		out.Events = out.Events[:q.Limit]
		last := out.Events[len(out.Events)-1]
		data, _ := json.Marshal(timelineCursor{last.Time, last.ID})
		out.NextCursor = base64.RawURLEncoding.EncodeToString(data)
	}
	return out, nil
}

// identityValues returns an identity and its aliases without empty values, or
// nil when the query does not scope by this identity.
func identityValues(id string, aliases []string) []string {
	if id == "" {
		return nil
	}
	out := []string{id}
	for _, alias := range aliases {
		if alias != "" {
			out = append(out, alias)
		}
	}
	return out
}

// ObservedRoots returns only local paths observed before privacy processing.
// This bounded runtime discovery hint is not persisted in the event spool.
func (e *Engine) ObservedRoots() []string {
	e.rootsMu.RLock()
	defer e.rootsMu.RUnlock()
	out := make([]string, 0, len(e.roots))
	for root := range e.roots {
		out = append(out, root)
	}
	sort.Strings(out)
	return out
}

func identityMatches(id string, aliases []string, values ...string) bool {
	if id == "" {
		return true
	}
	for _, v := range values {
		if v == "" {
			continue
		}
		if v == id {
			return true
		}
		for _, alias := range aliases {
			if v == alias {
				return true
			}
		}
	}
	return false
}
