package daemon

import (
	"agentfirehose/internal/capture"
	"agentfirehose/internal/workspace"
	"agentfirehose/internal/workspacegraph"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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
	if err = os.Rename(f.Name(), filepath.Join(dir, "graph-roots.json")); err != nil {
		return err
	}
	s.graph.roots = roots
	return nil
}

// runGraphDiscovery runs outside capture admission. Only explicitly registered
// or pre-privacy observed roots are inspected; there is no filesystem crawl.
func (s *Server) runGraphDiscovery(ctx context.Context) {
	reconcile := func() {
		s.graph.mu.Lock()
		roots := append([]graphRoot(nil), s.graph.roots...)
		s.graph.mu.Unlock()
		known := map[string]bool{}
		for _, root := range roots {
			known[graphRootKey(root.Root)] = true
		}
		for _, root := range s.engine.ObservedRoots() {
			if !known[graphRootKey(root)] {
				roots = append(roots, graphRoot{Root: root})
				known[graphRootKey(root)] = true
			}
		}
		for _, root := range roots {
			if ctx.Err() != nil {
				return
			}
			s.graph.registrationMu.Lock()
			root = s.selectedGraphRoot(root)
			scanCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			_, err := s.graph.service.Register(scanCtx, root.Root, root.VCS)
			s.graph.mu.Lock()
			if s.graph.unavailable == nil {
				s.graph.unavailable = map[string]string{}
			}
			if err != nil {
				s.graph.unavailable[root.Root] = root.VCS
			} else {
				delete(s.graph.unavailable, root.Root)
			}
			s.graph.mu.Unlock()
			if err == nil {
				_ = s.rememberGraphRoot(root.Root, root.VCS)
			}
			cancel()
			s.graph.registrationMu.Unlock()
		}
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
	}
	reconcile()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reconcile()
		}
	}
}
func (s *Server) handleGraphRepos(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	repos := s.graph.service.Repositories()
	knownRoots := make(map[string]bool, len(repos))
	for _, repo := range repos {
		if root, _, err := s.graph.service.Root(repo.ID); err == nil {
			knownRoots[canonicalGraphRoot(root)] = true
		}
	}
	mode := s.config().PrivacyMode
	s.graph.mu.Lock()
	for root, vcs := range s.graph.unavailable {
		// A retained failed/stale service registration already describes this
		// root. Synthetic rows are only for roots that could never register.
		if knownRoots[canonicalGraphRoot(root)] {
			continue
		}
		sum := sha256.Sum256([]byte("unavailable:" + root))
		id := hex.EncodeToString(sum[:])
		label := root
		if mode != "full" {
			sum := sha256.Sum256([]byte(root))
			label = hex.EncodeToString(sum[:])
		}
		repos = append(repos, workspacegraph.Repository{ID: id, VCS: vcs, Label: label, Status: "unavailable"})
	}
	s.graph.mu.Unlock()
	writeJSON(w, repos)
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
	if s.rememberGraphRoot(input.Root, input.VCS) != nil {
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
	for _, ws := range snapshot.Workspaces {
		_, ids, _ := s.graph.service.EventScope(snapshot.Repository.ID, ws.ID)
		for _, id := range ids {
			aliases[id] = ws.ID
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
	var snapshot workspacegraph.Snapshot
	var scanErr error
	if q.Get("repo_id") != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		snapshot, scanErr = s.graph.service.Snapshot(ctx, q.Get("repo_id"), "", false)
		cancel()
	}
	repoAliases, workspaceAliases, _ := s.graph.service.EventScope(q.Get("repo_id"), q.Get("workspace_id"))
	page, err := s.engine.Timeline(capture.TimelineQuery{RepoAliases: repoAliases, WorkspaceAliases: workspaceAliases, RepoID: q.Get("repo_id"), WorkspaceID: q.Get("workspace_id"), Source: q.Get("source"), SessionID: q.Get("session_id"), Category: q.Get("category"), Search: q.Get("search"), Cursor: q.Get("cursor"), Limit: limit})
	if err != nil {
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
		if scanErr == nil {
			for _, ws := range snapshot.Workspaces {
				_, aliases, _ := s.graph.service.EventScope(q.Get("repo_id"), ws.ID)
				for _, alias := range aliases {
					workspaceIDs[alias] = ws.ID
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

// Root configuration is loaded before the server is exposed to requests.
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
func graphRootKey(root string) string {
	root = canonicalGraphRoot(root)
	if repo, _ := workspace.ObserveJJ(root); repo != "" {
		return repo
	}
	if repo, _ := workspace.Observe(root); repo != "" {
		return repo
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
