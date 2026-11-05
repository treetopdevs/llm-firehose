// Package workspace observes local repository and worktree identity without
// invoking Git or making network calls.
package workspace

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"agentfirehose/internal/event"
)

// Enrich replaces unverified identity when cwd makes the local Git identity
// observable, otherwise preserving any historical identity already present.
func Enrich(ev event.Event) event.Event {
	ev, _ = EnrichWithRoot(ev)
	return ev
}

// EnrichWithRoot also returns the root actually observed from CWD. Historical
// caller-supplied identity may be preserved on ev, but is never a discovery hint.
func EnrichWithRoot(ev event.Event) (event.Event, string) {
	observedRoot := ""
	// Only a local observation may set the alias, so a caller cannot use the
	// field to persist text.
	ev.RootAlias = ""
	repoID, worktreeID := Observe(ev.CWD)
	if repoID != "" && worktreeID != "" {
		ev.RepoID = repoID
		ev.WorktreeID = worktreeID
		observedRoot = worktreeID
	}
	if repoID, workspaceID := ObserveJJ(ev.CWD); repoID != "" && workspaceID != "" {
		ev.JJRepoID = repoID
		ev.JJWorkspaceID = workspaceID
		observedRoot = strings.TrimPrefix(workspaceID, "jj:")
	}
	// Activity maps the alias onto the Git worktree when there is one.
	aliasRoot := observedRoot
	if worktreeID != "" && repoID != "" {
		aliasRoot = worktreeID
	}
	ev.RootAlias = rootAlias(ev.CWD, aliasRoot)
	return ev, observedRoot
}

// Observe returns canonical local paths identifying the Git common directory
// and containing worktree. Empty results mean the identity was not observable.
func Observe(cwd string) (repoID, worktreeID string) {
	if cwd == "" {
		return "", ""
	}
	current, err := filepath.Abs(cwd)
	if err != nil {
		return "", ""
	}
	if resolved, resolveErr := filepath.EvalSymlinks(current); resolveErr == nil {
		current = resolved
	}
	if info, statErr := os.Stat(current); statErr != nil || !info.IsDir() {
		return "", ""
	}

	for {
		dotGit := filepath.Join(current, ".git")
		if info, statErr := os.Stat(dotGit); statErr == nil {
			gitDir := dotGit
			if !info.IsDir() {
				data, readErr := os.ReadFile(dotGit)
				if readErr != nil {
					return "", ""
				}
				value := strings.TrimSpace(string(data))
				if !strings.HasPrefix(value, "gitdir:") {
					return "", ""
				}
				gitDir = strings.TrimSpace(strings.TrimPrefix(value, "gitdir:"))
				if !filepath.IsAbs(gitDir) {
					gitDir = filepath.Join(current, gitDir)
				}
			}
			gitDir = canonical(gitDir)
			if info, statErr := os.Stat(gitDir); statErr != nil || !info.IsDir() {
				return "", ""
			}
			commonDir := gitDir
			if data, readErr := os.ReadFile(filepath.Join(gitDir, "commondir")); readErr == nil {
				value := strings.TrimSpace(string(data))
				if value != "" {
					if filepath.IsAbs(value) {
						commonDir = value
					} else {
						commonDir = filepath.Join(gitDir, value)
					}
				}
			}
			commonDir = canonical(commonDir)
			if info, statErr := os.Stat(commonDir); statErr != nil || !info.IsDir() {
				return "", ""
			}
			return commonDir, canonical(current)
		}

		parent := filepath.Dir(current)
		if parent == current {
			return "", ""
		}
		current = parent
	}
}

func canonical(path string) string {
	path = filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Clean(resolved)
	}
	return path
}

// rootAlias returns root as spelled through cwd, or "" when that spelling is
// the canonical root or cannot be derived. A symlink below the root leaves no
// spelling of the root in cwd, and matching text alone can name another
// directory, so the candidate must itself resolve to root.
func rootAlias(cwd, root string) string {
	if root == "" {
		return ""
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return ""
	}
	rel, err := filepath.Rel(root, canonical(abs))
	if err != nil {
		return ""
	}
	fold := runtime.GOOS == "windows"
	alias := abs
	if rel != "." {
		var ok bool
		if alias, ok = trimPathSuffix(abs, string(filepath.Separator)+rel, fold); !ok {
			return ""
		}
	}
	if samePath(alias, root, fold) || !samePath(canonical(alias), root, fold) {
		return ""
	}
	return alias
}

// trimPathSuffix removes suffix from path. Fold matches Windows, where
// EvalSymlinks normalises letter case.
func trimPathSuffix(path, suffix string, fold bool) (string, bool) {
	if len(suffix) > len(path) {
		return "", false
	}
	cut := len(path) - len(suffix)
	if !samePath(path[cut:], suffix, fold) {
		return "", false
	}
	return path[:cut], true
}

func samePath(a, b string, fold bool) bool {
	if fold {
		return strings.EqualFold(a, b)
	}
	return a == b
}
