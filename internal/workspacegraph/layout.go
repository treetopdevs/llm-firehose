package workspacegraph

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agentfirehose/internal/workspace"
)

// gitLayout is where a Git repository lives, found by reading files only.
type gitLayout struct {
	common string // canonical git common dir: the repository identity
	main   string // canonical main checkout, "" when bare or unknown
	anchor string // what the repository is named after: main, else common
}

// locateGit resolves any checkout (or the git dir itself) of a repository to
// its layout without running Git, so a repository is the same whichever of its
// worktrees led to it and stays reachable after that worktree is removed.
func locateGit(root string) (gitLayout, error) {
	common, top := workspace.Observe(root)
	if common == "" {
		if !isGitDir(root) {
			return gitLayout{}, errors.New("not a Git repository")
		}
		common, top = root, ""
		if data, e := os.ReadFile(filepath.Join(root, "commondir")); e == nil {
			if value := strings.TrimSpace(string(data)); value != "" {
				if !filepath.IsAbs(value) {
					value = filepath.Join(root, value)
				}
				if c, e := canonical(value); e == nil && isGitDir(c) {
					common = c
				}
			}
		}
	}
	if !isGitDir(common) {
		return gitLayout{}, errors.New("not a Git repository")
	}
	l := gitLayout{common: common}
	if filepath.Base(common) == ".git" {
		parent := filepath.Dir(common)
		if c, t := workspace.Observe(parent); c == common && t == parent {
			l.main = parent
		}
	}
	// A checkout whose own git dir is the common dir is the main one wherever
	// that dir lives (a submodule, a separate git dir).
	if l.main == "" && top != "" {
		if own, e := worktreeGitDir(top); e == nil && own == common {
			l.main = top
		}
	}
	// With no main checkout (a bare repository) the repository is named after
	// its git dir, never after whichever linked worktree happened to lead here.
	l.anchor = common
	if l.main != "" {
		l.anchor = l.main
	}
	return l, nil
}

// nearestVCS picks the VCS whose checkout most closely contains root: a Git
// worktree nested inside a JJ workspace's directory is a Git checkout, while a
// colocated root (both at the same level) is JJ.
func nearestVCS(root string) string {
	_, jjRoot := workspace.ObserveJJ(root)
	_, gitRoot := workspace.Observe(root)
	if jjRoot != "" && len(strings.TrimPrefix(jjRoot, "jj:")) >= len(gitRoot) {
		return "jj"
	}
	return "git"
}

// Identify resolves a directory to the repository it belongs to by reading
// files only: its raw identity, the checkout the repository is named after and
// the VCS. vcs may name one ("git", "jj") or be empty for the nearest. ok is
// false when the directory is not inside a repository of that VCS.
func Identify(root, vcs string) (id, anchor, resolved string, ok bool) {
	root, e := canonical(root)
	if e != nil {
		return "", "", "", false
	}
	if vcs == "" || vcs == "auto" {
		vcs = nearestVCS(root)
	}
	switch vcs {
	case "jj":
		if l, e := locateJJ(root); e == nil {
			return "jj:" + l.repo, l.anchor, "jj", true
		}
	case "git":
		if l, e := locateGit(root); e == nil {
			return l.common, l.anchor, "git", true
		}
	}
	return "", "", "", false
}

func isGitDir(dir string) bool {
	if info, e := os.Stat(filepath.Join(dir, "HEAD")); e != nil || info.IsDir() {
		return false
	}
	info, e := os.Stat(filepath.Join(dir, "objects"))
	return e == nil && info.IsDir()
}

