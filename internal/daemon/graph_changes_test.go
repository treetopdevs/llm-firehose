package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGraphMetadataDetectsLinkedHeadAndRefMovement(t *testing.T) {
	root := t.TempDir()
	common := filepath.Join(root, ".git")
	linked := filepath.Join(common, "worktrees", "other")
	if err := os.MkdirAll(linked, 0700); err != nil {
		t.Fatal(err)
	}
	head := filepath.Join(linked, "HEAD")
	if err := os.WriteFile(head, []byte("old-revision"), 0600); err != nil {
		t.Fatal(err)
	}
	before := graphMetadataFingerprint(root)
	if err := os.WriteFile(head, []byte("new-revision-with-another-size"), 0600); err != nil {
		t.Fatal(err)
	}
	after := graphMetadataFingerprint(root)
	if before == after {
		t.Fatal("linked worktree HEAD movement was not detected")
	}
	if again := graphMetadataFingerprint(root); again != after {
		t.Fatal("unchanged metadata was unstable")
	}
}
