package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/workspacegraph"
)

// maxWorktreeRecords bounds worktree-states.json. When exceeded, records of
// worktrees that are no longer present and were seen longest ago go first.
const maxWorktreeRecords = 2000

// maxWorktreeCompareCache bounds the in-memory ahead/behind cache.
const maxWorktreeCompareCache = 2048

var commitIDPattern = regexp.MustCompile(`^[a-f0-9]{40,64}$`)

// worktreeRecord is what the daemon itself last observed about one linked or
// primary worktree. It lives only in the host-private worktree-states.json (0600,
// every privacy mode) and is never part of the spool, a stream, an export or an
// API response; handlers only see the classification derived from it. Paths are
// raw, like graph-roots.json.
type worktreeRecord struct {
	Repo      string `json:"repo"`     // raw git common dir
	Worktree  string `json:"worktree"` // raw canonical worktree root
	Head      string `json:"head,omitempty"`
	Target    string `json:"target,omitempty"` // default branch tip at observation
	TargetRef string `json:"target_ref,omitempty"`
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	Dirty     bool   `json:"dirty"`
	// Compared reports Ahead and Behind come from a successful compare in the
	// last observation; otherwise they are unknown and never exposed.
	Compared bool `json:"compared"`
	// Unavailable: git lists the checkout but its state could not be read
	// (permissions, corrupt index, output limit). It is not gone.
	Unavailable bool `json:"unavailable,omitempty"`
	// LifetimeStart bounds the spool marks that belong to this lifetime: zero for
	// a worktree first seen here (all history counts), else the instant the
	// previous lifetime was confirmed gone, before which marks are the old one's.
	LifetimeStart time.Time `json:"lifetime_start,omitzero"`
	// GoneAt is when the worktree was first observed not listed.
	GoneAt time.Time `json:"gone_at,omitzero"`
	// EverAhead is sticky: the daemon saw this worktree ahead of the default
	// branch at least once. It is the only way to tell "merged" from "never moved".
	EverAhead bool `json:"ever_ahead"`
	Present   bool `json:"present"`
	Primary   bool `json:"primary"`
	// Reason is why a present worktree could not be compared:
	// no_default_target, unborn_head or compare_failed.
	Reason string `json:"reason,omitempty"`
	// GoneOutcome and GoneReason are computed once, when the worktree stops
	// being listed, so handlers never need git.
	GoneOutcome string    `json:"gone_outcome,omitempty"`
	GoneReason  string    `json:"gone_reason,omitempty"`
	FirstSeen   time.Time `json:"first_seen"`
	LastSeen    time.Time `json:"last_seen"`
}

type worktreeStatesFile struct {
	Version   int              `json:"version"`
	Worktrees []worktreeRecord `json:"worktrees"`
}

func recordKey(repo, worktree string) string { return repo + "\x00" + worktree }

