package workspacegraph

import (
	"context"
	"strconv"
	"strings"
)

// maxFileChanges bounds Workspace.Changes and Comparison.Changes. Beyond it the
// list is cut (in the VCS's own stable path order) and ChangesTruncated is set.
const maxFileChanges = 200

// rawChange is one changed path with a normalized status letter. Paths are
// reported as the VCS printed them in every privacy mode; buildFileChanges is
// the only constructor of FileChange.
type rawChange struct{ path, status string }

type numstatEntry struct {
	add, del int
	binary   bool
}

// normalizeStatus maps a VCS status letter into the contract set M A D R C T U.
func normalizeStatus(letter byte) string {
	switch letter {
	case 'M', 'A', 'D', 'R', 'C', 'T', 'U':
		return string(letter)
	}
	return "M"
}

// parsePorcelainChanges reads `git status --porcelain=v1 -z` into changes.
// The working-tree letter wins over the index letter. Rename/copy entries are
// followed by their original path, which is skipped (the new path is the
// change). Ignored entries are not changes.
func parsePorcelainChanges(b string) []rawChange {
	var out []rawChange
	parts := strings.Split(b, "\x00")
	for i := 0; i < len(parts); i++ {
		f := parts[i]
		if len(f) < 4 {
			continue
		}
		x, y := f[0], f[1]
		if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
			i++
		}
		var status string
		switch {
		case x == '!' && y == '!':
			continue
		case x == '?' && y == '?':
			status = "?"
		case x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D'):
			status = "U"
		case y != ' ':
			status = normalizeStatus(y)
		default:
			status = normalizeStatus(x)
		}
		out = append(out, rawChange{path: f[3:], status: status})
	}
	return out
}

// parseRawChanges reads `git diff --raw -z`: ":modes shas STATUS" followed by
// one path, or two (old, new) for renames and copies.
func parseRawChanges(b string) []rawChange {
	var out []rawChange
	parts := strings.Split(b, "\x00")
	for i := 0; i < len(parts); i++ {
		f := parts[i]
		if !strings.HasPrefix(f, ":") {
			continue
		}
		fields := strings.Fields(f)
		if len(fields) < 5 || fields[4] == "" {
			continue
		}
		letter := fields[4][0]
		step := 1
		if letter == 'R' || letter == 'C' {
			step = 2
		}
		if i+step >= len(parts) {
			break
		}
		out = append(out, rawChange{path: parts[i+step], status: normalizeStatus(letter)})
		i += step
	}
	return out
}

// parseNumstat reads `git diff --numstat -z`, keyed by the (new) path. Binary
// files report "-\t-". Renames are "added\tdeleted\t" NUL old NUL new.
func parseNumstat(b string) map[string]numstatEntry {
	out := map[string]numstatEntry{}
	parts := strings.Split(b, "\x00")
	for i := 0; i < len(parts); i++ {
		fields := strings.SplitN(parts[i], "\t", 3)
		if len(fields) != 3 {
			continue
		}
		path := fields[2]
		if path == "" {
			if i+2 >= len(parts) {
				break
			}
			path = parts[i+2]
			i += 2
		}
		if fields[0] == "-" && fields[1] == "-" {
			out[path] = numstatEntry{binary: true}
			continue
		}
		add, e1 := strconv.Atoi(fields[0])
		del, e2 := strconv.Atoi(fields[1])
		if e1 != nil || e2 != nil {
			continue
		}
		out[path] = numstatEntry{add: add, del: del}
	}
	return out
}

// buildFileChanges applies the cap and per-file counts. Untracked
// (?) and unmerged (U) paths never carry counts: there is no meaningful
// two-sided diff for them.
func buildFileChanges(entries []rawChange, stats map[string]numstatEntry) ([]FileChange, bool) {
	if len(entries) == 0 {
		return nil, false
	}
	truncated := len(entries) > maxFileChanges
	if truncated {
		entries = entries[:maxFileChanges]
	}
	out := make([]FileChange, 0, len(entries))
	for _, e := range entries {
		c := FileChange{Path: e.path, Status: e.status}
		if n, ok := stats[e.path]; ok && e.status != "?" && e.status != "U" {
			if n.binary {
				c.Binary = true
			} else {
				add, del := n.add, n.del
				c.Additions, c.Deletions = &add, &del
			}
		}
		out = append(out, c)
	}
	return out, truncated
}

func copyChanges(in []FileChange) []FileChange {
	if in == nil {
		return nil
	}
	out := make([]FileChange, len(in))
	for i, c := range in {
		out[i] = c
		if c.Additions != nil {
			v := *c.Additions
			out[i].Additions = &v
		}
		if c.Deletions != nil {
			v := *c.Deletions
			out[i].Deletions = &v
		}
	}
	return out
}

