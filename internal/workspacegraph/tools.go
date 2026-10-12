package workspacegraph

import (
	"os"
	"os/exec"
	"path/filepath"
)

// toolDirs lists where git and jj are normally installed. A daemon started by
// launchd (brew services) or by Finder (the desktop app) gets only
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no Homebrew or cargo tools.
var toolDirs = func() []string {
	dirs := []string{"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs,
			filepath.Join(home, ".cargo", "bin"),
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".nix-profile", "bin"))
	}
	return dirs
}

// resolveTool finds a VCS executable on PATH, then in toolDirs. It returns the
// bare name when neither has it, so the command fails as "CLI unavailable".
func resolveTool(bin string) string {
	if p, err := exec.LookPath(bin); err == nil {
		return p
	}
	for _, dir := range toolDirs() {
		p := filepath.Join(dir, bin)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	return bin
}
