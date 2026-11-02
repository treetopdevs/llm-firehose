package daemon

import (
	"context"
	"net/http"
	"path/filepath"
	"sort"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/privacy"
)

// commitAttributionGrace extends a session's window after its last event, so a
// commit made right after the agent stopped still joins that session.
const commitAttributionGrace = 10 * time.Minute

const (
	maxWorktreeViewSessions = 200
	maxWorktreeViewPaths    = 500
	maxWorktreeViewMarks    = 200
	maxWorktreeCommits      = 200
	worktreeDetailBound     = 5 * time.Second
)

type worktreeSessionView struct {
	Source    string    `json:"source"`
	SessionID string    `json:"session_id"`
	FirstTime time.Time `json:"first_time"`
	LastTime  time.Time `json:"last_time"`
	Events    int       `json:"events"`
}

type worktreeMarkView struct {
	Kind      string    `json:"kind"`
	SessionID string    `json:"session_id,omitempty"`
	Time      time.Time `json:"time"`
	EventID   string    `json:"event_id"`
}

// worktreeView is one GET /worktrees item.
type worktreeView struct {
	RepoID          string                `json:"repo_id"`
	WorktreeID      string                `json:"worktree_id"`
	Label           string                `json:"label,omitempty"`
	FirstTime       time.Time             `json:"first_time"`
	LastTime        time.Time             `json:"last_time"`
	Sessions        []worktreeSessionView `json:"sessions"`
	SessionsTotal   int                   `json:"sessions_total"`
	Paths           []string              `json:"paths"`
	PathsTotal      int                   `json:"paths_total"`
	PathsSaturated  bool                  `json:"paths_saturated,omitempty"`
	SignalEvents    int                   `json:"signal_events"`
	MetaEvents      int                   `json:"meta_events"`
	Marks           []worktreeMarkView    `json:"marks"`
	MarksTotal      int                   `json:"marks_total"`
	MarksAvailable  bool                  `json:"marks_available"`
	State           string                `json:"state"`
	Outcome         string                `json:"outcome,omitempty"`
	StateReason     string                `json:"state_reason,omitempty"`
	DefaultTargetRf string                `json:"default_target_ref,omitempty"`
	Head            string                `json:"head,omitempty"`
	Ahead           *int                  `json:"ahead,omitempty"`
	Behind          *int                  `json:"behind,omitempty"`
	Dirty           *bool                 `json:"dirty,omitempty"`
	LastObserved    *time.Time            `json:"last_observed,omitempty"`
}

type worktreeCommit struct {
	CommitID    string     `json:"commit_id"`
	Time        *time.Time `json:"time,omitempty"`
	Subject     string     `json:"subject,omitempty"`
	SessionID   string     `json:"session_id,omitempty"`
	Attribution string     `json:"attribution"`
}

// worktreeDetail is one GET /worktrees/{id} body.
type worktreeDetail struct {
	worktreeView
	Commits []worktreeCommit `json:"commits"`
}

// worktreeRow is a merged lifetime with what the detail route needs.
type worktreeRow struct {
	view     worktreeView
	sessions []capture.WorktreeSession
	aliases  map[string]bool
	rawRepo  string
	rec      *worktreeRecord
}

func (s *Server) currentPrivacyMode() privacy.Mode {
	mode, err := privacy.ParseMode(s.config().PrivacyMode)
	if err != nil {
		return privacy.ModeBalanced
	}
	return mode
}

// attributeCommit joins a commit time to the session whose window covers it:
// [first_time, last_time+grace], boundaries inclusive. Among covering sessions
// the one that started latest wins (ties: source, then session id). It is a
// time join, not causality; "" means no window covers the commit.
func attributeCommit(sessions []capture.WorktreeSession, at time.Time) string {
	var best *capture.WorktreeSession
	for i := range sessions {
		c := &sessions[i]
		if at.Before(c.FirstTime) || at.After(c.LastTime.Add(commitAttributionGrace)) {
			continue
		}
		switch {
		case best == nil, c.FirstTime.After(best.FirstTime):
			best = c
		case c.FirstTime.Equal(best.FirstTime) && (c.Source < best.Source || c.Source == best.Source && c.SessionID < best.SessionID):
			best = c
		}
	}
	if best == nil {
		return ""
	}
	return best.SessionID
}

