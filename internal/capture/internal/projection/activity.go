package projection

import (
	"time"

	"agentfirehose/internal/event"
)

// ActivityRecord is the compact projection of one file or error observation
// needed by Engine.Activity. Keeping only file and error records in memory
// lets Activity answer multi-day queries without rescanning or JSON-decoding
// hundreds of megabytes of unrelated spool history.
type ActivityRecord struct {
	Time          time.Time
	RepoID        string
	JJRepoID      string
	WorktreeID    string
	JJWorkspaceID string
	RootAlias     string
	IsFile        bool
	ErrorSig      string
	Paths         []string
}

func (ix *Projection) intern(s string) string {
	if s == "" {
		return ""
	}
	if v, ok := ix.strings[s]; ok {
		return v
	}
	ix.strings[s] = s
	return s
}

// foldActivity indexes one file or error observation under its repository
// identities. Caller holds ix.mu. canonical is the UTC day already recorded in
// ix.seen[ev.ID], or "" when ev.ID is new.
func (ix *Projection) foldActivity(ev event.Event, day, canonical string) {
	signature, isError := ErrorObservationKey(ev)
	isFile := ev.Category == event.CategoryFile
	if !isFile && !isError {
		return
	}
	if ev.ID != "" {
		// A stable ID replayed into a different day file keeps its canonical
		// day only; on the same day, an earlier ineligible event never shadows
		// an eligible activity/error record, while activitySeen prevents double
		// counting.
		if (canonical != "" && canonical != day) || ix.activitySeen[ev.ID] {
			return
		}
		ix.activitySeen[ev.ID] = true
	}
	if ev.RepoID == "" && ev.JJRepoID == "" {
		return
	}
	var paths []string
	if isFile {
		paths = EventActivityPaths(ev)
	} else {
		pathEvent := ev
		pathEvent.Category = event.CategoryFile
		paths = EventActivityPaths(pathEvent)
	}
	// Non-file error records without explicit paths never contribute to Heat
	// or ErrorPaths, so they need not be retained in the slice.
	if !isFile && len(paths) == 0 {
		return
	}

	idx := len(ix.activity)
	ix.activity = append(ix.activity, ActivityRecord{
		Time:          ev.Time,
		RepoID:        ix.intern(ev.RepoID),
		JJRepoID:      ix.intern(ev.JJRepoID),
		WorktreeID:    ix.intern(ev.WorktreeID),
		JJWorkspaceID: ix.intern(ev.JJWorkspaceID),
		RootAlias:     ix.intern(ev.RootAlias),
		IsFile:        isFile,
		ErrorSig:      ix.intern(signature),
		Paths:         paths,
	})
	if ev.RepoID != "" {
		k := ix.intern(ev.RepoID)
		ix.activityByRepo[k] = append(ix.activityByRepo[k], idx)
	}
	if ev.JJRepoID != "" && ev.JJRepoID != ev.RepoID {
		k := ix.intern(ev.JJRepoID)
		ix.activityByRepo[k] = append(ix.activityByRepo[k], idx)
	}
}

// ActivityRecords streams every projected file or error observation matching
// any of repoIDs with timestamp in [from, to) to yield in ingestion order.
// Records carrying multiple matching repo aliases (e.g. colocated Git + JJ)
// are yielded once. Iteration stops immediately when yield returns false.
func (ix *Projection) ActivityRecords(repoIDs []string, from, to time.Time, yield func(ActivityRecord) bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	var lists [][]int
	var seenRepos map[string]bool
	for _, id := range repoIDs {
		if id == "" {
			continue
		}
		if len(repoIDs) > 1 {
			if seenRepos == nil {
				seenRepos = make(map[string]bool, len(repoIDs))
			}
			if seenRepos[id] {
				continue
			}
			seenRepos[id] = true
		}
		if idxs := ix.activityByRepo[id]; len(idxs) > 0 {
			lists = append(lists, idxs)
		}
	}
	if len(lists) == 0 {
		return
	}
	if len(lists) == 1 {
		for _, idx := range lists[0] {
			rec := ix.activity[idx]
			if rec.Time.Before(from) || !rec.Time.Before(to) {
				continue
			}
			if !yield(rec) {
				return
			}
		}
		return
	}

	pos := make([]int, len(lists))
	lastIdx := -1
	for {
		minIdx := -1
		minList := -1
		for i, l := range lists {
			if pos[i] < len(l) {
				v := l[pos[i]]
				if minList < 0 || v < minIdx {
					minIdx = v
					minList = i
				}
			}
		}
		if minList < 0 {
			return
		}
		pos[minList]++
		if minIdx == lastIdx {
			continue
		}
		lastIdx = minIdx
		rec := ix.activity[minIdx]
		if rec.Time.Before(from) || !rec.Time.Before(to) {
			continue
		}
		if !yield(rec) {
			return
		}
	}
}
