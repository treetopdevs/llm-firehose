package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var ErrNotFound = errors.New("repository unavailable")
var ErrCursor = errors.New("expired or invalid graph cursor")

// scanFunc is the VCS scan implementation; tests replace it to inspect
// coalescing and concurrency without running git/jj subprocesses.
var scanFunc = scan

// onInflightJoin is a test seam invoked after a caller joins an in-flight scan.
var onInflightJoin func()

type inflightScan struct {
	done      chan struct{}
	cancel    context.CancelFunc
	epoch     uint64
	sequence  uint64
	limit     int
	waiters   int
	abandoned bool
	snap      Snapshot
	err       error
}

type registration struct {
	// root is where commands run and what the project is named after: the main
	// checkout or main workspace (the git dir of a bare repository).
	root, identity, vcs string
	// label is the checkout or workspace that first registered the repository,
	// the meaning Repository.label has always had.
	label string
	// projectRoot names the project: root, or for JJ backed by a Git repository
	// that repository's main checkout, so both views report one project_label.
	projectRoot string
	// project is the raw identity shared by every registration of one project
	// (the Git common dir for Git and for JJ colocated with it).
	project  string
	git      gitLayout
	snapshot *Snapshot
	inflight *inflightScan
	limit    int
	sequence uint64
	failed   bool
}
type Service struct {
	mu       sync.Mutex
	mode     privacy.Mode
	repos    map[string]*registration
	pageSize int
	epoch    uint64
}

func New(mode privacy.Mode) *Service {
	return &Service{mode: mode, repos: map[string]*registration{}, pageSize: 2000}
}
func canonical(p string) (string, error) {
	a, e := filepath.Abs(p)
	if e != nil {
		return "", e
	}
	return filepath.EvalSymlinks(a)
}

// identity is the only mode-dependent value in a graph response. Repository.ID
// and Workspace.ID must equal the privacy-processed identities Capture stamps on
// events (a digest outside full mode), or session association would stop
// matching. Every display value (labels, refs, descriptions, paths) is raw.
func identity(p string, m privacy.Mode) string { return privacy.Identity(p, m) }

// Register makes a repository known by any directory inside it. The repository
// is located by reading files only and anchored on its main checkout (Git) or
// main workspace (JJ), so every worktree of one repository is one registration
// that outlives the checkout which led to it. With vcs empty or "auto" both
// sides of a colocated project are registered, whichever led here: the Git
// repository carries the identity Capture stamps on every event there (so
// sessions, worktree states and the graph agree on one project), and the JJ
// repository is the same project seen through its workspaces. Naming a vcs is
// an explicit choice for that root and replaces its other registration.
func (s *Service) Register(ctx context.Context, root, vcs string) (Repository, error) {
	root, e := canonical(root)
	if e != nil {
		return Repository{}, errors.New("root inaccessible")
	}
	auto := vcs == "" || vcs == "auto"
	if auto {
		vcs = nearestVCS(root)
	}
	var reg *registration
	switch vcs {
	case "git":
		reg, e = s.registerGit(ctx, root)
		if e == nil && auto && reg.git.main != "" {
			if l, err := locateJJ(reg.git.main); err == nil && l.git == reg.git.common && l.anchor == reg.git.main {
				_, _ = s.registerJJ(ctx, reg.git.main)
			}
		}
	case "jj":
		reg, e = s.registerJJ(ctx, root)
		if e == nil && auto && reg.project != reg.identity {
			_, _ = s.registerGit(ctx, reg.project)
		}
	default:
		return Repository{}, errors.New("unsupported VCS")
	}
	if e != nil {
		return Repository{}, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !auto {
		for key, existing := range s.repos {
			if existing.root == reg.root && existing.vcs != vcs {
				delete(s.repos, key)
			}
		}
	}
	return s.repository(reg), nil
}

// known returns the existing registration of an identity, so re-registering a
// repository (every reconciliation does, once per observed checkout) costs no
// VCS command.
func (s *Service) known(id string) *registration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.repos[id]
}

func (s *Service) adopt(reg *registration) *registration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing := s.repos[reg.identity]; existing != nil {
		return existing
	}
	s.repos[reg.identity] = reg
	return reg
}