func digestString(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

type worktreeCompare struct{ ahead, behind int }

// worktreeStates is the daemon's observed-worktree memory. observeMu serializes
// observation (the sole writer); mu guards only the published observation.
type worktreeStates struct {
	observeMu    sync.Mutex
	records      map[string]worktreeRecord
	compare      map[string]worktreeCompare
	compareCalls int
	// detailCompares counts the single bounded Compare a detail request runs
	// for an open worktree; it never touches the observer's cache or records.
	detailCompares atomic.Int64
	persisted      string // material form of what the file holds

	mu     sync.RWMutex
	latest *worktreeObservation
}

func (w *worktreeStates) observation() *worktreeObservation {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.latest
}

// worktreeObservation is an immutable view published after each observation.
type worktreeObservation struct {
	repos map[string]*observedRepo // by raw repo identity and its digest
}

type observedRepo struct {
	raw       string // raw git common dir (the graph's repository identity)
	reason    string // "", graph_unavailable or graph_stale
	worktrees map[string]*worktreeRecord
}

func (o *worktreeObservation) lookup(repoID, worktreeID string) (*observedRepo, *worktreeRecord) {
	if o == nil {
		return nil, nil
	}
	repo := o.repos[repoID]
	if repo == nil {
		return nil, nil
	}
	return repo, repo.worktrees[worktreeID]
}

// worktreeClass is the handler-facing classification of one lifetime.
type worktreeClass struct {
	State        string
	Outcome      string
	Reason       string
	TargetRef    string
	Head         string
	Ahead        *int
	Behind       *int
	Dirty        *bool
	LastObserved time.Time
}

// classifyWorktree is pure: it joins a spool lifetime to the last observation.
// evidence reports that full-mode capture recorded a commit by this worktree,
// which proves it diverged even if the daemon never saw it ahead. prMerged
// reports a gh pr merge mark: a squash or rebase merge leaves ids that are not
// reachable from the default branch, so a gone worktree that looks abandoned
// but whose PR was merged is reported landed with reason pr_merge_mark.
func classifyWorktree(lt capture.WorktreeLifetime, obs *worktreeObservation, evidence, prMerged bool) worktreeClass {
	if obs == nil {
		return worktreeClass{State: "unknown", Reason: "graph_unavailable"}
	}
	repo, rec := obs.lookup(lt.RepoID, lt.WorktreeID)
	if repo == nil {
		return worktreeClass{State: "unknown", Reason: "repo_unregistered"}
	}
	if repo.reason != "" {
		c := worktreeClass{State: "unknown", Reason: repo.reason}
		if rec != nil {
			c.LastObserved = rec.LastSeen
		}
		return c
	}
	if rec == nil {
		return worktreeClass{State: "gone", Outcome: "unknown", Reason: "never_observed"}
	}
	c := worktreeClass{TargetRef: rec.TargetRef, Head: rec.Head, LastObserved: rec.LastSeen}
	ever := rec.EverAhead || evidence
	if !rec.Present {
		c.State, c.Outcome, c.Reason = "gone", rec.GoneOutcome, rec.GoneReason
		if c.Outcome == "" {
			c.Outcome = "unknown"
		}
		if c.Outcome == "never_diverged" && evidence {
			c.Outcome = "landed"
		}
		if c.Outcome == "abandoned" && prMerged {
			c.Outcome, c.Reason = "landed", "pr_merge_mark"
		}
		return c
	}
	if rec.Compared {
		ahead, behind := rec.Ahead, rec.Behind
		c.Ahead, c.Behind = &ahead, &behind
	}
	if !rec.Unavailable {
		dirty := rec.Dirty
		c.Dirty = &dirty
	}
	switch {
	case rec.Reason == "unborn_head":
		c.State, c.Reason = "unknown", "unborn_head"
	case rec.Primary:
		c.State, c.Reason = "unknown", "primary_worktree"
	case rec.Unavailable:
		c.State, c.Reason = "unknown", "worktree_unavailable"
	case rec.Reason != "":
		c.State, c.Reason = "unknown", rec.Reason
	case rec.Ahead > 0:
		c.State = "open"
	case ever:
		c.State = "landed"
	default:
		c.State = "never_diverged"
	}
	return c
}

// checkoutMissing reports that the path is confirmed absent. Any other stat
// outcome (success, permission denied, I/O error) is not a disappearance.
func checkoutMissing(path string) bool {
	_, err := os.Lstat(path)
	return errors.Is(err, fs.ErrNotExist)
}

// lifetimeEvidence keeps a latest-mark time only when it belongs to the
// worktree's current lifetime.
func lifetimeEvidence(at time.Time, rec *worktreeRecord) bool {
	if at.IsZero() {
		return false
	}
	return rec == nil || !at.Before(rec.LifetimeStart)
}

// loadWorktreeStates reads worktree-states.json before the server is exposed.
// The file is read in every privacy mode and never deleted. A corrupt or
// unknown-version file loads nothing; invalid entries are skipped.
func (s *Server) loadWorktreeStates() {
	s.worktrees.records = map[string]worktreeRecord{}
	data, err := os.ReadFile(filepath.Join(s.home, ".agentfirehose", "worktree-states.json"))
	if err != nil {
		return
	}
	var file worktreeStatesFile
	if json.Unmarshal(data, &file) != nil || file.Version != 1 {
		return
	}
	for _, r := range file.Worktrees {
		if !validWorktreeRecord(r) {
			continue
		}
		s.worktrees.records[recordKey(r.Repo, r.Worktree)] = r
	}
	s.worktrees.persisted = materialWorktreeStates(s.worktrees.records)
}

func validWorktreeRecord(r worktreeRecord) bool {
	if !filepath.IsAbs(r.Repo) || !filepath.IsAbs(r.Worktree) || r.Ahead < 0 || r.Behind < 0 {
		return false
	}
	if r.Head != "" && !commitIDPattern.MatchString(r.Head) {
		return false
	}
	if r.Target != "" && !commitIDPattern.MatchString(r.Target) {
		return false
	}
	switch r.GoneOutcome {
	case "", "landed", "abandoned", "never_diverged", "unknown":
	default:
		return false
	}
	return true
}

// capWorktreeRecords drops the not-present, longest-unseen records until at
// most maxWorktreeRecords remain (then present ones, if still over).
func capWorktreeRecords(records map[string]worktreeRecord) {
	if len(records) <= maxWorktreeRecords {
		return
	}
	keys := make([]string, 0, len(records))
	for k := range records {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := records[keys[i]], records[keys[j]]
		if a.Present != b.Present {
			return !a.Present
		}
		if !a.LastSeen.Equal(b.LastSeen) {
			return a.LastSeen.Before(b.LastSeen)
		}
		return keys[i] < keys[j]
	})
	for _, k := range keys[:len(records)-maxWorktreeRecords] {
		delete(records, k)
	}
}

