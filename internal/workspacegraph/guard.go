package workspacegraph

import (
	"context"
	"errors"
	"strings"
)

var errUnsafeConfig = errors.New("repository config defines commands the daemon will not run; refusing to scan")

// guardGitConfig refuses repositories whose local (or per-worktree) config
// holds any key outside a known-inert allowlist. Config can make read-only git
// commands execute programs (clean filters run during `git status`; fsmonitor,
// pagers, diff/merge drivers and more are the same class), and a denylist of
// those can never be complete, so unknown keys fail closed. Roots are
// discovered from agent activity, so the repository may be attacker-shaped.
// User/system config is trusted.
//
// The check runs at registration, at the start of every scan and immediately
// before each `git status`; a repo that rewrites its own config in the window
// between the check and the command is not defended against.
func guardGitConfig(ctx context.Context, root string) error {
	out, err := run(ctx, root, "git", "config", "--list", "--show-scope", "-z")
	if err != nil {
		return err
	}
	// -z output alternates "scope" and "key\nvalue" fields, NUL-separated.
	fields := strings.Split(out, "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		if scope := fields[i]; scope != "local" && scope != "worktree" {
			continue
		}
		key, _, _ := strings.Cut(fields[i+1], "\n")
		if !inertGitKey(strings.ToLower(key)) {
			return errUnsafeConfig
		}
	}
	return nil
}

// inertGitKey reports whether a lowercased config key is known not to cause
// command execution in the read-only commands the scanner runs.
func inertGitKey(key string) bool {
	parts := strings.Split(key, ".")
	section, variable := parts[0], parts[len(parts)-1]
	switch section {
	case "core":
		switch variable {
		case "repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase",
			"precomposeunicode", "symlinks", "autocrlf", "safecrlf", "eol", "worktree",
			"untrackedcache", "sparsecheckout", "sparsecheckoutcone", "commitgraph",
			"longpaths", "protectntfs", "hidedotfiles", "trustctime", "quotepath",
			"abbrev", "compression", "loosecompression", "bigfilethreshold", "preloadindex":
			return len(parts) == 2
		}
	case "user", "init", "gc", "pack", "pull", "push", "fetch", "receive", "extensions", "advice", "color":
		return true
	case "remote":
		switch variable {
		case "url", "pushurl", "fetch", "push", "tagopt", "prune":
			return len(parts) == 3
		}
	case "branch":
		return len(parts) == 3
	case "submodule":
		switch variable {
		case "url", "active", "branch":
			return len(parts) == 3
		}
	}
	return false
}