func (s *Service) registerGit(ctx context.Context, root string) (*registration, error) {
	layout, e := locateGit(root)
	if e != nil {
		return nil, e
	}
	if existing := s.known(layout.common); existing != nil {
		// A repository first reached through a linked worktree of a separate git
		// dir has no known main checkout until that checkout leads here.
		s.mu.Lock()
		if existing.git.main == "" && layout.main != "" {
			existing.git.main, existing.git.anchor = layout.main, layout.anchor
			existing.root, existing.projectRoot, existing.snapshot = layout.anchor, layout.anchor, nil
			existing.inflight = nil
			// A scan already running copied the old layout: supersede it, so its
			// result is discarded instead of cached.
			existing.sequence++
		}
		s.mu.Unlock()
		return existing, nil
	}
	// Prove the repository can be read before it is listed.
	session, e := openGitSession(ctx, layout)
	if e != nil {
		return nil, e
	}
	session.cleanup()
	label := layout.top
	if label == "" {
		label = layout.anchor
	}
	return s.adopt(&registration{root: layout.anchor, projectRoot: layout.anchor, label: label, identity: layout.common, vcs: "git", project: layout.common, git: layout}), nil
}

func (s *Service) registerJJ(ctx context.Context, root string) (*registration, error) {
	layout, e := locateJJ(root)
	if e != nil {
		return nil, e
	}
	id := "jj:" + layout.repo
	if existing := s.known(id); existing != nil {
		return existing, nil
	}
	if _, e := run(ctx, layout.anchor, "jj", "root"); e != nil {
		return nil, e
	}
	project, projectRoot := id, layout.anchor
	if layout.git != "" {
		project, projectRoot = layout.git, layout.gitAnchor
	}
	return s.adopt(&registration{root: layout.anchor, projectRoot: projectRoot, label: layout.top, identity: id, vcs: "jj", project: project}), nil
}
func (s *Service) repository(r *registration) Repository {
	status := "pending"
	if r.failed {
		status = "unavailable"
	}
	var at time.Time
	if r.snapshot != nil {
		status = "ready"
		at = r.snapshot.Repository.ObservedAt
		if r.snapshot.Stale {
			status = "stale"
		}
	}
	return describeRepository(*r, s.mode, at, status)
}

func describeRepository(r registration, m privacy.Mode, at time.Time, status string) Repository {
	return Repository{ID: identity(r.identity, m), VCS: r.vcs, Label: r.label, ObservedAt: at, Status: status, ProjectID: identity(r.project, m), ProjectLabel: r.projectRoot}
}

// Forget drops every registration anchored on root, for a repository whose
// root is confirmed gone. It reports whether any was dropped.
func (s *Service) Forget(root string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	dropped := false
	for key, r := range s.repos {
		if r.root == root || r.label == root {
			delete(s.repos, key)
			dropped = true
		}
	}
	return dropped
}