// worktreeGitDir resolves a checkout's own git dir (the common dir for the main
// checkout, <common>/worktrees/<id> for a linked one) from its .git entry.
func worktreeGitDir(root string) (string, error) {
	dotGit := filepath.Join(root, ".git")
	info, e := os.Stat(dotGit)
	if e != nil {
		return "", e
	}
	if info.IsDir() {
		return canonical(dotGit)
	}
	data, e := os.ReadFile(dotGit)
	if e != nil {
		return "", e
	}
	value := strings.TrimSpace(string(data))
	if !strings.HasPrefix(value, "gitdir:") {
		return "", errors.New("unexpected .git file")
	}
	dir := strings.TrimSpace(strings.TrimPrefix(value, "gitdir:"))
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	return canonical(dir)
}

// jjLayout is where a JJ repository lives, found by reading files only.
type jjLayout struct {
	repo   string // canonical shared repo dir (<main>/.jj/repo)
	anchor string // main workspace root, else the workspace that led here
	git    string // canonical backing Git dir outside the store (colocated), else ""
}

func locateJJ(root string) (jjLayout, error) {
	repoID, workspaceID := workspace.ObserveJJ(root)
	if repoID == "" {
		return jjLayout{}, errors.New("not a JJ repository")
	}
	l := jjLayout{repo: strings.TrimPrefix(repoID, "jj:"), anchor: strings.TrimPrefix(workspaceID, "jj:")}
	if dotJJ := filepath.Dir(l.repo); filepath.Base(dotJJ) == ".jj" {
		if info, e := os.Stat(filepath.Dir(dotJJ)); e == nil && info.IsDir() {
			l.anchor = filepath.Dir(dotJJ)
		}
	}
	store := filepath.Join(l.repo, "store")
	info, e := os.Stat(filepath.Join(store, "git_target"))
	if e != nil || !info.Mode().IsRegular() || info.Size() > 32768 {
		return l, nil
	}
	data, e := os.ReadFile(filepath.Join(store, "git_target"))
	if e != nil {
		return l, nil
	}
	target := strings.TrimSpace(string(data))
	if target == "" {
		return l, nil
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(store, target)
	}
	target, e = canonical(target)
	if e != nil || !isGitDir(target) {
		return l, nil
	}
	// A store-internal Git dir is JJ's own backend, not a second view of the project.
	if rel, e := filepath.Rel(l.repo, target); e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return l, nil
	}
	if g, e := locateGit(target); e == nil {
		l.git = g.common
	}
	return l, nil
}

// gitSession runs every Git command of one scan or comparison. Normally it
// points Git at a private git dir that shares the repository's objects, refs
// and worktree records but whose config we wrote from validated tokens, so the
// repository's own config is never loaded: it can neither run a program nor
// stop a scan. When that dir cannot be built (no symlinks, or a ref backend the
// shadow does not mirror) the session reads the live repository instead, and
// only after guardGitConfig has accepted its config.
type gitSession struct {
	layout gitLayout
	// main is the main checkout ("" for a bare repository): the layout's, or the
	// configured core.worktree of a submodule or separate git dir.
	main    string
	dir     string
	env     []string
	shadow  string // "" for a guarded live session
	config  string // sanitized config text, reused for per-checkout shadows
	cleanup func()
}

func (g *gitSession) run(ctx context.Context, args ...string) (string, error) {
	return runInput(ctx, g.dir, "git", g.env, "", args...)
}

func (g *gitSession) runInput(ctx context.Context, stdin string, args ...string) (string, error) {
	return runInput(ctx, g.dir, "git", g.env, stdin, args...)
}

func openGitSession(ctx context.Context, l gitLayout) (*gitSession, error) {
	g := &gitSession{layout: l, main: l.main, dir: l.common, cleanup: func() {}}
	cfg, err := run(ctx, l.common, "git", "config", "--list", "--show-scope", "-z")
	if err != nil {
		return nil, err
	}
	if g.main == "" {
		g.main = configuredWorktree(cfg, l.common)
	}
	live := func() (*gitSession, error) {
		if e := guardGitConfig(ctx, l.common); e != nil {
			return nil, e
		}
		return g, nil
	}
	conf, ok := shadowConfig(cfg)
	if !ok {
		return live()
	}
	dir, err := os.MkdirTemp("", "firehose-shadow-*")
	if err != nil {
		return live()
	}
	if e := populateShadow(dir, l.common, l.common, conf, true); e != nil {
		os.RemoveAll(dir)
		return live()
	}
	g.shadow, g.config = dir, conf
	g.env = []string{"GIT_DIR=" + dir}
	g.cleanup = func() { os.RemoveAll(dir) }
	return g, nil
}

