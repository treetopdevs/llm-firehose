package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"context"
	"errors"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

func scan(ctx context.Context, r registration, limit int, m privacy.Mode) (Snapshot, error) {
	v := Snapshot{Repository: describeRepository(r, m, time.Now().UTC(), "ready"), Nodes: []Revision{}, Workspaces: []Workspace{}, Edges: []Edge{}, Boundaries: []Boundary{}, Warnings: []string{}}
	var e error
	var session *gitSession
	if r.vcs == "jj" {
		e = scanJJ(ctx, r, limit, m, &v)
	} else if session, e = openGitSession(ctx, r.git); e == nil {
		defer session.cleanup()
		e = scanGit(ctx, session, limit, m, &v)
	}
	if e != nil {
		return v, e
	}
	seen := map[string]bool{}
	for _, n := range v.Nodes {
		seen[n.Key] = true
	}
	var unloaded []string
	for _, n := range v.Nodes {
		for _, p := range n.Parents {
			if seen[p] {
				v.Edges = append(v.Edges, Edge{n.Key, p})
			} else {
				unloaded = append(unloaded, p)
				v.Boundaries = append(v.Boundaries, Boundary{n.Key, p, "history not loaded"})
			}
		}
	}
	if session != nil && len(unloaded) > 0 {
		missing := gitMissingCommits(ctx, session, unloaded)
		for i := range v.Boundaries {
			if missing[v.Boundaries[i].Parent] {
				v.Boundaries[i].Reason = "history unavailable locally"
			}
		}
	}
	return v, nil
}

// gitMissingCommits reports which of ids the local object store does not hold
// as commits, with one command for all of them.
func gitMissingCommits(ctx context.Context, g *gitSession, ids []string) map[string]bool {
	missing := map[string]bool{}
	var input strings.Builder
	for _, id := range ids {
		if revisionID.MatchString(id) {
			input.WriteString(id + "\n")
		} else {
			missing[id] = true
		}
	}
	out, e := g.runInput(ctx, input.String(), "cat-file", "--batch-check=%(objectname) %(objecttype)")
	if e != nil {
		return missing
	}
	for _, line := range strings.Split(out, "\n") {
		if id, kind, ok := strings.Cut(strings.TrimSpace(line), " "); ok && kind != "commit" {
			missing[id] = true
		}
	}
	return missing
}

// dirtyWorkers bounds how many checkouts are inspected at once: enough that a
// repository with dozens of worktrees scans in a few seconds, few enough that a
// scan never saturates the machine.
const dirtyWorkers = 4

