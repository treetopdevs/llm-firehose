package projection

import (
	"container/heap"
	"sort"
	"strings"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/shellverbs"
)

// Caps on the per-worktree lists a WorktreeLifetime carries. Every cap keeps a
// deterministic subset (latest or lexically smallest), so the result does not
// depend on the order events were applied.
const (
	maxWorktreeMarks    = 200
	maxWorktreePaths    = 500
	maxWorktreeSessions = 200
	// maxWorktreePathGuard bounds the memory of the path set. Past it the set
	// keeps the lexically smallest paths seen (so the smallest 500 stay exact and
	// the fold stays order independent), PathsTotal saturates at the guard and
	// PathsSaturated says so.
	maxWorktreePathGuard = 20000
)

// WorktreeSession is one (source, session) pair seen on a worktree, counted
// over signal events only.
type WorktreeSession struct {
	Source    string    `json:"source"`
	SessionID string    `json:"session_id"`
	FirstTime time.Time `json:"first_time"`
	LastTime  time.Time `json:"last_time"`
	Events    int       `json:"events"`
}

// WorktreeMark is a lifecycle command (git worktree add|remove, commit, push,
// gh pr create|merge) from a claude-code Bash PostToolUse record: parsed from
// the raw hook payload in full mode, otherwise from the adapter's summary
// suffix. Summary marks are display-only command observations.
type WorktreeMark struct {
	Kind      string    `json:"kind"`
	SessionID string    `json:"session_id,omitempty"`
	Time      time.Time `json:"time"`
	EventID   string    `json:"event_id"`
}

// WorktreeLifetime summarizes what the spool recorded for one worktree. It is
// built from the spool alone: nothing here asks git or the workspace graph.
// Meta events are tallied in MetaEvents and never move times, sessions or paths.
type WorktreeLifetime struct {
	RepoID        string            `json:"repo_id"`
	WorktreeID    string            `json:"worktree_id"`
	FirstTime     time.Time         `json:"first_time"`
	LastTime      time.Time         `json:"last_time"`
	Sessions      []WorktreeSession `json:"sessions"`
	SessionsTotal int               `json:"sessions_total"`
	Paths         []string          `json:"paths"`
	PathsTotal    int               `json:"paths_total"`
	SignalEvents  int               `json:"signal_events"`
	MetaEvents    int               `json:"meta_events"`
	Marks         []WorktreeMark    `json:"marks"`
	MarksTotal    int               `json:"marks_total"`
	// PathsSaturated reports more distinct paths than the guard: PathsTotal is
	// then a lower bound.
	PathsSaturated bool `json:"paths_saturated,omitempty"`
	// LastCommitMark, LastMergeMark are the latest times of a commit mark and of
	// a verified self-merge (see lifecycle). They are classification evidence
	// kept independent of the capped Marks list; zero when there is none.
	LastCommitMark time.Time `json:"-"`
	LastMergeMark  time.Time `json:"-"`
}

type worktreeKey struct{ repo, worktree string }

type worktreeSessionKey struct{ source, session string }

type worktreeEntry struct {
	first, last time.Time
	signal      int
	meta        int
	sessions    map[worktreeSessionKey]*WorktreeSession
	paths       map[string]struct{}
	pathHeap    pathMaxHeap // the same paths, largest on top, once the guard is reached
	saturated   bool
	lastCommit  time.Time
	lastMerge   time.Time
	marks       []WorktreeMark // ascending, at most maxWorktreeMarks
	marksTotal  int
}

func markLess(a, b WorktreeMark) bool {
	if !a.Time.Equal(b.Time) {
		return a.Time.Before(b.Time)
	}
	if a.EventID != b.EventID {
		return a.EventID < b.EventID
	}
	return a.Kind < b.Kind
}

