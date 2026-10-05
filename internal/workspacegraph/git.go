package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
)

func scan(ctx context.Context, r registration, limit int, m privacy.Mode) (Snapshot, error) {
	v := Snapshot{Repository: Repository{ID: identity(r.identity, m), VCS: r.vcs, Label: identity(r.root, m), ObservedAt: time.Now().UTC(), Status: "ready"}, Nodes: []Revision{}, Workspaces: []Workspace{}, Edges: []Edge{}, Boundaries: []Boundary{}, Warnings: []string{}}
	var e error
	if r.vcs == "jj" {
		e = scanJJ(ctx, r, limit, m, &v)
	} else if e = guardGitConfig(ctx, r.root); e == nil {
		e = scanGit(ctx, r, limit, m, &v)
	}
	if e != nil {
		return v, e
	}
	seen := map[string]bool{}
	for _, n := range v.Nodes {
		seen[n.Key] = true
	}
	for _, n := range v.Nodes {
		for _, p := range n.Parents {
			if seen[p] {
				v.Edges = append(v.Edges, Edge{n.Key, p})
			} else {
				reason := "history not loaded"
				if r.vcs == "git" {
					if _, e := run(ctx, r.root, "git", "cat-file", "-e", p+"^{commit}"); e != nil {
						reason = "history unavailable locally"
					}
				}
				v.Boundaries = append(v.Boundaries, Boundary{n.Key, p, reason})
			}
		}
	}
	return v, nil
}
func scanGit(ctx context.Context, r registration, limit int, m privacy.Mode, v *Snapshot) error {
	b, e := run(ctx, r.root, "git", "worktree", "list", "--porcelain", "-z")
	if e != nil {
		return e
	}
	tips := []string{}
	roots := []string{}
	var w *Workspace
	for _, f := range strings.Split(b, "\x00") {
		switch {
		case strings.HasPrefix(f, "worktree "):
			root := strings.TrimPrefix(f, "worktree ")
			if c, e := canonical(root); e == nil {
				root = c
			}
			roots = append(roots, root)
			v.Workspaces = append(v.Workspaces, Workspace{rawIdentity: root, ID: identity(root, m), RepoID: v.Repository.ID, Label: identity(root, m), Refs: []string{}, Availability: "available"})
			w = &v.Workspaces[len(v.Workspaces)-1]
		case w == nil:
			continue
		case strings.HasPrefix(f, "HEAD "):
			w.Revision = strings.TrimPrefix(f, "HEAD ")
			if strings.Trim(w.Revision, "0") == "" {
				w.Unborn = true
				w.Revision = ""
			} else {
				tips = append(tips, w.Revision)
			}
		case strings.HasPrefix(f, "branch "):
			w.Refs = append(w.Refs, content(strings.TrimPrefix(f, "branch "), m))
		case f == "detached":
			w.Refs = append(w.Refs, "detached")
		case strings.HasPrefix(f, "locked"):
			w.Availability = "locked"
		case strings.HasPrefix(f, "prunable"):
			w.Availability = "pruned"
		}
	}
	for i, root := range roots {
		b, e := gitStatus(ctx, root)
		if e != nil {
			v.Workspaces[i].Availability = "inaccessible"
			continue
		}
		v.Workspaces[i].Dirty = b != ""
		skipRename := false
		for _, f := range strings.Split(b, "\x00") {
			if skipRename {
				skipRename = false
				continue
			}
			if len(f) >= 3 {
				v.Workspaces[i].ChangedFiles = append(v.Workspaces[i].ChangedFiles, content(f, m))
				skipRename = strings.ContainsAny(f[:2], "RC")
			}
			if len(f) >= 2 && (strings.Contains(f[:2], "U") || f[:2] == "AA" || f[:2] == "DD") {
				v.Workspaces[i].Conflicted = true
			}
		}
	}
	if len(tips) == 0 {
		return nil
	}
	args := []string{"log", "--topo-order", "--no-show-signature", "--format=%H%x00%P%x00%ct%x00%B%x00", "--max-count=" + strconv.Itoa(limit)}
	args = append(args, tips...)
	args = append(args, "--")
	b, e = run(ctx, r.root, "git", args...)
	if e != nil {
		return e
	}
	v.Nodes, e = parseGitLog(b, m)
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
		b, e = run(ctx, r.root, "git", "show", "-s", "--no-show-signature", "--format=%H%x00%P%x00%ct%x00%B%x00", tip, "--")
		if e != nil {
			return e
		}
		nodes, e := parseGitLog(b, m)
		if e != nil {
			return e
		}
		v.Nodes = append(v.Nodes, nodes...)
		seen[tip] = true
	}
	for _, ref := range []string{"refs/heads/main", "refs/heads/master"} {
		b, e := run(ctx, r.root, "git", "rev-parse", "--verify", ref+"^{commit}")
		if e == nil {
			v.DefaultTarget = strings.TrimSpace(b)
			break
		}
	}
	b, e = run(ctx, r.root, "git", "rev-parse", "--is-shallow-repository")
	if e == nil && strings.TrimSpace(b) == "true" {
		v.Warnings = append(v.Warnings, "shallow repository: ancestry ends at locally available history")
		for i, n := range v.Nodes {
			if len(n.Parents) != 0 {
				continue
			}
			object, e := run(ctx, r.root, "git", "cat-file", "-p", n.CommitID)
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
func parseGitLog(b string, m privacy.Mode) ([]Revision, error) {
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
		out = append(out, Revision{Key: id, CommitID: id, Parents: strings.Fields(parts[1]), Timestamp: time.Unix(stamp, 0).UTC(), Description: content(strings.TrimSpace(parts[3]), m)})
		parts = parts[4:]
	}
	return out, nil
}
