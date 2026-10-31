package daemon

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// graphGitAt runs git in dir with a fully isolated environment: no user or
// system config, no prompts, a temp HOME, and fixed author/committer dates, so
// the resulting commit ids and times are reproducible and the developer's own
// git configuration can never leak in.
func graphGitAt(t *testing.T, dir, date string, args ...string) string {
	t.Helper()
	full := append([]string{"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main"}, args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = dir
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=F", "GIT_AUTHOR_EMAIL=f@example.invalid",
		"GIT_COMMITTER_NAME=F", "GIT_COMMITTER_EMAIL=f@example.invalid",
	}
	if date != "" {
		cmd.Env = append(cmd.Env, "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// worktreeGitFixture is a real repository with a primary checkout on main and
// four linked worktrees. Nothing here is committed test data.
type worktreeGitFixture struct {
	t      *testing.T
	Main   string            // primary checkout (canonical path)
	Common string            // git common dir, the raw repo identity
	Wt     map[string]string // linked worktree name -> canonical path
}

func newWorktreeGitFixture(t *testing.T) *worktreeGitFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("HOME", t.TempDir())
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &worktreeGitFixture{t: t, Main: filepath.Join(base, "repo"), Wt: map[string]string{}}
	f.Common = filepath.Join(f.Main, ".git")
	if err := os.MkdirAll(f.Main, 0o700); err != nil {
		t.Fatal(err)
	}
	graphGitAt(t, f.Main, "", "init", "-q", "-b", "main")
	f.commit(f.Main, "base.txt", "2026-10-31T09:00:00Z")
	for _, name := range []string{"feat-landed", "feat-open", "feat-abandoned", "feat-idle"} {
		path := filepath.Join(base, "wt", name)
		graphGitAt(t, f.Main, "2026-10-31T09:01:00Z", "worktree", "add", "-q", "-b", name, path)
		f.Wt[name] = path
	}
	f.commit(f.Wt["feat-landed"], "landed.txt", "2026-10-31T10:05:00Z")
	f.commit(f.Wt["feat-open"], "open1.txt", "2026-10-31T11:10:00Z")
	f.commit(f.Wt["feat-open"], "open2.txt", "2026-10-31T11:40:00Z")
	if err := os.WriteFile(filepath.Join(f.Wt["feat-open"], "untracked.txt"), []byte("wip\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.commit(f.Wt["feat-abandoned"], "abandoned.txt", "2026-10-31T12:20:00Z")
	return f
}

// commit writes file in dir and commits it at date.
func (f *worktreeGitFixture) commit(dir, file, date string) {
	f.t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(file+"\n"), 0o600); err != nil {
		f.t.Fatal(err)
	}
	graphGitAt(f.t, dir, date, "add", file)
	graphGitAt(f.t, dir, date, "commit", "-q", "-m", "add "+file)
}

func (f *worktreeGitFixture) git(dir, date string, args ...string) string {
	f.t.Helper()
	return graphGitAt(f.t, dir, date, args...)
}
