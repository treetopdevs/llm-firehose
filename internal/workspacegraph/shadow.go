package workspacegraph

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// gitStatus runs `git status` for a worktree without ever reading the repo's
// live config. Status is the one read-only command that can run
// config-defined programs (clean filters), and checking config before running
// it leaves a window in which the repo can rewrite itself. Instead status runs
// against a private git dir that shares objects, refs, HEAD, the index and
// info/exclude with the real one but has a config we wrote from inert keys,
// so no filter driver exists to run. Submodules are ignored because their
// status would run in a child repo with its own config.
func gitStatus(ctx context.Context, root string) (string, error) {
	_, env, cleanup, err := newShadowGitDir(ctx, root)
	if err != nil {
		// No symlinks (e.g. Windows) or an unusual layout: fall back to the
		// checked live repo, which keeps only the narrow check-then-run window.
		if e := guardGitConfig(ctx, root); e != nil {
			return "", e
		}
		return run(ctx, root, "git", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all")
	}
	defer cleanup()
	return runEnv(ctx, root, "git", env, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all")
}

func newShadowGitDir(ctx context.Context, root string) (string, []string, func(), error) {
	out, err := run(ctx, root, "git", "rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir")
	if err != nil {
		return "", nil, nil, err
	}
	paths := strings.Split(strings.TrimSpace(out), "\n")
	if len(paths) != 2 {
		return "", nil, nil, errors.New("unexpected rev-parse output")
	}
	gitDir, common := filepath.Clean(paths[0]), filepath.Clean(paths[1])
	cfg, err := run(ctx, root, "git", "config", "--list", "--show-scope", "-z")
	if err != nil {
		return "", nil, nil, err
	}
	dir, err := os.MkdirTemp("", "firehose-shadow-*")
	if err != nil {
		return "", nil, nil, err
	}
	cleanup := func() { os.RemoveAll(dir) }
	fail := func(e error) (string, []string, func(), error) { cleanup(); return "", nil, nil, e }

	// git refuses a symlinked HEAD, so it is copied (it is only a ref or hash).
	head, e := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if e != nil {
		return fail(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "HEAD"), head, 0o600); e != nil {
		return fail(e)
	}
	for _, l := range []struct{ name, target string }{
		{"objects", filepath.Join(common, "objects")},
		{"refs", filepath.Join(common, "refs")},
		{"packed-refs", filepath.Join(common, "packed-refs")},
	} {
		if e := os.Symlink(l.target, filepath.Join(dir, l.name)); e != nil {
			return fail(e)
		}
	}
	if e := os.Mkdir(filepath.Join(dir, "info"), 0o700); e != nil {
		return fail(e)
	}
	if e := os.Symlink(filepath.Join(common, "info", "exclude"), filepath.Join(dir, "info", "exclude")); e != nil {
		return fail(e)
	}

	// The shadow config is written here from validated tokens (booleans,
	// enums, digits), never copied from the repo, so nothing needs quoting.
	var conf strings.Builder
	conf.WriteString("[core]\n\tbare = false\n")
	var ext strings.Builder
	fields := strings.Split(cfg, "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		if fields[i] != "local" {
			continue
		}
		key, val, _ := strings.Cut(fields[i+1], "\n")
		k := strings.ToLower(key)
		if !shadowConfigValue(k, val) {
			continue
		}
		section, name, _ := strings.Cut(k, ".")
		line := "\t" + name + " = " + strings.ToLower(val) + "\n"
		switch section {
		case "core":
			conf.WriteString(line)
		case "extensions":
			ext.WriteString(line)
		}
	}
	if ext.Len() > 0 {
		conf.WriteString("[extensions]\n" + ext.String())
	}
	if e := os.WriteFile(filepath.Join(dir, "config"), []byte(conf.String()), 0o600); e != nil {
		return fail(e)
	}
	env := []string{"GIT_DIR=" + dir, "GIT_WORK_TREE=" + root, "GIT_INDEX_FILE=" + filepath.Join(gitDir, "index")}
	return dir, env, cleanup, nil
}

// shadowConfigValue reports whether a local config entry may be copied into
// the shadow config. Both the key and its value must be known: status needs
// only a few settings, each with a closed set of meanings, so anything
// outside that (an unknown extension, an odd value) is simply not copied and
// the shadow config falls back to git's defaults. core.worktree and
// core.bare are never copied; they are set explicitly.
func shadowConfigValue(key, val string) bool {
	val = strings.ToLower(val)
	isBool := val == "true" || val == "false" || val == "yes" || val == "no" || val == "on" || val == "off" || val == "1" || val == "0"
	switch key {
	case "core.repositoryformatversion":
		return val == "0" || val == "1"
	case "core.filemode", "core.ignorecase", "core.precomposeunicode", "core.symlinks",
		"core.longpaths", "core.protectntfs", "core.hidedotfiles", "core.trustctime",
		"core.quotepath", "core.preloadindex", "extensions.worktreeconfig":
		return isBool
	case "core.untrackedcache":
		return isBool || val == "keep"
	case "core.autocrlf":
		return isBool || val == "input"
	case "core.safecrlf":
		return isBool || val == "warn"
	case "core.eol":
		return val == "lf" || val == "crlf" || val == "native"
	case "extensions.objectformat":
		return val == "sha1" || val == "sha256"
	}
	return false
}
