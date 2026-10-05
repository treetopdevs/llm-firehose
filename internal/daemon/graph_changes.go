package daemon

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agentfirehose/internal/workspace"
)

// Metadata polling supplies portable filesystem change signals without adding a
// watcher dependency. Changes must settle for one tick before scanning; the
// slower full reconciliation also catches checkout-content-only changes.
func (s *Server) runGraphChanges(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	type observed struct {
		signature string
		pending   bool
	}
	state := map[string]observed{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, repo := range s.graph.service.Repositories() {
				root, _, err := s.graph.service.Root(repo.ID)
				if err != nil {
					continue
				}
				signature := graphMetadataFingerprint(root)
				previous, exists := state[repo.ID]
				if !exists {
					state[repo.ID] = observed{signature, false}
					continue
				}
				if signature != previous.signature {
					state[repo.ID] = observed{signature, true}
					continue
				}
				if previous.pending {
					state[repo.ID] = observed{signature, false}
					scanCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
					_, _ = s.graph.service.Snapshot(scanCtx, repo.ID, "", true)
					cancel()
				}
			}
		}
	}
}

func graphMetadataFingerprint(root string) string {
	h := sha256.New()
	add := func(path string) {
		info, err := os.Stat(path)
		if err != nil {
			fmt.Fprintf(h, "%s:unavailable\n", path)
			return
		}
		fmt.Fprintf(h, "%s:%d:%d\n", path, info.Size(), info.ModTime().UnixNano())
	}
	add(root)
	common, _ := workspace.Observe(root)
	if common != "" {
		for _, file := range []string{"HEAD", "index", "packed-refs", "shallow"} {
			add(filepath.Join(common, file))
		}
		// Never traverse objects or checkout contents. Bound metadata work; the
		// periodic full scan remains authoritative even if this hint hits its cap.
		for _, dir := range []string{"refs", "worktrees"} {
			count := 0
			_ = filepath.WalkDir(filepath.Join(common, dir), func(path string, entry fs.DirEntry, err error) error {
				if count >= 10000 {
					return fs.SkipAll
				}
				count++
				if err != nil {
					add(path)
					return nil
				}
				if entry.IsDir() || entry.Name() == "HEAD" || entry.Name() == "index" || dir == "refs" {
					add(path)
				}
				return nil
			})
		}
	}
	if repo, _ := workspace.ObserveJJ(root); repo != "" {
		for _, dir := range []string{"op_heads", "op_store", "view"} {
			add(filepath.Join(strings.TrimPrefix(repo, "jj:"), dir))
		}
		add(filepath.Join(root, ".jj", "working_copy"))
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}
