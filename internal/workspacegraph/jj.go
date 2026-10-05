package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const jjRevisionTemplate = `'{' ++ '"key":' ++ json(commit_id) ++ ',"commit_id":' ++ json(commit_id) ++ ',"change_id":' ++ json(change_id) ++ ',"parents":' ++ json(parents.map(|p| p.commit_id())) ++ ',"description":' ++ json(description) ++ ',"timestamp":' ++ json(committer.timestamp().format("%Y-%m-%dT%H:%M:%S%:z")) ++ ',"conflicted":' ++ json(conflict) ++ "}\n"`
const jjWorkspaceTemplate = `'{' ++ '"name":' ++ json(name) ++ ',"root":' ++ json(root) ++ ',"revision":' ++ json(target.commit_id()) ++ ',"conflicted":' ++ json(target.conflict()) ++ ',"dirty":' ++ json(!target.empty()) ++ ',"refs":' ++ json(target.local_bookmarks().map(|b| b.name())) ++ "}\n"`

func scanJJ(ctx context.Context, r registration, limit int, m privacy.Mode, v *Snapshot) error {
	b, e := run(ctx, r.root, "jj", "workspace", "list", "-T", jjWorkspaceTemplate)
	if e != nil {
		return e
	}
	tips := []string{}
	for _, line := range strings.Split(strings.TrimSpace(b), "\n") {
		if line == "" {
			continue
		}
		var x struct {
			Name       string   `json:"name"`
			Root       *string  `json:"root"`
			Revision   string   `json:"revision"`
			Conflicted bool     `json:"conflicted"`
			Dirty      bool     `json:"dirty"`
			Refs       []string `json:"refs"`
		}
		if json.Unmarshal([]byte(line), &x) != nil {
			return errors.New("unsupported JJ workspace output")
		}
		id := r.identity + ":" + x.Name
		availability := "unknown root"
		if x.Root != nil {
			p := *x.Root
			if c, e := canonical(p); e == nil {
				p = c
				availability = "available"
			} else {
				availability = "inaccessible"
			}
			id = "jj:" + p
			// Inspect status with snapshotting disabled: stale workspaces are reported without update.
			if availability == "available" {
				availability = jjAvailability(ctx, p, x.Revision)
			}
		}
		refs := []string{}
		for _, ref := range x.Refs {
			refs = append(refs, content(ref, m))
		}
		v.Workspaces = append(v.Workspaces, Workspace{rawIdentity: id, ID: identity(id, m), RepoID: v.Repository.ID, Label: content(x.Name, m), Revision: x.Revision, Refs: refs, Dirty: x.Dirty, Conflicted: x.Conflicted, Availability: availability})
		tips = append(tips, x.Revision)
	}
	if len(tips) == 0 {
		return nil
	}
	revset := "ancestors(" + strings.Join(tips, " | ") + ")"
	b, e = run(ctx, r.root, "jj", "log", "--no-graph", "-r", revset, "--limit", strconv.Itoa(limit), "-T", jjRevisionTemplate)
	if e != nil {
		return e
	}
	v.Nodes, e = parseJJ(b, m)
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
		b, e = run(ctx, r.root, "jj", "log", "--no-graph", "-r", tip, "-T", jjRevisionTemplate)
		if e != nil {
			return e
		}
		nodes, e := parseJJ(b, m)
		if e != nil {
			return e
		}
		v.Nodes = append(v.Nodes, nodes...)
		seen[tip] = true
	}
	for _, ref := range []string{"main", "master"} {
		b, e := run(ctx, r.root, "jj", "log", "--no-graph", "-r", ref, "-T", `commit_id ++ "\n"`)
		if e == nil && strings.TrimSpace(b) != "" {
			v.DefaultTarget = strings.TrimSpace(b)
			break
		}
	}
	v.Warnings = append(v.Warnings, "JJ working-copy state is last recorded state; read-only scans do not snapshot filesystem changes")
	return nil
}
func parseJJ(b string, m privacy.Mode) ([]Revision, error) {
	out := []Revision{}
	for _, line := range strings.Split(strings.TrimSpace(b), "\n") {
		if line == "" {
			continue
		}
		var n Revision
		if json.Unmarshal([]byte(line), &n) != nil {
			return nil, errors.New("unsupported JJ revision output")
		}
		n.Description = content(strings.TrimSpace(n.Description), m)
		if n.Parents == nil {
			n.Parents = []string{}
		}
		out = append(out, n)
	}
	return out, nil
}

var operationPattern = regexp.MustCompile(`Current operation: OperationId\("([a-f0-9]+)"\)`)

func jjAvailability(ctx context.Context, root, revision string) string {
	b, e := run(ctx, root, "jj", "debug", "working-copy")
	if e != nil {
		return "inaccessible"
	}
	match := operationPattern.FindStringSubmatch(b)
	if len(match) != 2 {
		return "unknown working-copy state"
	}
	b, e = run(ctx, root, "jj", "--at-op="+match[1], "log", "--no-graph", "-r", "@", "-T", "commit_id")
	if e != nil {
		return "unknown working-copy state"
	}
	if strings.TrimSpace(b) != revision {
		return "stale"
	}
	return "available"
}