// gitCompareChanges reads committed per-file changes between two revisions.
// It is additive and best effort: a failure leaves the legacy changed_files
// untouched and simply omits changes. Tree-to-tree diffs never read the index
// or working tree, and the flags below never run diff drivers.
func gitCompareChanges(query func(args ...string) (string, error), selected, target string) ([]FileChange, bool) {
	base := []string{"-c", "diff.autoRefreshIndex=false", "diff", "--no-ext-diff", "--no-textconv", "-M"}
	raw, e := query(append(append([]string{}, base...), "--raw", "-z", target, selected, "--")...)
	if e != nil {
		return nil, false
	}
	var stats map[string]numstatEntry
	if num, e := query(append(append([]string{}, base...), "--numstat", "-z", target, selected, "--")...); e == nil {
		stats = parseNumstat(num)
	}
	return buildFileChanges(parseRawChanges(raw), stats)
}

// jjEntry is one `jj diff --summary` line: path is the new path, display is
// jj's own rendering (which `--stat` repeats verbatim for the same file).
type jjEntry struct{ path, display, status string }

func parseJJSummary(b string) []jjEntry {
	var out []jjEntry
	for _, line := range strings.Split(b, "\n") {
		if len(line) < 3 || line[1] != ' ' || !strings.ContainsRune("MADRC", rune(line[0])) {
			continue
		}
		display := line[2:]
		path := display
		if line[0] == 'R' || line[0] == 'C' {
			path = jjRenamedPath(display)
		}
		out = append(out, jjEntry{path: path, display: display, status: string(line[0])})
	}
	return out
}

// jjRenamedPath returns the new path from "dir/{old => new}/f" or "old => new".
func jjRenamedPath(display string) string {
	arrow := strings.Index(display, " => ")
	if arrow < 0 {
		return display
	}
	if open := strings.LastIndex(display[:arrow], "{"); open >= 0 {
		if rel := strings.Index(display[arrow:], "}"); rel >= 0 {
			closing := arrow + rel
			p := display[:open] + display[arrow+4:closing] + display[closing+1:]
			for strings.Contains(p, "//") {
				p = strings.ReplaceAll(p, "//", "/")
			}
			return strings.TrimPrefix(p, "/")
		}
	}
	return display[arrow+4:]
}

// parseJJStat reads `jj diff --stat` lines ("path | 12 ++--", "path | (binary)
// ...") keyed by jj's display path. The histogram is exact only while it fits
// the terminal width; a line whose bar does not add up to its total was scaled
// and yields no counts (counts are best effort for JJ).
func parseJJStat(b string) map[string]numstatEntry {
	out := map[string]numstatEntry{}
	for _, line := range strings.Split(b, "\n") {
		at := strings.LastIndex(line, " | ")
		if at < 0 {
			continue
		}
		path := strings.TrimRight(line[:at], " ")
		right := strings.TrimSpace(line[at+3:])
		if strings.HasPrefix(right, "(binary)") {
			out[path] = numstatEntry{binary: true}
			continue
		}
		fields := strings.Fields(right)
		if len(fields) == 0 {
			continue
		}
		total, e := strconv.Atoi(fields[0])
		if e != nil {
			continue
		}
		bar := ""
		if len(fields) > 1 {
			bar = fields[1]
		}
		add, del := strings.Count(bar, "+"), strings.Count(bar, "-")
		if add+del != total || len(bar) != add+del {
			continue
		}
		out[path] = numstatEntry{add: add, del: del}
	}
	return out
}

// jjChanges reads changes for a revision (`-r REV`) or a range (`--from A
// --to B`) through the read-only runner (--ignore-working-copy, so the working
// copy is never snapshotted). Path and status come from --summary and are
// required; counts come from --stat and are best effort. COLUMNS is raised so
// the histogram is not scaled and display paths are not truncated.
func jjChanges(ctx context.Context, root string, diffArgs []string) ([]FileChange, bool) {
	args := func(format string) []string { return append(append([]string{"diff"}, diffArgs...), format) }
	summary, e := run(ctx, root, "jj", args("--summary")...)
	if e != nil {
		return nil, false
	}
	entries := parseJJSummary(summary)
	if len(entries) == 0 {
		return nil, false
	}
	var stats map[string]numstatEntry
	if stat, e := runEnv(ctx, root, "jj", []string{"COLUMNS=20000"}, args("--stat")...); e == nil {
		stats = parseJJStat(stat)
	}
	raw := make([]rawChange, len(entries))
	keyed := map[string]numstatEntry{}
	for i, en := range entries {
		raw[i] = rawChange{path: en.path, status: en.status}
		if n, ok := stats[en.display]; ok {
			keyed[en.path] = n
		}
	}
	return buildFileChanges(raw, keyed)
}