// populateShadow fills dir as a git dir for gitDir (a checkout's own git dir)
// over the shared common dir. worktrees is linked only for the repository-wide
// shadow, where `git worktree list` reads it.
func populateShadow(dir, gitDir, common, conf string, worktrees bool) error {
	// git refuses a symlinked HEAD, so it is copied (it is only a ref or hash).
	head, e := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if e != nil {
		return e
	}
	if e := os.WriteFile(filepath.Join(dir, "HEAD"), head, 0o600); e != nil {
		return e
	}
	names := []string{"objects", "refs", "packed-refs", "shallow"}
	if worktrees {
		names = append(names, "worktrees")
	}
	for _, name := range names {
		if e := os.Symlink(filepath.Join(common, name), filepath.Join(dir, name)); e != nil {
			return e
		}
	}
	if e := os.Mkdir(filepath.Join(dir, "info"), 0o700); e != nil {
		return e
	}
	if e := os.Symlink(filepath.Join(common, "info", "exclude"), filepath.Join(dir, "info", "exclude")); e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(dir, "config"), []byte(conf), 0o600)
}

// shadowConfig writes the shadow config from validated tokens (booleans, enums,
// digits) of the repository's local scope, never copied text, so nothing needs
// quoting. ok is false when the repository stores refs in a backend the shadow
// does not mirror; the caller must then read the live repository.
func shadowConfig(listing string) (conf string, ok bool) {
	var core, ext strings.Builder
	core.WriteString("[core]\n\tbare = false\n")
	fields := strings.Split(listing, "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		if fields[i] != "local" {
			continue
		}
		key, val, _ := strings.Cut(fields[i+1], "\n")
		k := strings.ToLower(key)
		if k == "extensions.refstorage" && strings.ToLower(val) != "files" {
			return "", false
		}
		if !shadowConfigValue(k, val) {
			continue
		}
		section, name, _ := strings.Cut(k, ".")
		line := "\t" + name + " = " + strings.ToLower(val) + "\n"
		switch section {
		case "core":
			core.WriteString(line)
		case "extensions":
			ext.WriteString(line)
		}
	}
	if ext.Len() > 0 {
		core.WriteString("[extensions]\n" + ext.String())
	}
	return core.String(), true
}

// configuredWorktree returns core.worktree of the local scope resolved against
// the common dir: the main checkout of a submodule or a separate git dir.
func configuredWorktree(listing, common string) string {
	fields := strings.Split(listing, "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		if fields[i] != "local" {
			continue
		}
		key, val, _ := strings.Cut(fields[i+1], "\n")
		if strings.ToLower(key) != "core.worktree" || val == "" {
			continue
		}
		if !filepath.IsAbs(val) {
			val = filepath.Join(common, val)
		}
		if c, e := canonical(val); e == nil {
			return c
		}
	}
	return ""
}

// staleShadowAge is far beyond any scan (bounded at 20 seconds), so a shadow
// dir this old belongs to a process that exited without cleaning up.
const staleShadowAge = 10 * time.Minute

// SweepStaleShadows removes shadow git dirs left in the temp directory by a
// daemon that was killed mid-scan. They hold only symlinks and a few small
// files; a live scan's dir is never old enough to match.
func SweepStaleShadows() {
	entries, e := os.ReadDir(os.TempDir())
	if e != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "firehose-shadow-") {
			continue
		}
		if info, e := entry.Info(); e == nil && time.Since(info.ModTime()) > staleShadowAge {
			os.RemoveAll(filepath.Join(os.TempDir(), entry.Name()))
		}
	}
}