func sortedWorktreeRecords(records map[string]worktreeRecord, keepSeen bool) []worktreeRecord {
	out := make([]worktreeRecord, 0, len(records))
	for _, r := range records {
		if !keepSeen {
			r.LastSeen = time.Time{}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Repo != out[j].Repo {
			return out[i].Repo < out[j].Repo
		}
		return out[i].Worktree < out[j].Worktree
	})
	return out
}

// materialWorktreeStates serializes the records without last_seen, so a pure
// re-observation does not rewrite the file.
func materialWorktreeStates(records map[string]worktreeRecord) string {
	data, _ := json.Marshal(sortedWorktreeRecords(records, false))
	return string(data)
}

// persistWorktreeStates writes the (capped) records atomically: MkdirAll 0700,
// CreateTemp (0600), Rename. Only the observer calls it.
func (s *Server) persistWorktreeStates() error {
	capWorktreeRecords(s.worktrees.records)
	data, err := json.Marshal(worktreeStatesFile{Version: 1, Worktrees: sortedWorktreeRecords(s.worktrees.records, true)})
	if err != nil {
		return err
	}
	dir := filepath.Join(s.home, ".agentfirehose")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "worktree-states-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Close()
	} else {
		f.Close()
	}
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), filepath.Join(dir, "worktree-states.json")); err != nil {
		return err
	}
	s.worktrees.persisted = materialWorktreeStates(s.worktrees.records)
	return nil
}

// observeWorktrees is the ONLY writer of worktree state. For every registered
// git repository it reads the cached graph snapshot (the reconcile loop has just
// refreshed it), compares each worktree's head with the default branch, updates
// the host-private records and publishes an immutable observation. No lock is
// held across a git call except the observer's own serialization.
func (s *Server) observeWorktrees(ctx context.Context) {
	w := &s.worktrees
	w.observeMu.Lock()
	defer w.observeMu.Unlock()
	if w.records == nil {
		w.records = map[string]worktreeRecord{}
	}
	if w.compare == nil {
		w.compare = map[string]worktreeCompare{}
	}
	now := time.Now().UTC()
	reasons := map[string]string{} // raw repo -> reason
	for _, repo := range s.graph.service.Repositories() {
		if ctx.Err() != nil {
			return
		}
		if repo.VCS != "git" {
			continue
		}
		aliases, _, err := s.graph.service.EventScope(repo.ID, "")
		if err != nil || len(aliases) == 0 {
			continue
		}
		raw := aliases[0]
		snap, err := s.graph.service.Snapshot(ctx, repo.ID, "", false)
		switch {
		case err != nil:
			reasons[raw] = "graph_unavailable"
		case snap.Stale:
			reasons[raw] = "graph_stale"
		default:
			reasons[raw] = ""
			s.applyWorktreeSnapshot(ctx, repo.ID, raw, snap.DefaultTarget, snap.DefaultTargetRef, snap.Workspaces, now)
		}
	}
	if ctx.Err() != nil {
		return
	}
	capWorktreeRecords(w.records)
	if materialWorktreeStates(w.records) != w.persisted {
		_ = s.persistWorktreeStates()
	}
	obs := &worktreeObservation{repos: map[string]*observedRepo{}}
	for raw, reason := range reasons {
		or := &observedRepo{raw: raw, reason: reason, worktrees: map[string]*worktreeRecord{}}
		obs.repos[raw], obs.repos[digestString(raw)] = or, or
	}
	for _, r := range w.records {
		or := obs.repos[r.Repo]
		if or == nil {
			continue
		}
		rec := r
		or.worktrees[r.Worktree], or.worktrees[digestString(r.Worktree)] = &rec, &rec
	}
	w.mu.Lock()
	w.latest = obs
	w.mu.Unlock()
}