// Repositories lists registrations by id.
func (s *Service) Repositories() []Repository {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Repository{}
	for _, r := range s.repos {
		out = append(out, s.repository(r))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
func (s *Service) SetPrivacy(mode privacy.Mode) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if mode != s.mode {
		s.mode = mode
		s.epoch++
		for _, r := range s.repos {
			r.snapshot = nil
			r.inflight = nil
		}
	}
}
func (s *Service) find(id string) *registration {
	for _, r := range s.repos {
		if identity(r.identity, s.mode) == id {
			return r
		}
	}
	return nil
}
func (s *Service) Snapshot(ctx context.Context, id, cursor string, refresh bool) (Snapshot, error) {
	s.mu.Lock()
	r := s.find(id)
	if r == nil {
		s.mu.Unlock()
		return Snapshot{}, ErrNotFound
	}
	mode, epoch := s.mode, s.epoch
	copyReg := *r
	limit := s.pageSize
	if r.limit > limit {
		limit = r.limit
	}
	if cursor != "" {
		if r.snapshot == nil || r.snapshot.NextCursor != cursor {
			s.mu.Unlock()
			return Snapshot{}, ErrCursor
		}
		limit = r.limit + s.pageSize
	} else if !refresh && r.snapshot != nil {
		out := clone(*r.snapshot)
		s.mu.Unlock()
		return out, nil
	}
	if err := ctx.Err(); err != nil {
		if r.inflight == nil {
			r.failed = true
			if r.snapshot != nil {
				v := clone(*r.snapshot)
				v.Stale = true
				v.Repository.Status = "stale"
				v.Warnings = append(v.Warnings, "scan failed; last successful snapshot retained")
				r.snapshot = &v
				out := clone(v)
				s.mu.Unlock()
				return out, nil
			}
		}
		s.mu.Unlock()
		return Snapshot{}, err
	}
	if in := r.inflight; in != nil && !in.abandoned && in.epoch == epoch && in.sequence == r.sequence && in.limit >= limit {
		in.waiters++
		joinHook := onInflightJoin
		s.mu.Unlock()
		if joinHook != nil {
			joinHook()
		}
		return s.waitForScan(ctx, r, in)
	}
	r.sequence++
	sequence := r.sequence
	scanCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	in := &inflightScan{done: make(chan struct{}), cancel: cancel, epoch: epoch, sequence: sequence, limit: limit, waiters: 1}
	r.inflight = in
	s.mu.Unlock()
	go func() {
		defer cancel()
		v, e := scanFunc(scanCtx, copyReg, limit, mode)
		s.mu.Lock()
		var out Snapshot
		var outErr error
		switch {
		case epoch != s.epoch:
			outErr = errors.New("privacy changed; retry scan")
		case sequence != r.sequence:
			if r.snapshot != nil {
				out = clone(*r.snapshot)
			} else {
				outErr = errors.New("scan superseded; retry")
			}
		case e != nil:
			if in.abandoned {
				outErr = e
			} else {
				r.failed = true
				if r.snapshot != nil {
					v = clone(*r.snapshot)
					v.Stale = true
					v.Repository.Status = "stale"
					v.Warnings = append(v.Warnings, "scan failed; last successful snapshot retained")
					r.snapshot = &v
					out = clone(v)
				} else {
					outErr = e
				}
			}
		default:
			r.failed = false
			v.Generation = strconv.FormatInt(time.Now().UnixNano(), 36)
			for _, boundary := range v.Boundaries {
				if boundary.Reason == "history not loaded" {
					v.NextCursor = v.Generation + ":" + strconv.Itoa(limit)
					break
				}
			}
			r.snapshot = &v
			r.limit = limit
			out = clone(v)
		}
		in.snap = out
		in.err = outErr
		if r.inflight == in {
			r.inflight = nil
		}
		close(in.done)
		s.mu.Unlock()
	}()
	return s.waitForScan(ctx, r, in)
}

func (s *Service) waitForScan(ctx context.Context, r *registration, in *inflightScan) (Snapshot, error) {
	select {
	case <-in.done:
		if in.err != nil {
			return Snapshot{}, in.err
		}
		return clone(in.snap), nil
	case <-ctx.Done():
		s.mu.Lock()
		in.waiters--
		if in.waiters == 0 {
			in.abandoned = true
			if r.inflight == in {
				r.inflight = nil
			}
			in.cancel()
		}
		s.mu.Unlock()
		return Snapshot{}, ctx.Err()
	}
}
func clone(v Snapshot) Snapshot {
	v.Nodes = append([]Revision{}, v.Nodes...)
	for i := range v.Nodes {
		v.Nodes[i].Parents = append([]string{}, v.Nodes[i].Parents...)
	}
	v.Workspaces = append([]Workspace{}, v.Workspaces...)
	for i := range v.Workspaces {
		v.Workspaces[i].Refs = append([]string{}, v.Workspaces[i].Refs...)
		v.Workspaces[i].ChangedFiles = append([]string{}, v.Workspaces[i].ChangedFiles...)
		v.Workspaces[i].Changes = copyChanges(v.Workspaces[i].Changes)
	}
	v.Edges = append([]Edge{}, v.Edges...)
	v.Boundaries = append([]Boundary{}, v.Boundaries...)
	v.Warnings = append([]string{}, v.Warnings...)
	return v
}

type boundedBuffer struct {
	bytes.Buffer
	exceeded bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 16<<20 {
		b.exceeded = true
		return 0, errors.New("VCS output limit")
	}
	return b.Buffer.Write(p)
}
func run(ctx context.Context, root, bin string, args ...string) (string, error) {
	return runEnv(ctx, root, bin, nil, args...)
}
func runEnv(ctx context.Context, root, bin string, env []string, args ...string) (string, error) {
	return runInput(ctx, root, bin, env, "", args...)
}
func runInput(ctx context.Context, root, bin string, env []string, stdin string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if bin == "jj" {
		prefix := []string{"--ignore-working-copy", "--no-pager", "--color=never"}
		hasOp := false
		for _, a := range args {
			if strings.HasPrefix(a, "--at-op=") {
				hasOp = true
			}
		}
		if !hasOp {
			prefix = append(prefix, "--at-op=@")
		}
		args = append(prefix, args...)
	}
	if bin == "git" {
		args = append([]string{"-c", "core.fsmonitor=false"}, args...)
	}
	c := exec.CommandContext(cctx, resolveTool(bin), args...)
	c.Dir = root
	c.Env = append(append(scanEnv(os.Environ()), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GIT_NO_LAZY_FETCH=1", "LC_ALL=C"), env...)
	var out, stderr boundedBuffer
	if stdin != "" {
		c.Stdin = strings.NewReader(stdin)
	}
	c.Stdout = &out
	c.Stderr = &stderr
	c.WaitDelay = time.Second
	if e := c.Run(); e != nil {
		if cctx.Err() != nil {
			return "", errors.New("VCS scan timed out or cancelled")
		}
		return "", &commandError{bin: bin, cause: e}
	}
	return out.String(), nil
}

// scanEnv is the daemon's environment without any GIT_* variable. An inherited
// GIT_DIR, GIT_COMMON_DIR, GIT_CONFIG*, GIT_EXEC_PATH or object-directory
// override (a daemon started from a hook or a wrapper has them) would point a
// scan back at the live repository config or at other code, so every VCS
// command starts from none and gets only the ones the scanner sets. Names are
// matched without regard to case, as Windows resolves them.
func scanEnv(environ []string) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		name, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(strings.ToUpper(name), "GIT_") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// CachedSnapshot returns the retained snapshot of a repository without ever
// scanning: ok is false when none is cached (never scanned, or cleared by a
// privacy change).
func (s *Service) CachedSnapshot(id string) (Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(id)
	if r == nil || r.snapshot == nil {
		return Snapshot{}, false
	}
	return clone(*r.snapshot), true
}

// Root exposes raw scan configuration only to the host, never to a response.
func (s *Service) Root(id string) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(id)
	if r == nil {
		return "", "", ErrNotFound
	}
	return r.root, r.vcs, nil
}

// EventScope returns historical identity aliases for exact event association.
func (s *Service) EventScope(repoID, workspaceID string) ([]string, []string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(repoID)
	if r == nil {
		return nil, nil, ErrNotFound
	}
	repo := []string{r.identity, privacy.HashIdentity(r.identity)}
	if workspaceID == "" {
		return repo, nil, nil
	}
	if r.snapshot != nil {
		for _, w := range r.snapshot.Workspaces {
			if w.ID == workspaceID {
				return repo, []string{w.rawIdentity, privacy.HashIdentity(w.rawIdentity)}, nil
			}
		}
	}
	return nil, nil, ErrNotFound
}

// WorkspaceAliases returns the repository's identity aliases and every cached
// workspace's identity aliases keyed by workspace ID under a single lock,
// without cloning the snapshot's revision graph. ok is false when the
// repository is unknown or has no cached snapshot yet.
func (s *Service) WorkspaceAliases(repoID string) ([]string, map[string][]string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.find(repoID)
	if r == nil || r.snapshot == nil {
		return nil, nil, false
	}
	repo := []string{r.identity, privacy.HashIdentity(r.identity)}
	ws := make(map[string][]string, len(r.snapshot.Workspaces))
	for _, w := range r.snapshot.Workspaces {
		ws[w.ID] = []string{w.rawIdentity, privacy.HashIdentity(w.rawIdentity)}
	}
	return repo, ws, true
}

type commandError struct {
	bin   string
	cause error
}

func (e *commandError) Error() string {
	return fmt.Sprintf("%s read failed (CLI unavailable, inaccessible repository, or output limit)", e.bin)
}
func (e *commandError) Unwrap() error { return e.cause }
