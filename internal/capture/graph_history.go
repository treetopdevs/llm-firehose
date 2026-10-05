package capture

import (
	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
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

func (e *Engine) Timeline(q TimelineQuery) (TimelinePage, error) {
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
	if q.Cursor != "" {
		data, err := base64.RawURLEncoding.DecodeString(q.Cursor)
		if err != nil {
			return out, fmt.Errorf("invalid cursor")
		}
		if json.Unmarshal(data, &cursor) != nil || cursor.Time.IsZero() {
			return out, fmt.Errorf("invalid cursor")
		}
	}
	events, gap, err := spool.ReadForProjection(e.spoolDir)
	if err != nil {
		return out, err
	}
	out.CaptureGap = gap
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
	return out, nil
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