// resolveWorktree joins a spool lifetime to the last observation and returns
// the merge key plus the raw identities when the repository is known.
func resolveWorktree(lt capture.WorktreeLifetime, obs *worktreeObservation) (key, rawRepo, rawWt string, rec *worktreeRecord) {
	repo, rec := obs.lookup(lt.RepoID, lt.WorktreeID)
	if repo == nil {
		return "u\x00" + lt.RepoID + "\x00" + lt.WorktreeID, "", "", nil
	}
	rawWt = ""
	switch {
	case rec != nil:
		rawWt = rec.Worktree
	case filepath.IsAbs(lt.WorktreeID):
		rawWt = lt.WorktreeID
	}
	wtKey := lt.WorktreeID
	if rawWt != "" {
		wtKey = digestString(rawWt)
	}
	return "r\x00" + digestString(repo.raw) + "\x00" + wtKey, repo.raw, rawWt, rec
}

func sessionKeyLess(a, b capture.WorktreeSession) bool {
	if a.Source != b.Source {
		return a.Source < b.Source
	}
	return a.SessionID < b.SessionID
}

// mergeLifetimes folds lifetimes of one workspace recorded under different
// privacy modes. Retained lists are unioned and re-capped; totals add up minus
// the overlap visible in the retained lists. When a contributing list was
// capped, an identity present in several modes can be counted once per mode, so
// merged totals are then upper bounds (never below the distinct retained count).
func mergeLifetimes(group []capture.WorktreeLifetime) capture.WorktreeLifetime {
	out := group[0]
	if len(group) > 1 {
		out.Sessions, out.Paths, out.Marks = nil, nil, nil
		out.SessionsTotal, out.PathsTotal, out.MarksTotal, out.SignalEvents, out.MetaEvents = 0, 0, 0, 0, 0
		out.PathsSaturated = false
	}
	sessions := map[[2]string]capture.WorktreeSession{}
	paths := map[string]bool{}
	type markKey struct{ id, kind string }
	marks := map[markKey]capture.WorktreeMark{}
	retainedSessions, retainedPaths, retainedMarks := 0, 0, 0
	for i, lt := range group {
		if i == 0 || lt.FirstTime.Before(out.FirstTime) {
			out.FirstTime = lt.FirstTime
		}
		if i == 0 || lt.LastTime.After(out.LastTime) {
			out.LastTime = lt.LastTime
		}
		if len(group) == 1 {
			break
		}
		out.PathsSaturated = out.PathsSaturated || lt.PathsSaturated
		if lt.LastCommitMark.After(out.LastCommitMark) || i == 0 {
			out.LastCommitMark = lt.LastCommitMark
		}
		if lt.LastMergeMark.After(out.LastMergeMark) || i == 0 {
			out.LastMergeMark = lt.LastMergeMark
		}
		out.SessionsTotal += lt.SessionsTotal
		out.PathsTotal += lt.PathsTotal
		out.MarksTotal += lt.MarksTotal
		out.SignalEvents += lt.SignalEvents
		out.MetaEvents += lt.MetaEvents
		for _, se := range lt.Sessions {
			retainedSessions++
			k := [2]string{se.Source, se.SessionID}
			if cur, ok := sessions[k]; ok {
				cur.Events += se.Events
				if se.FirstTime.Before(cur.FirstTime) {
					cur.FirstTime = se.FirstTime
				}
				if se.LastTime.After(cur.LastTime) {
					cur.LastTime = se.LastTime
				}
				se = cur
			}
			sessions[k] = se
		}
		for _, p := range lt.Paths {
			retainedPaths++
			paths[p] = true
		}
		for _, m := range lt.Marks {
			retainedMarks++
			marks[markKey{m.EventID, m.Kind}] = m
		}
	}
	if len(group) == 1 {
		return out
	}
	out.SessionsTotal -= retainedSessions - len(sessions)
	out.PathsTotal -= retainedPaths - len(paths)
	out.MarksTotal -= retainedMarks - len(marks)
	for _, se := range sessions {
		out.Sessions = append(out.Sessions, se)
	}
	for p := range paths {
		out.Paths = append(out.Paths, p)
	}
	for _, m := range marks {
		out.Marks = append(out.Marks, m)
	}
	sort.Strings(out.Paths)
	sort.Slice(out.Marks, func(i, j int) bool {
		a, b := out.Marks[i], out.Marks[j]
		if !a.Time.Equal(b.Time) {
			return a.Time.Before(b.Time)
		}
		if a.EventID != b.EventID {
			return a.EventID < b.EventID
		}
		return a.Kind < b.Kind
	})
	return out
}