func scanGit(ctx context.Context, g *gitSession, limit int, m privacy.Mode, v *Snapshot) error {
	b, e := g.run(ctx, "worktree", "list", "--porcelain", "-z")
	if e != nil {
		return e
	}
	tips := []string{}
	roots := []string{}
	first := true
	var w *Workspace
	for _, f := range strings.Split(b, "\x00") {
		switch {
		case strings.HasPrefix(f, "worktree "):
			root := strings.TrimPrefix(f, "worktree ")
			// Through the shadow git dir the main checkout is reported as the
			// shadow itself; it is the first entry, and its real path is known.
			primary := first
			if first && g.shadow != "" {
				root = g.main
			}
			first = false
			if root == "" { // a bare repository has no main checkout
				w = nil
				continue
			}
			if c, e := canonical(root); e == nil {
				root = c
			}
			roots = append(roots, root)
			v.Workspaces = append(v.Workspaces, Workspace{rawIdentity: root, ID: identity(root, m), RepoID: v.Repository.ID, Label: root, Refs: []string{}, Availability: "available", Primary: primary})
			w = &v.Workspaces[len(v.Workspaces)-1]
		case w == nil:
			continue
		case f == "bare":
			// The live listing of a bare repository names the git dir itself.
			v.Workspaces, roots, w = v.Workspaces[:len(v.Workspaces)-1], roots[:len(roots)-1], nil
		case strings.HasPrefix(f, "HEAD "):
			w.Revision = strings.TrimPrefix(f, "HEAD ")
			if strings.Trim(w.Revision, "0") == "" {
				w.Unborn = true
				w.Revision = ""
			} else {
				tips = append(tips, w.Revision)
			}
		case strings.HasPrefix(f, "branch "):
			w.Refs = append(w.Refs, strings.TrimPrefix(f, "branch "))
		case f == "detached":
			w.Refs = append(w.Refs, "detached")
		case strings.HasPrefix(f, "locked"):
			w.Availability = "locked"
		case strings.HasPrefix(f, "prunable"):
			w.Availability = "pruned"
		}
	}
	jobs := make(chan int)
	var wg sync.WaitGroup
	for n := 0; n < dirtyWorkers; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				inspectCheckout(ctx, g, roots[i], &v.Workspaces[i])
			}
		}()
	}
	for i := range roots {
		// A pruned checkout that is gone from disk has nothing to inspect and
		// keeps reading as pruned. Git also calls a checkout prunable when it
		// merely cannot be read; that one is inspected, and reads as inaccessible.
		if v.Workspaces[i].Availability == "pruned" {
			if _, e := os.Lstat(roots[i]); errors.Is(e, fs.ErrNotExist) {
				continue
			}
		}
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	if len(tips) == 0 {
		return nil
	}
	args := []string{"log", "--topo-order", "--no-show-signature", "--format=%H%x00%P%x00%ct%x00%B%x00", "--max-count=" + strconv.Itoa(limit)}
	args = append(args, tips...)
	args = append(args, "--")
	b, e = g.run(ctx, args...)
	if e != nil {
		return e
	}
	v.Nodes, e = parseGitLog(b)
	if e != nil {
		return e
	}
	seen := map[string]bool{}
	for _, n := range v.Nodes {
		seen[n.Key] = true
	}
	for _, tip := range tips {
		if seen[tip] {
			continue
		}
		b, e = g.run(ctx, "show", "-s", "--no-show-signature", "--format=%H%x00%P%x00%ct%x00%B%x00", tip, "--")
		if e != nil {
			return e
		}
		nodes, e := parseGitLog(b)
		if e != nil {
			return e
		}
		v.Nodes = append(v.Nodes, nodes...)
		seen[tip] = true
	}
	for _, ref := range []string{"main", "master"} {
		b, e := g.run(ctx, "rev-parse", "--verify", "refs/heads/"+ref+"^{commit}")
		if e == nil {
			v.DefaultTarget = strings.TrimSpace(b)
			v.DefaultTargetRef = ref
			break
		}
	}
	b, e = g.run(ctx, "rev-parse", "--is-shallow-repository")
	if e == nil && strings.TrimSpace(b) == "true" {
		v.Warnings = append(v.Warnings, "shallow repository: ancestry ends at locally available history")
		for i, n := range v.Nodes {
			if len(n.Parents) != 0 {
				continue
			}
			object, e := g.run(ctx, "cat-file", "-p", n.CommitID)
			if e != nil {
				return e
			}
			for _, line := range strings.Split(object, "\n") {
				if line == "" {
					break
				}
				if strings.HasPrefix(line, "parent ") {
					v.Nodes[i].Parents = append(v.Nodes[i].Parents, strings.TrimPrefix(line, "parent "))
				}
			}
		}
	}
	return nil
}

// inspectCheckout fills one workspace's dirty state from its own checkout.
func inspectCheckout(ctx context.Context, g *gitSession, root string, w *Workspace) {
	b, detail, numstat, e := g.dirtyState(ctx, root, !w.Unborn)
	if e != nil {
		w.Availability = "inaccessible"
		return
	}
	w.Dirty = b != ""
	skipRename := false
	for _, f := range strings.Split(b, "\x00") {
		if skipRename {
			skipRename = false
			continue
		}
		if len(f) >= 3 {
			w.ChangedFiles = append(w.ChangedFiles, f)
			skipRename = strings.ContainsAny(f[:2], "RC")
		}
		if len(f) >= 2 && (strings.Contains(f[:2], "U") || f[:2] == "AA" || f[:2] == "DD") {
			w.Conflicted = true
		}
	}
	if b != "" {
		var stats map[string]numstatEntry
		if numstat != "" {
			stats = parseNumstat(numstat)
		}
		w.Changes, w.ChangesTruncated = buildFileChanges(parsePorcelainChanges(detail), stats)
	}
}
func parseGitLog(b string) ([]Revision, error) {
	out := []Revision{}
	parts := strings.Split(b, "\x00")
	for len(parts) >= 4 {
		id := strings.TrimSpace(parts[0])
		if id == "" {
			break
		}
		stamp, e := strconv.ParseInt(parts[2], 10, 64)
		if e != nil {
			return nil, errors.New("invalid Git revision record")
		}
		out = append(out, Revision{Key: id, CommitID: id, Parents: strings.Fields(parts[1]), Timestamp: time.Unix(stamp, 0).UTC(), Description: strings.TrimSpace(parts[3])})
		parts = parts[4:]
	}
	return out, nil
}