// Called only after normal duplicate admission, while the projection is locked.
func (ix *Projection) foldWorktree(ev event.Event) {
	if ev.WorktreeID == "" {
		return
	}
	key := worktreeKey{ev.RepoID, ev.WorktreeID}
	w := ix.worktrees[key]
	if w == nil {
		w = &worktreeEntry{sessions: map[worktreeSessionKey]*WorktreeSession{}, paths: map[string]struct{}{}}
		ix.worktrees[key] = w
	}
	if ev.Category == event.CategoryMeta {
		w.meta++
		return
	}
	if !signalCategory(ev.Category) {
		return
	}
	w.signal++
	if w.signal == 1 || ev.Time.Before(w.first) {
		w.first = ev.Time
	}
	if w.signal == 1 || ev.Time.After(w.last) {
		w.last = ev.Time
	}
	if ev.SessionID != "" {
		sk := worktreeSessionKey{ev.Source, ev.SessionID}
		s := w.sessions[sk]
		if s == nil {
			s = &WorktreeSession{Source: ev.Source, SessionID: ev.SessionID, FirstTime: ev.Time, LastTime: ev.Time}
			w.sessions[sk] = s
		}
		s.Events++
		if ev.Time.Before(s.FirstTime) {
			s.FirstTime = ev.Time
		}
		if ev.Time.After(s.LastTime) {
			s.LastTime = ev.Time
		}
	}
	for _, p := range EventActivityPaths(ev) {
		w.addPath(p)
	}
	if ev.Source == "claude-code" && ev.Category == event.CategoryShell && strings.HasPrefix(ev.Name, "PostToolUse:") {
		if ev.Raw != "" {
			// Full mode: the raw hook payload is authoritative. Only here do
			// commit and verified self-merge evidence feed the classifier.
			kinds, selfMerge := shellverbs.Lifecycle(ev.Raw)
			for _, kind := range kinds {
				w.addMark(WorktreeMark{Kind: kind, SessionID: ev.SessionID, Time: ev.Time, EventID: ev.ID})
				if kind == shellverbs.KindCommit && ev.Time.After(w.lastCommit) {
					w.lastCommit = ev.Time
				}
			}
			if selfMerge && ev.Time.After(w.lastMerge) {
				w.lastMerge = ev.Time
			}
		} else {
			// Balanced/minimal: the adapter's summary suffix. These are
			// display-only command observations by the issuing session, not
			// proof of a commit in this worktree, so they never touch
			// lastCommit, lastMerge or the classifier.
			for _, kind := range shellverbs.KindsFromSummary(ev.Summary) {
				w.addMark(WorktreeMark{Kind: kind, SessionID: ev.SessionID, Time: ev.Time, EventID: ev.ID})
			}
		}
	}
}

// signalCategory is D95's allowlist of categories that count as worktree
// activity. meta is tallied apart; message and anything else is neither.
func signalCategory(c event.Category) bool {
	switch c {
	case event.CategoryFile, event.CategoryTool, event.CategoryShell, event.CategoryPrompt,
		event.CategorySession, event.CategoryError, event.CategoryPermission:
		return true
	}
	return false
}

type pathMaxHeap []string

