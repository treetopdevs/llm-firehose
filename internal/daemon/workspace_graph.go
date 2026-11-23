package daemon

import (
	"agentfirehose/internal/capture"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/workspacegraph"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type graphRoot struct {
	Root string `json:"root"`
	VCS  string `json:"vcs"`
}
type graphHost struct {
	mu             sync.Mutex
	registrationMu sync.Mutex
	roots          []graphRoot
	unavailable    map[string]string
	service        *workspacegraph.Service
}

// rememberGraphRoot records a registered or observed root in memory and in the
// host-private graph-roots.json (0600), in every privacy mode. Privacy modes
// govern captured history, not the user's own repository list: without the
// persisted roots the graph would be empty after every restart until each repo
// emitted another event. The file is never part of the spool, the stream, an
// export or any API response.
func (s *Server) rememberGraphRoot(root, vcs string) error {
	s.graph.mu.Lock()
	defer s.graph.mu.Unlock()
	roots := mergeGraphRoots(s.graph.roots, graphRoot{root, vcs})
	if len(roots) == len(s.graph.roots) {
		same := true
		for i := range roots {
			if roots[i] != s.graph.roots[i] {
				same = false
				break
			}
		}
		if same {
			return nil
		}
	}
	if err := s.writeGraphRoots(roots); err != nil {
		return err
	}
	s.graph.roots = roots
	return nil
}

func (s *Server) writeGraphRoots(roots []graphRoot) error {
	data, err := json.Marshal(roots)
	if err != nil {
		return err
	}
	dir := filepath.Join(s.home, ".agentfirehose")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "graph-roots-*.tmp")
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
	return os.Rename(f.Name(), filepath.Join(dir, "graph-roots.json"))
}

// runGraphDiscovery runs outside capture admission. Only explicitly registered
// or pre-privacy observed roots are inspected; there is no filesystem crawl.
func (s *Server) runGraphDiscovery(ctx context.Context) {
	workspacegraph.SweepStaleShadows()
	s.reconcileGraphRoots(ctx)
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reconcileGraphRoots(ctx)
		}
	}
}

// reconcileGraphRoots resolves every remembered or observed root to the
// repository it belongs to, registers each repository once, and refreshes the
// known ones. Roots are consolidated up front, by reading files only:
//
//   - every checkout of one repository leads to the same registration, and what
//     is remembered (and persisted) is the repository's main checkout, so the
//     project outlives the worktree that first revealed it;
//   - a repository that cannot be scanned is one unavailable project, however
//     many of its checkouts were observed;
//   - a root that is not a repository is not a project. One that was remembered
//     and has since been deleted, or stopped being a repository, is forgotten,
//     unless it sits on a mount point that may simply not be mounted now.
func (s *Server) reconcileGraphRoots(ctx context.Context) {
	s.graph.mu.Lock()
	roots := append([]graphRoot(nil), s.graph.roots...)
	s.graph.mu.Unlock()
	remembered := len(roots)
	known := map[string]bool{}
	for _, root := range roots {
		known[graphRootKey(root.Root)] = true
	}
	observed := s.engine.ObservedRoots()
	for _, root := range observed {
		if !known[graphRootKey(root)] {
			roots = append(roots, graphRoot{Root: root})
			known[graphRootKey(root)] = true
		}
	}
	unavailable := map[string]string{}
	for i, root := range roots {
		if ctx.Err() != nil {
			return
		}
		s.graph.registrationMu.Lock()
		root = s.selectedGraphRoot(root)
		_, anchor, vcs, ok := workspacegraph.Identify(root.Root, root.VCS)
		switch {
		case !ok && i >= remembered:
			// Observed activity outside any repository.
		case !ok:
			if rootIsGone(root.Root) {
				_ = s.forgetGraphRoot(root.Root)
				s.graph.service.Forget(root.Root)
			} else {
				unavailable[root.Root] = root.VCS
			}
		default:
			scanCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			repo, err := s.graph.service.Register(scanCtx, root.Root, root.VCS)
			cancel()
			if err != nil {
				unavailable[anchor] = vcs
			} else {
				_ = s.rememberGraphRoot(anchoredRoot(root.Root, repo.ProjectLabel), root.VCS)
			}
		}
		s.graph.registrationMu.Unlock()
	}
	s.graph.mu.Lock()
	s.graph.unavailable = unavailable
	s.graph.mu.Unlock()
	// Refresh known repositories even when rediscovery fails, allowing the
	// service to retain and explicitly mark the last successful graph stale.
	for _, repo := range s.graph.service.Repositories() {
		if ctx.Err() != nil {
			return
		}
		scanCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		_, _ = s.graph.service.Snapshot(scanCtx, repo.ID, "", true)
		cancel()
	}
	s.observeWorktrees(ctx)
}

