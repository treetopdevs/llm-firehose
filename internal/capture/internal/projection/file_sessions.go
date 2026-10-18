package projection

import (
	"sort"
	"time"

	"agentfirehose/internal/event"
)

// FileSession counts captured file observations in one exact recorded scope.
// Workspace is a label, not a claim of physical-file identity or concurrency.
type FileSession struct {
	WorkspaceKind string    `json:"workspace_kind"`
	Workspace     string    `json:"workspace"`
	Path          string    `json:"path"`
	Source        string    `json:"source"`
	SessionID     string    `json:"session_id"`
	Events        int       `json:"events"`
	FirstTime     time.Time `json:"first_time"`
	LastTime      time.Time `json:"last_time"`
	LastEventID   string    `json:"last_event_id"`
}

type fileSessionKey struct{ kind, workspace, path, source, session string }

func recordedFileScope(ev event.Event) (string, string) {
	for _, scope := range []struct{ kind, value string }{{"worktree_id", ev.WorktreeID}, {"jj_workspace_id", ev.JJWorkspaceID}, {"cwd", ev.CWD}} {
		if scope.value != "" {
			return scope.kind, scope.value
		}
	}
	return "unknown", ""
}

// Called only after normal duplicate admission, while the projection is locked.
func (ix *Projection) foldFileSession(ev event.Event, path string) {
	kind, workspace := recordedFileScope(ev)
	key := fileSessionKey{kind, workspace, path, ev.Source, ev.SessionID}
	row := ix.fileSessions[key]
	if row == nil {
		row = &FileSession{WorkspaceKind: kind, Workspace: workspace, Path: path, Source: ev.Source, SessionID: ev.SessionID, FirstTime: ev.Time, LastTime: ev.Time, LastEventID: ev.ID}
		ix.fileSessions[key] = row
	}
	row.Events++
	if ev.Time.Before(row.FirstTime) {
		row.FirstTime = ev.Time
	}
	if ev.Time.After(row.LastTime) || ev.Time.Equal(row.LastTime) && ev.ID > row.LastEventID {
		row.LastTime = ev.Time
		row.LastEventID = ev.ID
	}
}

// FileSessions returns detached values, newest observation first with stable ties.
// The result spans all indexed history and is never nil.
func (ix *Projection) FileSessions() []FileSession {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]FileSession, 0, len(ix.fileSessions))
	for _, row := range ix.fileSessions {
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if !a.LastTime.Equal(b.LastTime) {
			return a.LastTime.After(b.LastTime)
		}
		aa, bb := [5]string{a.WorkspaceKind, a.Workspace, a.Path, a.Source, a.SessionID}, [5]string{b.WorkspaceKind, b.Workspace, b.Path, b.Source, b.SessionID}
		for k := range aa {
			if aa[k] != bb[k] {
				return aa[k] < bb[k]
			}
		}
		return false
	})
	return out
}