func (h pathMaxHeap) Len() int           { return len(h) }
func (h pathMaxHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h pathMaxHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *pathMaxHeap) Push(x any)        { *h = append(*h, x.(string)) }
func (h *pathMaxHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

// addPath keeps the lexically smallest maxWorktreePathGuard distinct paths.
func (w *worktreeEntry) addPath(p string) {
	if _, ok := w.paths[p]; ok {
		return
	}
	if len(w.paths) < maxWorktreePathGuard {
		w.paths[p] = struct{}{}
		if len(w.paths) == maxWorktreePathGuard {
			w.pathHeap = make(pathMaxHeap, 0, len(w.paths))
			for k := range w.paths {
				w.pathHeap = append(w.pathHeap, k)
			}
			heap.Init(&w.pathHeap)
		}
		return
	}
	w.saturated = true // more distinct paths than the guard
	if p >= w.pathHeap[0] {
		return
	}
	delete(w.paths, w.pathHeap[0])
	w.pathHeap[0] = p
	heap.Fix(&w.pathHeap, 0)
	w.paths[p] = struct{}{}
}

func (w *worktreeEntry) addMark(m WorktreeMark) {
	w.marksTotal++
	i := sort.Search(len(w.marks), func(i int) bool { return markLess(m, w.marks[i]) })
	if len(w.marks) >= maxWorktreeMarks {
		if i == 0 {
			return // older than every kept mark
		}
		copy(w.marks[:i-1], w.marks[1:i])
		w.marks[i-1] = m
		return
	}
	w.marks = append(w.marks, WorktreeMark{})
	copy(w.marks[i+1:], w.marks[i:])
	w.marks[i] = m
}

func (k worktreeKey) lifetime(w *worktreeEntry) WorktreeLifetime {
	out := WorktreeLifetime{
		RepoID: k.repo, WorktreeID: k.worktree,
		FirstTime: w.first, LastTime: w.last,
		SessionsTotal: len(w.sessions), PathsTotal: len(w.paths),
		SignalEvents: w.signal, MetaEvents: w.meta,
		MarksTotal: w.marksTotal, PathsSaturated: w.saturated,
		LastCommitMark: w.lastCommit, LastMergeMark: w.lastMerge,
		Sessions: make([]WorktreeSession, 0, len(w.sessions)),
		Paths:    make([]string, 0, len(w.paths)),
		Marks:    append([]WorktreeMark{}, w.marks...),
	}
	for _, s := range w.sessions {
		out.Sessions = append(out.Sessions, *s)
	}
	sort.Slice(out.Sessions, func(i, j int) bool { // latest first, to cap
		a, b := out.Sessions[i], out.Sessions[j]
		if !a.LastTime.Equal(b.LastTime) {
			return a.LastTime.After(b.LastTime)
		}
		return sessionLess(a, b)
	})
	if len(out.Sessions) > maxWorktreeSessions {
		out.Sessions = out.Sessions[:maxWorktreeSessions]
	}
	sort.Slice(out.Sessions, func(i, j int) bool {
		a, b := out.Sessions[i], out.Sessions[j]
		if !a.FirstTime.Equal(b.FirstTime) {
			return a.FirstTime.Before(b.FirstTime)
		}
		if !a.LastTime.Equal(b.LastTime) {
			return a.LastTime.Before(b.LastTime)
		}
		return sessionLess(a, b)
	})
	for p := range w.paths {
		out.Paths = append(out.Paths, p)
	}
	sort.Strings(out.Paths)
	if len(out.Paths) > maxWorktreePaths {
		out.Paths = out.Paths[:maxWorktreePaths]
	}
	return out
}

func sessionLess(a, b WorktreeSession) bool {
	if a.Source != b.Source {
		return a.Source < b.Source
	}
	return a.SessionID < b.SessionID
}

// Worktrees returns detached lifetimes for every worktree with at least one
// signal event, newest first (last_time desc, then repo, then worktree id). It
// is never nil.
func (ix *Projection) Worktrees() []WorktreeLifetime {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]WorktreeLifetime, 0, len(ix.worktrees))
	for k, w := range ix.worktrees {
		if w.signal > 0 {
			out = append(out, k.lifetime(w))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if !a.LastTime.Equal(b.LastTime) {
			return a.LastTime.After(b.LastTime)
		}
		if a.RepoID != b.RepoID {
			return a.RepoID < b.RepoID
		}
		return a.WorktreeID < b.WorktreeID
	})
	return out
}

// Worktree returns the lifetime recorded under a worktree id. When several
// repos share the id it picks the latest last_time, then the smallest repo id.
func (ix *Projection) Worktree(id string) (WorktreeLifetime, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	var best WorktreeLifetime
	found := false
	for k, w := range ix.worktrees {
		if k.worktree != id || w.signal == 0 {
			continue
		}
		cand := k.lifetime(w)
		if !found || cand.LastTime.After(best.LastTime) || cand.LastTime.Equal(best.LastTime) && cand.RepoID < best.RepoID {
			best, found = cand, true
		}
	}
	return best, found
}
