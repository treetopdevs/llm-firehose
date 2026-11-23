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
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	type observed struct {
		signature string
		pending   bool
		root      string
		common    string
		jjRepo    string
		resolved  bool
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
				previous, exists := state[repo.ID]
				common, jjRepo := previous.common, previous.jjRepo
				if !previous.resolved || previous.root != root || (common != "" && !pathExists(common)) {
					common, _ = workspace.Observe(root)
					jjRepo, _ = workspace.ObserveJJ(root)
				}
				signature := graphMetadataFingerprintWithRoots(root, common, jjRepo)
				if !exists {
					state[repo.ID] = observed{signature: signature, root: root, common: common, jjRepo: jjRepo, resolved: true}
					continue
				}
				if signature != previous.signature {
					state[repo.ID] = observed{signature: signature, pending: true, root: root, common: common, jjRepo: jjRepo, resolved: true}
					continue
				}
				if previous.pending {
					state[repo.ID] = observed{signature: signature, pending: false, root: root, common: common, jjRepo: jjRepo, resolved: true}
					scanCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
					_, _ = s.graph.service.Snapshot(scanCtx, repo.ID, "", true)
					cancel()
				}
			}
		}
	}
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func graphMetadataFingerprint(root string) string {
	common, _ := workspace.Observe(root)
	jjRepo, _ := workspace.ObserveJJ(root)
	return graphMetadataFingerprintWithRoots(root, common, jjRepo)
}

func graphMetadataFingerprintWithRoots(root, common, jjRepo string) string {
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
	if jjRepo != "" {
		for _, dir := range []string{"op_heads", "op_store", "view"} {
			add(filepath.Join(strings.TrimPrefix(jjRepo, "jj:"), dir))
		}
		add(filepath.Join(root, ".jj", "working_copy"))
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}
