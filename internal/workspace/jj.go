package workspace

import (
	"os"
	"path/filepath"
	"strings"
)

// ObserveJJ reads only local metadata. It neither snapshots the working copy nor
// runs JJ. Linked workspaces point their .jj/repo file at the shared repository.
// The namespace deliberately cannot be confused with the frozen Git identity.
func ObserveJJ(cwd string) (repoID, workspaceID string) {
	if cwd == "" {
		return "", ""
	}
	current, err := filepath.Abs(cwd)
	if err != nil {
		return "", ""
	}
	current = canonical(current)
	if info, err := os.Stat(current); err != nil || !info.IsDir() {
		return "", ""
	}
	for {
		repo := filepath.Join(current, ".jj", "repo")
		if info, err := os.Stat(repo); err == nil {
			if !info.IsDir() {
				// Bound metadata reads so malformed local pointers cannot burden capture.
				if !info.Mode().IsRegular() || info.Size() > 32768 {
					return "", ""
				}
				data, err := os.ReadFile(repo)
				if err != nil || strings.TrimSpace(string(data)) == "" {
					return "", ""
				}
				repo = strings.TrimSpace(string(data))
				if !filepath.IsAbs(repo) {
					repo = filepath.Join(current, ".jj", repo)
				}
			}
			repo = canonical(repo)
			if info, err := os.Stat(repo); err != nil || !info.IsDir() {
				return "", ""
			}
			return "jj:" + repo, "jj:" + current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", ""
		}
		current = parent
	}
}
