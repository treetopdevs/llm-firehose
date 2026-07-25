// Package workspace observes local repository and worktree identity without
// invoking Git or making network calls.
package workspace

import (
	"os"
	"path/filepath"
	"strings"

	"agentfirehose/internal/event"
)

// Enrich replaces unverified identity when cwd makes the local Git identity
// observable, otherwise preserving any historical identity already present.
func Enrich(ev event.Event) event.Event {
	repoID, worktreeID := Observe(ev.CWD)
	if repoID != "" && worktreeID != "" {
		ev.RepoID = repoID
		ev.WorktreeID = worktreeID
	}
	return ev
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
			return canonical(commonDir), canonical(current)
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