// cachedWorktreeCompare returns ahead/behind of head against target, running
// the graph Compare at most once per (repo, head, target). fresh bypasses the
// cache: a vanished worktree's head may since have been garbage collected, which
// a cached answer would hide.
func (s *Server) cachedWorktreeCompare(ctx context.Context, repoID, head, target string, fresh bool) (worktreeCompare, bool) {
	w := &s.worktrees
	key := repoID + "|" + head + "|" + target
	if c, ok := w.compare[key]; ok && !fresh {
		return c, true
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	w.compareCalls++
	cmp, err := s.graph.service.Compare(cctx, repoID, head, target)
	if err != nil {
		return worktreeCompare{}, false
	}
	if len(w.compare) >= maxWorktreeCompareCache {
		w.compare = map[string]worktreeCompare{}
	}
	c := worktreeCompare{ahead: len(cmp.SelectedOnly), behind: len(cmp.TargetOnly)}
	w.compare[key] = c
	return c, true
}

func (s *Server) applyWorktreeSnapshot(ctx context.Context, repoID, raw, target, targetRef string, workspaces []workspacegraph.Workspace, now time.Time) {
	w := &s.worktrees
	present := map[string]bool{}
	for i, ws := range workspaces {
		if ws.Availability == "pruned" || ws.Availability == "inaccessible" && checkoutMissing(ws.Label) {
			continue // confirmed missing from disk: counted absent
		}
		// Any other inaccessible checkout is still listed and on disk: it stays
		// present, with its state marked unavailable, and is never settled as gone.
		key := recordKey(raw, ws.Label)
		present[key] = true
		rec, existed := w.records[key]
		rec.Repo, rec.Worktree = raw, ws.Label
		if !existed || !rec.Present {
			// New, or reappeared after a confirmed disappearance, whatever its
			// head: a fresh lifetime must not inherit the old one's divergence
			// or its marks.
			rec.EverAhead = false
			rec.FirstSeen = now
			rec.LifetimeStart = time.Time{}
			if existed {
				rec.LifetimeStart = rec.GoneAt
				if rec.LifetimeStart.IsZero() {
					rec.LifetimeStart = rec.LastSeen
				}
			}
			rec.GoneAt = time.Time{}
		}
		rec.LastSeen = now
		rec.Present, rec.GoneOutcome, rec.GoneReason = true, "", ""
		rec.Unavailable, rec.Compared = ws.Availability == "inaccessible", false
		rec.Primary = i == 0
		rec.Dirty = ws.Dirty
		rec.Head, rec.Target, rec.TargetRef = ws.Revision, target, targetRef
		rec.Reason = ""
		switch {
		case ws.Unborn || ws.Revision == "":
			rec.Head, rec.Ahead, rec.Behind, rec.Reason = "", 0, 0, "unborn_head"
		case rec.Primary:
			rec.Ahead, rec.Behind = 0, 0
		case target == "":
			rec.Ahead, rec.Behind, rec.Reason = 0, 0, "no_default_target"
		default:
			c, ok := s.cachedWorktreeCompare(ctx, repoID, ws.Revision, target, false)
			if !ok {
				rec.Ahead, rec.Behind, rec.Reason = 0, 0, "compare_failed"
			} else {
				rec.Ahead, rec.Behind, rec.Compared = c.ahead, c.behind, true
				rec.EverAhead = rec.EverAhead || c.ahead > 0
			}
		}
		w.records[key] = rec
	}
	for key, rec := range w.records {
		if rec.Repo != raw || present[key] {
			continue
		}
		if rec.Present || (rec.GoneOutcome == "" && !rec.Primary) {
			if rec.Present || rec.GoneAt.IsZero() {
				rec.GoneAt = now
			}
			rec.Present, rec.Compared = false, false
			rec.GoneOutcome, rec.GoneReason = s.goneOutcome(ctx, repoID, rec, target)
			w.records[key] = rec
		}
	}
}

// goneOutcome settles a vanished worktree from its last observed head, once.
func (s *Server) goneOutcome(ctx context.Context, repoID string, rec worktreeRecord, target string) (string, string) {
	switch {
	case rec.Primary:
		return "", ""
	case rec.Head == "":
		return "unknown", "unborn_head"
	case target == "":
		return "unknown", "no_default_target"
	}
	c, ok := s.cachedWorktreeCompare(ctx, repoID, rec.Head, target, true)
	switch {
	case !ok:
		return "unknown", "compare_failed"
	case c.ahead > 0:
		return "abandoned", ""
	case rec.EverAhead:
		return "landed", ""
	}
	return "never_diverged", ""
}