// anchoredRoot is what to remember for a root that registered: the repository's
// main checkout, unless that resolves to a different repository than the root
// did (a Git worktree of a project whose main checkout is a JJ workspace).
func anchoredRoot(root, anchor string) string {
	if anchor != "" && graphRootKey(anchor) == graphRootKey(root) {
		return anchor
	}
	return root
}

// rootIsGone reports that a remembered root is confirmed not to be a repository
// any more. Only two findings confirm it: the path does not exist (and is not
// merely unmounted), or it is a readable, non-empty directory with no VCS
// metadata entry at or above it. Anything less certain keeps the root, listed
// as unavailable: a permission error, metadata that is present but unreadable
// or broken, a path under a mount point, or an empty directory (which is what
// an unmounted mount point looks like).
func rootIsGone(root string) bool {
	if rootMayReturn(root) {
		return false
	}
	info, err := os.Stat(root)
	if errors.Is(err, fs.ErrNotExist) {
		return true
	}
	if err != nil {
		return false
	}
	if !info.IsDir() {
		return true
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) == 0 {
		return false
	}
	// The root may itself be a git dir (a bare repository) that stopped reading.
	if _, err := os.Lstat(filepath.Join(root, "HEAD")); !errors.Is(err, fs.ErrNotExist) {
		return false
	}
	for dir := root; ; dir = filepath.Dir(dir) {
		for _, name := range []string{".git", ".jj"} {
			if _, err := os.Lstat(filepath.Join(dir, name)); !errors.Is(err, fs.ErrNotExist) {
				return false
			}
		}
		if filepath.Dir(dir) == dir {
			return true
		}
	}
}

// rootMayReturn reports whether a root sits under a removable or network mount
// point, where missing or empty usually means "not mounted now".
func rootMayReturn(root string) bool {
	for _, prefix := range []string{"/Volumes/", "/media/", "/mnt/", "/run/media/"} {
		if strings.HasPrefix(root, prefix) {
			return true
		}
	}
	if volume := filepath.VolumeName(root); volume != "" {
		if _, err := os.Stat(volume + string(filepath.Separator)); err != nil {
			return true
		}
	}
	return false
}

// forgetGraphRoot drops a remembered root from memory and graph-roots.json.
func (s *Server) forgetGraphRoot(root string) error {
	s.graph.mu.Lock()
	defer s.graph.mu.Unlock()
	kept := make([]graphRoot, 0, len(s.graph.roots))
	for _, existing := range s.graph.roots {
		if existing.Root != root {
			kept = append(kept, existing)
		}
	}
	if len(kept) == len(s.graph.roots) {
		return nil
	}
	if err := s.writeGraphRoots(kept); err != nil {
		return err
	}
	s.graph.roots = kept
	return nil
}

