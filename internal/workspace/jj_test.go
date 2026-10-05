package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"agentfirehose/internal/event"
)

func TestJJIdentityAcrossRealWorkspaces(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is not installed")
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("jj", args...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("jj %v: %v: %s", args, err, out)
		}
	}
	base := t.TempDir()
	root := filepath.Join(base, "primary")
	other := filepath.Join(base, "secondary")
	run("git", "init", "--no-colocate", root)
	run("-R", root, "workspace", "add", other)
	nested := filepath.Join(other, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	first := Enrich(event.Event{CWD: root})
	second := Enrich(event.Event{CWD: nested})
	if first.JJRepoID != "jj:"+canonical(filepath.Join(root, ".jj", "repo")) || second.JJRepoID != first.JJRepoID {
		t.Fatalf("shared JJ repo identity: %+v %+v", first, second)
	}
	if first.JJWorkspaceID != "jj:"+canonical(root) || second.JJWorkspaceID != "jj:"+canonical(other) {
		t.Fatalf("workspace identity: %+v %+v", first, second)
	}
	if first.RepoID != "" || second.WorktreeID != "" {
		t.Fatal("JJ-only identity must not be promoted to Git identity")
	}
	unknown := Enrich(event.Event{CWD: filepath.Join(base, "missing"), JJRepoID: "historic", JJWorkspaceID: "historic-workspace"})
	if unknown.JJRepoID != "historic" || unknown.JJWorkspaceID != "historic-workspace" {
		t.Fatal("missing checkout rewrote historic identity")
	}
}

func TestJJMalformedPointerIsUnassigned(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".jj"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", "missing-repository", string(make([]byte, 32769))} {
		if err := os.WriteFile(filepath.Join(root, ".jj", "repo"), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if repo, workspace := ObserveJJ(root); repo != "" || workspace != "" {
			t.Fatal("invalid JJ metadata established an identity")
		}
	}
}
