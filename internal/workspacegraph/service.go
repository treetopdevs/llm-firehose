package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

type registration struct {
	root, identity, vcs string
	snapshot            *Snapshot
	limit               int
	sequence            uint64
	failed              bool
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
func digest(p string) string { h := sha256.Sum256([]byte(p)); return hex.EncodeToString(h[:]) }

// identity is the only mode-dependent value in a graph response. Repository.ID
// and Workspace.ID must equal the privacy-processed identities Capture stamps on
// events (a digest outside full mode), or session association would stop
// matching. Every display value (labels, refs, descriptions, paths) is raw.
func identity(p string, m privacy.Mode) string {
	if m == privacy.ModeFull {
		return p
	}
	return digest(p)
}
func (s *Service) Register(ctx context.Context, root, vcs string) (Repository, error) {
	root, e := canonical(root)
	if e != nil {
		return Repository{}, errors.New("root inaccessible")
	}
	if vcs == "" || vcs == "auto" {
		vcs = "git"
		if _, e := os.Stat(filepath.Join(root, ".jj")); e == nil {
			vcs = "jj"
		}
	}
	var id string
	switch vcs {
	case "git":
		if e := guardGitConfig(ctx, root); e != nil {
			return Repository{}, e
		}
		if top, err := run(ctx, root, "git", "rev-parse", "--show-toplevel"); err == nil {
			if c, err := canonical(strings.TrimSpace(top)); err == nil {
				root = c
			}
		}
		b, e := run(ctx, root, "git", "rev-parse", "--path-format=absolute", "--git-common-dir")
		if e != nil {
			return Repository{}, e
		}
		id, e = canonical(strings.TrimSpace(b))
		if e != nil {
			return Repository{}, errors.New("repository inaccessible")
		}
	case "jj":
		b, e := run(ctx, root, "jj", "root")
		if e != nil {
			return Repository{}, e
		}
		root = strings.TrimSpace(b)
		id = "jj:" + root // Resolve shared store for linked JJ workspaces.
		p := filepath.Join(root, ".jj", "repo")
		if b, e := os.ReadFile(p); e == nil {
			p = strings.TrimSpace(string(b))
			if !filepath.IsAbs(p) {
				p = filepath.Join(root, ".jj", p)
			}
		}
		if c, e := canonical(p); e == nil {
			id = "jj:" + c
		}
	default:
		return Repository{}, errors.New("unsupported VCS")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, existing := range s.repos {
		if existing.root == root && existing.vcs != vcs {
			delete(s.repos, key)
		}
	}
	if existing := s.repos[id]; existing == nil {
		s.repos[id] = &registration{root: root, identity: id, vcs: vcs}
	}
	return s.repository(s.repos[id]), nil
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
	return Repository{identity(r.identity, s.mode), r.vcs, r.root, at, status}
}
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
	r.sequence++
	sequence := r.sequence
	s.mu.Unlock()
	scanCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	v, e := scan(scanCtx, copyReg, limit, mode)
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch != s.epoch {
		return Snapshot{}, errors.New("privacy changed; retry scan")
	}
	if sequence != r.sequence {
		if r.snapshot != nil {
			return clone(*r.snapshot), nil
		}
		return Snapshot{}, errors.New("scan superseded; retry")
	}
	if e != nil {
		r.failed = true
		if r.snapshot != nil {
			v = clone(*r.snapshot)
			v.Stale = true
			v.Repository.Status = "stale"
			v.Warnings = append(v.Warnings, "scan failed; last successful snapshot retained")
			r.snapshot = &v
			return clone(v), nil
		}
		return Snapshot{}, e
	}
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
	return clone(v), nil
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
	c := exec.CommandContext(cctx, bin, args...)
	c.Dir = root
	c.Env = append(append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C"), env...)
	var out, stderr boundedBuffer
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
	repo := []string{r.identity, digest(r.identity)}
	if workspaceID == "" {
		return repo, nil, nil
	}
	if r.snapshot != nil {
		for _, w := range r.snapshot.Workspaces {
			if w.ID == workspaceID {
				return repo, []string{w.rawIdentity, digest(w.rawIdentity)}, nil
			}
		}
	}
	return nil, nil, ErrNotFound
}

type commandError struct {
	bin   string
	cause error
}

func (e *commandError) Error() string {
	return fmt.Sprintf("%s read failed (CLI unavailable, inaccessible repository, or output limit)", e.bin)
}
func (e *commandError) Unwrap() error { return e.cause }