func (s *Server) handleGraphRepos(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	repos := s.graph.service.Repositories()
	knownRoots := make(map[string]bool, len(repos))
	knownIDs := make(map[string]bool, len(repos))
	for _, repo := range repos {
		if root, _, err := s.graph.service.Root(repo.ID); err == nil {
			knownRoots[canonicalGraphRoot(root)] = true
		}
		if aliases, _, err := s.graph.service.EventScope(repo.ID, ""); err == nil && len(aliases) > 0 {
			knownIDs[aliases[0]] = true
		}
	}
	full := s.currentPrivacyMode() == privacy.ModeFull
	var missing []workspacegraph.Repository
	s.graph.mu.Lock()
	for root, vcs := range s.graph.unavailable {
		// A retained failed/stale service registration already describes this
		// root. Synthetic rows are only for roots that could never register.
		if knownRoots[canonicalGraphRoot(root)] {
			continue
		}
		// The id is an opaque digest in every mode; the label is the readable
		// root path, like every other graph display value.
		sum := sha256.Sum256([]byte("unavailable:" + root))
		row := workspacegraph.Repository{ID: hex.EncodeToString(sum[:]), VCS: vcs, Label: root, Status: "unavailable", ProjectLabel: root}
		row.ProjectID = row.ID
		if id, _, resolved, ok := workspacegraph.Identify(root, vcs); ok {
			if knownIDs[id] {
				continue
			}
			if row.VCS == "" {
				row.VCS = resolved
			}
			// The project identity is the one events carry, so sessions captured
			// in the repository still belong to this row's project.
			if resolved == "git" {
				row.ProjectID = id
				if !full {
					row.ProjectID = digestString(id)
				}
			}
		}
		missing = append(missing, row)
	}
	s.graph.mu.Unlock()
	sort.Slice(missing, func(i, j int) bool { return missing[i].Label < missing[j].Label })
	writeJSON(w, append(repos, missing...))
}
func (s *Server) handleGraphRegister(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	var input graphRoot
	if json.NewDecoder(r.Body).Decode(&input) != nil || !filepath.IsAbs(input.Root) {
		http.Error(w, "root must be an absolute local directory", 400)
		return
	}
	if input.VCS != "" && input.VCS != "git" && input.VCS != "jj" {
		http.Error(w, "vcs must be git or jj", 400)
		return
	}
	s.graph.registrationMu.Lock()
	defer s.graph.registrationMu.Unlock()
	if input.VCS == "" {
		input = s.selectedGraphRoot(input)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	repo, err := s.graph.service.Register(ctx, input.Root, input.VCS)
	if err != nil {
		http.Error(w, "repository unavailable or VCS command failed", 422)
		return
	}
	if s.rememberGraphRoot(anchoredRoot(input.Root, repo.ProjectLabel), input.VCS) != nil {
		http.Error(w, "could not persist repository registration", 500)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, repo)
}
func (s *Server) handleGraph(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	snapshot, err := s.graph.service.Snapshot(ctx, q.Get("repo_id"), q.Get("cursor"), q.Get("refresh") == "true")
	if err != nil {
		http.Error(w, "graph unavailable; register the repository or retry refresh", 422)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	type association struct {
		RepoID      string `json:"repo_id"`
		WorkspaceID string `json:"workspace_id"`
		EventID     string `json:"event_id"`
	}
	attachments := map[string]association{}
	aliases := map[string]string{}
	if _, wsAliases, ok := s.graph.service.WorkspaceAliases(snapshot.Repository.ID); ok {
		for wsID, ids := range wsAliases {
			for _, id := range ids {
				aliases[id] = wsID
			}
		}
	} else {
		for _, ws := range snapshot.Workspaces {
			_, ids, _ := s.graph.service.EventScope(snapshot.Repository.ID, ws.ID)
			for _, id := range ids {
				aliases[id] = ws.ID
			}
		}
	}
	for _, session := range s.engine.Attention().Sessions {
		ws := aliases[session.WorktreeID]
		if snapshot.Repository.VCS == "jj" {
			ws = aliases[session.JJWorkspaceID]
		}
		if ws != "" {
			attachments[session.Source+"\x00"+session.ID] = association{snapshot.Repository.ID, ws, session.Last.EventID}
		}
	}
	writeJSON(w, struct {
		workspacegraph.Snapshot
		AttentionAssociations map[string]association `json:"attention_associations"`
	}{snapshot, attachments})
}
func (s *Server) handleGraphCompare(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	comparison, err := s.graph.service.Compare(ctx, q.Get("repo_id"), q.Get("revision"), q.Get("target"))
	if err != nil {
		http.Error(w, "comparison unavailable; select valid revisions", 422)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, comparison)
}
func (s *Server) handleGraphTimeline(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 200
	if q.Get("limit") != "" {
		n, err := strconv.Atoi(q.Get("limit"))
		if err != nil || n <= 0 {
			http.Error(w, "limit must be positive", 400)
			return
		}
		limit = n
	}
	var wsAliases map[string][]string
	var haveAliases bool
	if q.Get("repo_id") != "" {
		_, wsAliases, haveAliases = s.graph.service.WorkspaceAliases(q.Get("repo_id"))
		if !haveAliases {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			_, scanErr := s.graph.service.Snapshot(ctx, q.Get("repo_id"), "", false)
			cancel()
			if scanErr == nil {
				_, wsAliases, haveAliases = s.graph.service.WorkspaceAliases(q.Get("repo_id"))
			}
		}
	}
	repoAliases, workspaceAliases, _ := s.graph.service.EventScope(q.Get("repo_id"), q.Get("workspace_id"))
	page, err := s.engine.Timeline(r.Context(), capture.TimelineQuery{RepoAliases: repoAliases, WorkspaceAliases: workspaceAliases, RepoID: q.Get("repo_id"), WorkspaceID: q.Get("workspace_id"), Source: q.Get("source"), SessionID: q.Get("session_id"), Category: q.Get("category"), Search: q.Get("search"), Cursor: q.Get("cursor"), Limit: limit})
	if err != nil {
		if r.Context().Err() != nil {
			return // the client abandoned the request; the scan has already stopped
		}
		http.Error(w, "timeline query failed; check source, session and cursor", 400)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	type association struct {
		RepoID      string `json:"repo_id"`
		WorkspaceID string `json:"workspace_id"`
	}
	associations := map[string]association{}
	if q.Get("repo_id") != "" {
		// Resolve only registered exact identity aliases. Captured envelopes remain immutable.
		workspaceIDs := map[string]string{}
		if haveAliases {
			for wsID, aliases := range wsAliases {
				for _, alias := range aliases {
					workspaceIDs[alias] = wsID
				}
			}
		}
		for _, ev := range page.Events {
			ws := workspaceIDs[ev.WorktreeID]
			if ws == "" {
				ws = workspaceIDs[ev.JJWorkspaceID]
			}
			associations[ev.ID] = association{q.Get("repo_id"), ws}
		}
	}
	writeJSON(w, struct {
		capture.TimelinePage
		Associations map[string]association `json:"associations"`
	}{page, associations})
}

// activityBuckets is the bucket ladder in seconds; the default is the smallest
// step giving at most activityDefaultBuckets columns.
var activityBuckets = []int{60, 300, 900, 3600, 10800, 21600, 86400}

const (
	activityDefaultBuckets = 240
	activityMaxBuckets     = 2000
	activityMaxWindow      = 31 * 24 * time.Hour
	activityOutsideLabel   = "Outside known worktrees"
)

type activityGroup struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Resolved bool   `json:"resolved"`
}

// handleGraphActivity reports Heat (file-category observations per path per
// time bucket) for one repository identity. Paths are display values, readable
// in balanced and full mode like every other graph label; in minimal mode they
// are digests on disk, so the response is explicitly unavailable and no spool
// day is read.
func (s *Server) handleGraphActivity(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	repoID, workspaceID := q.Get("repo_id"), q.Get("workspace_id")
	if repoID == "" {
		http.Error(w, "repo_id is required", 400)
		return
	}
	to := time.Now().UTC()
	if v := q.Get("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "to must be RFC 3339", 400)
			return
		}
		to = t.UTC()
	}
	from := to.Add(-24 * time.Hour)
	if v := q.Get("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "from must be RFC 3339", 400)
			return
		}
		from = t.UTC()
	}
	if !from.Before(to) || to.Sub(from) > activityMaxWindow {
		http.Error(w, "window must satisfy from < to and span at most 31 days", 400)
		return
	}
	bucket := 0
	if v := q.Get("bucket"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || !slices.Contains(activityBuckets, n) {
			http.Error(w, "bucket must be one of 60, 300, 900, 3600, 10800, 21600, 86400", 400)
			return
		}
		bucket = n
	} else {
		bucket = activityBuckets[len(activityBuckets)-1]
		for _, step := range activityBuckets {
			if to.Sub(from) <= time.Duration(step*activityDefaultBuckets)*time.Second {
				bucket = step
				break
			}
		}
	}
	floored, buckets := capture.ActivityWindow(from, to, time.Duration(bucket)*time.Second)
	if buckets > activityMaxBuckets {
		http.Error(w, "window holds more than 2000 buckets; choose a larger bucket", 400)
		return
	}
	repoAliases, workspaceAliases, err := s.graph.service.EventScope(repoID, workspaceID)
	if err != nil && workspaceID != "" {
		// A worktree the current snapshot no longer lists (a removed fork) is still a
		// valid historical identity when the daemon observed it: its captured events
		// keep answering under the raw path or its digest.
		if repoScope, _, repoErr := s.graph.service.EventScope(repoID, ""); repoErr == nil {
			if _, rec := s.worktrees.observation().lookup(repoScope[0], workspaceID); rec != nil {
				repoAliases, workspaceAliases, err = repoScope, []string{rec.Worktree, digestString(rec.Worktree)}, nil
			}
		}
	}
	if err != nil {
		http.Error(w, "repository or workspace unknown; register the repository or refresh", 422)
		return
	}
	resp := struct {
		RepoID            string                      `json:"repo_id"`
		WorkspaceID       string                      `json:"workspace_id"`
		From              time.Time                   `json:"from"`
		To                time.Time                   `json:"to"`
		BucketSeconds     int                         `json:"bucket_seconds"`
		Buckets           int                         `json:"buckets"`
		Available         bool                        `json:"available"`
		UnavailableReason string                      `json:"unavailable_reason"`
		Paths             []capture.ActivityPath      `json:"paths"`
		ErrorPaths        []capture.ActivityErrorPath `json:"error_paths"`
		OmittedErrorPaths int                         `json:"omitted_error_paths"`
		Groups            []activityGroup             `json:"groups"`
		FileEvents        int                         `json:"file_events"`
		Unreadable        int                         `json:"unreadable_file_events"`
		Truncated         bool                        `json:"truncated"`
		TruncatedTotal    int                         `json:"truncated_total"`
		CaptureGap        bool                        `json:"capture_gap"`
	}{RepoID: repoID, WorkspaceID: workspaceID, From: floored, To: to, BucketSeconds: bucket, Buckets: buckets, Paths: []capture.ActivityPath{}, ErrorPaths: []capture.ActivityErrorPath{}, Groups: []activityGroup{}}
	s.mu.RLock()
	minimal := s.cfg.PrivacyMode == string(privacy.ModeMinimal)
	s.mu.RUnlock()
	w.Header().Set("Cache-Control", "no-store")
	if minimal {
		resp.UnavailableReason = "minimal"
		writeJSON(w, resp)
		return
	}

	roots := activityRoots{}
	if len(repoAliases) > 0 {
		_, wsAliases, ok := s.graph.service.WorkspaceAliases(repoID)
		if !ok {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			_, scanErr := s.graph.service.Snapshot(ctx, repoID, "", false)
			cancel()
			if scanErr == nil {
				_, wsAliases, ok = s.graph.service.WorkspaceAliases(repoID)
			}
		}
		if ok {
			for _, aliases := range wsAliases {
				roots.add(repoAliases[0], aliases)
			}
		}
	}
	result, err := s.engine.Activity(r.Context(), capture.ActivityQuery{RepoID: repoID, WorkspaceID: workspaceID, RepoAliases: repoAliases, WorkspaceAliases: workspaceAliases, From: from, To: to, Bucket: time.Duration(bucket) * time.Second, Resolve: roots.resolve})
	if err != nil {
		if r.Context().Err() != nil {
			return // the client abandoned the request; the scan has already stopped
		}
		http.Error(w, "activity query failed", 500)
		return
	}
	resp.Available = true
	resp.ErrorPaths, resp.OmittedErrorPaths = result.ErrorPaths, result.OmittedErrorPaths
	resp.Paths, resp.FileEvents, resp.Unreadable = result.Paths, result.FileEvents, result.UnreadableFileEvents
	resp.Truncated, resp.TruncatedTotal, resp.CaptureGap = result.Truncated, result.TruncatedTotal, result.CaptureGap
	seen := map[string]bool{}
	groups := make([]string, 0, len(result.Paths)+len(result.ErrorPaths))
	for _, p := range result.Paths {
		groups = append(groups, p.Group)
	}
	for _, p := range result.ErrorPaths {
		groups = append(groups, p.Group)
	}
	slices.Sort(groups)
	for _, group := range groups { // resolved group first
		if seen[group] {
			continue
		}
		seen[group] = true
		if group == "" {
			resp.Groups = append(resp.Groups, activityGroup{Resolved: true})
		} else {
			resp.Groups = append(resp.Groups, activityGroup{ID: group, Label: activityOutsideLabel})
		}
	}
	writeJSON(w, resp)
}