// capSessions keeps the latest sessions by last_time, then orders them by
// first_time ascending, like the projection does.
func capSessions(in []capture.WorktreeSession) []capture.WorktreeSession {
	out := append([]capture.WorktreeSession{}, in...)
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastTime.Equal(out[j].LastTime) {
			return out[i].LastTime.After(out[j].LastTime)
		}
		return sessionKeyLess(out[i], out[j])
	})
	if len(out) > maxWorktreeViewSessions {
		out = out[:maxWorktreeViewSessions]
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].FirstTime.Equal(out[j].FirstTime) {
			return out[i].FirstTime.Before(out[j].FirstTime)
		}
		if !out[i].LastTime.Equal(out[j].LastTime) {
			return out[i].LastTime.Before(out[j].LastTime)
		}
		return sessionKeyLess(out[i], out[j])
	})
	return out
}

// worktreeRows builds the merged, classified rows from the engine projection
// and the last observation. It runs no git and writes nothing.
func (s *Server) worktreeRows() []worktreeRow {
	obs := s.worktrees.observation()
	if obs == nil && len(s.graph.service.Repositories()) == 0 {
		obs = &worktreeObservation{repos: map[string]*observedRepo{}}
	}
	mode := s.currentPrivacyMode()
	full := mode == privacy.ModeFull

	type group struct {
		lts     []capture.WorktreeLifetime
		rawRepo string
		rawWt   string
		rec     *worktreeRecord
	}
	groups := map[string]*group{}
	var order []string
	for _, lt := range s.engine.Worktrees() {
		key, rawRepo, rawWt, rec := resolveWorktree(lt, obs)
		g := groups[key]
		if g == nil {
			g = &group{rawRepo: rawRepo}
			groups[key] = g
			order = append(order, key)
		}
		g.lts = append(g.lts, lt)
		if rawWt != "" {
			g.rawWt = rawWt
		}
		if rec != nil {
			g.rec = rec
		}
	}

	rows := make([]worktreeRow, 0, len(order))
	for _, key := range order {
		g := groups[key]
		lt := mergeLifetimes(g.lts)
		// Evidence is lifetime-level and independent of the capped marks list;
		// only marks of the current lifetime count.
		class := classifyWorktree(g.lts[0], obs, lifetimeEvidence(lt.LastCommitMark, g.rec), lifetimeEvidence(lt.LastMergeMark, g.rec))

		repoID, wtID := lt.RepoID, lt.WorktreeID
		aliases := map[string]bool{}
		for _, x := range g.lts {
			aliases[x.WorktreeID] = true
		}
		if g.rawRepo != "" {
			if full {
				repoID = g.rawRepo
			} else {
				repoID = digestString(g.rawRepo)
			}
			if g.rawWt != "" {
				if full {
					wtID = g.rawWt
				} else {
					wtID = digestString(g.rawWt)
				}
				aliases[g.rawWt], aliases[digestString(g.rawWt)] = true, true
			}
		}
		aliases[wtID] = true

		v := worktreeView{
			RepoID: repoID, WorktreeID: wtID,
			FirstTime: lt.FirstTime.UTC(), LastTime: lt.LastTime.UTC(),
			SessionsTotal: lt.SessionsTotal, PathsTotal: lt.PathsTotal, PathsSaturated: lt.PathsSaturated,
			SignalEvents: lt.SignalEvents, MetaEvents: lt.MetaEvents, MarksTotal: lt.MarksTotal,
			MarksAvailable: full || lt.MarksTotal > 0,
			Sessions:       []worktreeSessionView{},
			Paths:          []string{},
			Marks:          []worktreeMarkView{},
			State:          class.State, Outcome: class.Outcome, StateReason: class.Reason,
			DefaultTargetRf: class.TargetRef, Head: class.Head,
			Ahead: class.Ahead, Behind: class.Behind, Dirty: class.Dirty,
		}
		if g.rec != nil {
			v.Label = g.rec.Worktree
		}
		if !class.LastObserved.IsZero() {
			t := class.LastObserved.UTC()
			v.LastObserved = &t
		}
		sessions := capSessions(lt.Sessions)
		for _, se := range sessions {
			v.Sessions = append(v.Sessions, worktreeSessionView{se.Source, se.SessionID, se.FirstTime.UTC(), se.LastTime.UTC(), se.Events})
		}
		paths := lt.Paths
		if len(paths) > maxWorktreeViewPaths {
			paths = paths[:maxWorktreeViewPaths]
		}
		v.Paths = append(v.Paths, paths...)
		marks := lt.Marks
		if len(marks) > maxWorktreeViewMarks {
			marks = marks[len(marks)-maxWorktreeViewMarks:]
		}
		for _, m := range marks {
			v.Marks = append(v.Marks, worktreeMarkView{m.Kind, m.SessionID, m.Time.UTC(), m.EventID})
		}
		rows = append(rows, worktreeRow{view: v, sessions: sessions, aliases: aliases, rawRepo: g.rawRepo, rec: g.rec})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i].view, rows[j].view
		if !a.LastTime.Equal(b.LastTime) {
			return a.LastTime.After(b.LastTime)
		}
		if a.RepoID != b.RepoID {
			return a.RepoID < b.RepoID
		}
		return a.WorktreeID < b.WorktreeID
	})
	return rows
}

