package workspacegraph

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func fakeTool(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// launchd (brew services) and Finder (the desktop app) start the daemon with
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no jj; the scanner must still
// find VCS tools where they are normally installed.
func TestResolveToolFallsBackToInstallDirsWhenNotOnPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable bits")
	}
	install := t.TempDir()
	want := fakeTool(t, install, "fh-fake-vcs")
	t.Setenv("PATH", t.TempDir())
	restore := toolDirs
	toolDirs = func() []string { return []string{filepath.Join(t.TempDir(), "missing"), install} }
	t.Cleanup(func() { toolDirs = restore })
	if got := resolveTool("fh-fake-vcs"); got != want {
		t.Fatalf("resolveTool = %q, want %q", got, want)
	}
}

func TestResolveToolPrefersPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable bits")
	}
	onPath, install := t.TempDir(), t.TempDir()
	want := fakeTool(t, onPath, "fh-fake-vcs")
	fakeTool(t, install, "fh-fake-vcs")
	t.Setenv("PATH", onPath)
	restore := toolDirs
	toolDirs = func() []string { return []string{install} }
	t.Cleanup(func() { toolDirs = restore })
	if got := resolveTool("fh-fake-vcs"); got != want {
		t.Fatalf("resolveTool = %q, want %q", got, want)
	}
}

func TestResolveToolSkipsNonExecutablesAndLeavesUnknownToolsAlone(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable bits")
	}
	install := t.TempDir()
	os.WriteFile(filepath.Join(install, "fh-fake-vcs"), []byte("x"), 0o644)
	t.Setenv("PATH", t.TempDir())
	restore := toolDirs
	toolDirs = func() []string { return []string{install} }
	t.Cleanup(func() { toolDirs = restore })
	if got := resolveTool("fh-fake-vcs"); got != "fh-fake-vcs" {
		t.Fatalf("resolveTool = %q, want the bare name", got)
	}
}