// activityRoots maps each workspace identity alias (raw and digest) to its
// readable root, joining digested event identities to the workspace graph.
type activityRoots struct {
	byAlias map[string]string
	all     []string
}

func (a *activityRoots) add(repoIdentity string, aliases []string) {
	// A Git workspace's raw identity is its canonical root; a JJ workspace's is
	// "jj:" + root, or <repo identity>:<name> when JJ reports no root at all.
	if len(aliases) == 0 || strings.HasPrefix(aliases[0], repoIdentity+":") {
		return
	}
	root := strings.TrimPrefix(aliases[0], "jj:")
	if !filepath.IsAbs(root) {
		return
	}
	if a.byAlias == nil {
		a.byAlias = map[string]string{}
	}
	for _, alias := range aliases {
		a.byAlias[alias] = root
	}
	a.all = append(a.all, root)
}

// resolve returns ("", repository-relative path) when path lies under a known
// root, preferring the innermost root that contains it; otherwise the event's
// own worktree identity as the group and the raw path.
func (a *activityRoots) resolve(ev event.Event, path string) (string, string) {
	own, ownID := "", ""
	for _, id := range []string{ev.WorktreeID, ev.JJWorkspaceID} {
		if id == "" {
			continue
		}
		if ownID == "" {
			ownID = id
		}
		if root, ok := a.byAlias[id]; ok && own == "" {
			own = root
		}
	}
	unresolved := func() (string, string) {
		if ownID == "" {
			return "unknown", path
		}
		return ownID, path
	}
	clean := filepath.Clean(path)
	if !filepath.IsAbs(clean) {
		if own == "" || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return unresolved()
		}
		return "", filepath.ToSlash(clean)
	}
	// The event's own root_alias maps a path captured through a symlink onto the
	// canonical root. This is lexical on purpose: the daemon makes no filesystem
	// calls on captured paths, which are untrusted.
	if alias := ev.RootAlias; ownID != "" && filepath.IsAbs(alias) && under(alias, clean) {
		// ownID prefers the Git worktree, which is the root the alias spells.
		if root, ok := a.byAlias[ownID]; ok {
			rel, _ := filepath.Rel(alias, clean)
			clean = filepath.Join(root, rel)
		}
	}
	best := ""
	for _, root := range a.all {
		if len(root) > len(best) && under(root, clean) {
			best = root
		}
	}
	if best == "" {
		return unresolved()
	}
	rel, _ := filepath.Rel(best, clean)
	return "", filepath.ToSlash(rel)
}