func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	rows := s.worktreeRows()
	views := make([]worktreeView, 0, len(rows))
	for _, row := range rows {
		views = append(views, row.view)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, views)
}

func (s *Server) handleWorktreeByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var found *worktreeRow
	rows := s.worktreeRows()
	for i := range rows {
		if rows[i].aliases[id] {
			found = &rows[i]
			break
		}
	}
	if found == nil {
		http.Error(w, "worktree not found", http.StatusNotFound)
		return
	}
	detail := worktreeDetail{worktreeView: found.view, Commits: []worktreeCommit{}}
	if found.view.State == "open" && found.rec != nil && found.rec.Head != "" && found.rec.Target != "" {
		detail.Commits = s.worktreeCommits(r.Context(), *found)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, detail)
}

// worktreeCommits lists the commits an open worktree has beyond the default
// branch with one bounded Compare for this worktree only. Times and subjects
// come from the cached graph snapshot when it holds the commit.
func (s *Server) worktreeCommits(ctx context.Context, row worktreeRow) []worktreeCommit {
	out := []worktreeCommit{}
	ctx, cancel := context.WithTimeout(ctx, worktreeDetailBound)
	defer cancel()
	svcID := row.rawRepo
	if s.currentPrivacyMode() != privacy.ModeFull {
		svcID = digestString(row.rawRepo)
	}
	s.worktrees.detailCompares.Add(1)
	cmp, err := s.graph.service.Compare(ctx, svcID, row.rec.Head, row.rec.Target)
	if err != nil {
		return out
	}
	type info struct {
		at      time.Time
		subject string
	}
	known := map[string]info{}
	if snap, ok := s.graph.service.CachedSnapshot(svcID); ok {
		for _, n := range snap.Nodes {
			known[n.CommitID] = info{n.Timestamp, n.Description}
		}
	}
	for _, id := range cmp.SelectedOnly {
		if len(out) >= maxWorktreeCommits {
			break
		}
		c := worktreeCommit{CommitID: id, Attribution: "time_join"}
		if k, ok := known[id]; ok {
			if !k.at.IsZero() {
				t := k.at.UTC()
				c.Time = &t
				c.SessionID = attributeCommit(row.sessions, t)
			}
			c.Subject = k.subject
		}
		out = append(out, c)
	}
	return out
}
