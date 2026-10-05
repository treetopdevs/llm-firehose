package workspacegraph

import (
	"context"
	"errors"
	"strings"
)

var errUnsafeConfig = errors.New("repository config defines commands the daemon will not run; refusing to scan")

// guardGitConfig refuses repositories whose local (or per-worktree) config
// can make read-only git commands execute programs: clean filters run during
// `git status`, and fsmonitor, pagers, diff/merge drivers and similar keys
// are the same class. Roots are discovered from agent activity, so the
// repository may be attacker-shaped. User/system config is trusted.
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
		if executableGitKey(strings.ToLower(key)) {
			return errUnsafeConfig
		}
	}
	return nil
}

func executableGitKey(key string) bool {
	switch key {
	case "core.fsmonitor", "core.hookspath", "core.sshcommand", "core.pager", "core.editor",
		"core.askpass", "core.gitproxy", "core.alternaterefscommand", "diff.external",
		"uploadpack.packobjectshook", "include.path", "gpg.program":
		return true
	}
	parts := strings.Split(key, ".")
	if len(parts) < 3 {
		return false
	}
	section, variable := parts[0], parts[len(parts)-1]
	switch section {
	case "filter":
		return variable == "clean" || variable == "smudge" || variable == "process"
	case "diff":
		return variable == "textconv" || variable == "command"
	case "merge":
		return variable == "driver"
	case "gpg":
		return variable == "program"
	case "includeif":
		return variable == "path"
	case "credential":
		return variable == "helper"
	}
	return false
}
