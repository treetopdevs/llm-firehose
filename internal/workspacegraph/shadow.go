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
	status, _, _, err := gitDirtyState(ctx, root, false)
	return status, err
}

// gitDirtyState returns `git status` output and, when stats is set and status
// found changes, `git diff --numstat -z HEAD` output, both from the same
// shadow git dir (see gitStatus). detail is the status with untracked
// directories expanded to their files (equal to status when none is folded);
// only the structured changes use it, the legacy changed_files keep status.
// The diff is read-only in the strict sense: diff.autoRefreshIndex=false stops `git diff` from rewriting the real index
// (it does so by default, even with GIT_OPTIONAL_LOCKS=0), and --no-ext-diff
// --no-textconv --ignore-submodules=all keep any configured driver or child
// repository out of it. Numstat is best effort: a failure returns no numstat
// (changes then carry path and status only), never an error.
func gitDirtyState(ctx context.Context, root string, stats bool) (status, detail, numstat string, err error) {
	_, env, cleanup, err := newShadowGitDir(ctx, root)
	if err != nil {
		// No symlinks (e.g. Windows) or an unusual layout: fall back to the
		// checked live repo, which keeps only the narrow check-then-run window.
		if e := guardGitConfig(ctx, root); e != nil {
			return "", "", "", e
		}
		env = nil
	} else {
		defer cleanup()
	}
	status, err = runEnv(ctx, root, "git", env, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all")
	if err != nil || !stats || status == "" {
		return status, status, "", err
	}
	// The default status folds a new directory into one `?? dir/` entry. The
	// structured changes list each file, so ask again only when a directory is
	// folded; a failure keeps the folded entries (best effort, never an error).
	detail = status
	if hasUntrackedDirectory(status) {
		if all, e := runEnv(ctx, root, "git", env, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"); e == nil {
			detail = all
		}
	}
	numstat, e := runEnv(ctx, root, "git", env, "-c", "diff.autoRefreshIndex=false", "diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD", "--")
	if e != nil {
		numstat = ""
	}
	return status, detail, numstat, nil
}

// hasUntrackedDirectory reports whether a `status -z` listing folds an
// untracked directory into a single trailing-slash entry.
func hasUntrackedDirectory(status string) bool {
	for _, f := range strings.Split(status, "\x00") {
		if strings.HasPrefix(f, "?? ") && strings.HasSuffix(f, "/") {
			return true
		}
	}
	return false
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