func under(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// Root configuration is loaded before the server is exposed to requests. The
// file is read in every privacy mode and never deleted by a mode change.
// Entries that are not absolute paths or name an unknown VCS are ignored.
func (s *Server) loadGraphRoots() {
	data, err := os.ReadFile(filepath.Join(s.home, ".agentfirehose", "graph-roots.json"))
	if err != nil {
		return
	}
	var roots []graphRoot
	if json.Unmarshal(data, &roots) != nil {
		return
	}
	for _, root := range roots {
		if !filepath.IsAbs(root.Root) || root.VCS != "" && root.VCS != "git" && root.VCS != "jj" {
			continue
		}
		s.graph.roots = mergeGraphRoots(s.graph.roots, root)
	}
}
func canonicalGraphRoot(root string) string {
	if p, err := filepath.EvalSymlinks(root); err == nil {
		root = p
	}
	if p, err := filepath.Abs(root); err == nil {
		root = p
	}
	return filepath.Clean(root)
}

// graphRootKey is the repository a root belongs to (its raw identity, found by
// reading files only), so every checkout of one repository shares a key. A
// root outside any repository is its own key.
func graphRootKey(root string) string {
	root = canonicalGraphRoot(root)
	if id, _, _, ok := workspacegraph.Identify(root, ""); ok {
		return id
	}
	return root
}
func mergeGraphRoots(existing []graphRoot, candidate graphRoot) []graphRoot {
	candidate.Root = canonicalGraphRoot(candidate.Root)
	key := graphRootKey(candidate.Root)
	out := make([]graphRoot, 0, len(existing)+1)
	for _, root := range existing {
		if graphRootKey(root.Root) == key {
			if candidate.VCS == "" && root.VCS != "" {
				candidate = root
			}
			continue
		}
		out = append(out, root)
	}
	return append(out, candidate)
}
func (s *Server) selectedGraphRoot(candidate graphRoot) graphRoot {
	s.graph.mu.Lock()
	defer s.graph.mu.Unlock()
	key := graphRootKey(candidate.Root)
	for _, root := range s.graph.roots {
		if graphRootKey(root.Root) == key {
			return root
		}
	}
	candidate.Root = canonicalGraphRoot(candidate.Root)
	return candidate
}
func (s *Server) graphResponse(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// SSE uses a different route. Bound graph writes so a stalled desktop
		// cannot indefinitely hold the privacy-transition response gate.
		controller := http.NewResponseController(w)
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		defer controller.SetWriteDeadline(time.Time{})
		s.graphResponseMu.RLock()
		defer s.graphResponseMu.RUnlock()
		handler(w, r)
	}
}
