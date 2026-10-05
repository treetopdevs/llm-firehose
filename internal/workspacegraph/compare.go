package workspacegraph

import (
	"context"
	"errors"
	"os/exec"
	"regexp"
	"strings"
)

var revisionID = regexp.MustCompile(`^[a-f0-9]{40,64}$`)

func (s *Service) Compare(ctx context.Context, id, selected, target string) (Comparison, error) {
	s.mu.Lock()
	r := s.find(id)
	if r == nil {
		s.mu.Unlock()
		return Comparison{}, ErrNotFound
	}
	root, vcs, mode, epoch := r.root, r.vcs, s.mode, s.epoch
	if target == "" && r.snapshot != nil {
		target = r.snapshot.DefaultTarget
	}
	s.mu.Unlock()
	v := Comparison{Selected: selected, Target: target, SelectedOnly: []string{}, TargetOnly: []string{}, MergeBases: []string{}, ChangedFiles: []string{}, Warnings: []string{}}
	if !revisionID.MatchString(selected) || !revisionID.MatchString(target) {
		return v, errors.New("comparison requires full revision IDs and an explicit target")
	}
	query := func(args ...string) (string, error) { return run(ctx, root, vcs, args...) }
	var b string
	var e error
	if vcs == "git" {
		b, e = query("rev-list", selected, "^"+target, "--")
		if e != nil {
			return v, e
		}
		v.SelectedOnly = strings.Fields(b)
		b, e = query("rev-list", target, "^"+selected, "--")
		if e != nil {
			return v, e
		}
		v.TargetOnly = strings.Fields(b)
		b, e = query("merge-base", "--all", selected, target)
		if e == nil {
			v.MergeBases = strings.Fields(b)
		} else {
			var exit *exec.ExitError
			if !errors.As(e, &exit) || exit.ExitCode() != 1 {
				return v, e
			}
		}
		b, e = query("diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", target, selected, "--")
		if e != nil {
			return v, e
		}
		for _, p := range strings.Split(b, "\x00") {
			if p != "" {
				v.ChangedFiles = append(v.ChangedFiles, content(p, mode))
			}
		}
	} else {
		template := `commit_id ++ "\n"`
		b, e = query("log", "--no-graph", "-r", selected+" ~ ancestors("+target+") | (ancestors("+selected+") ~ ancestors("+target+"))", "-T", template)
		if e != nil {
			return v, e
		}
		v.SelectedOnly = strings.Fields(b)
		b, e = query("log", "--no-graph", "-r", "ancestors("+target+") ~ ancestors("+selected+")", "-T", template)
		if e != nil {
			return v, e
		}
		v.TargetOnly = strings.Fields(b)
		b, e = query("log", "--no-graph", "-r", "heads(ancestors("+selected+") & ancestors("+target+"))", "-T", template)
		if e != nil {
			return v, e
		}
		v.MergeBases = strings.Fields(b)
		b, e = query("diff", "--from", target, "--to", selected, "--name-only")
		if e != nil {
			return v, e
		}
		for _, p := range strings.Split(strings.TrimSpace(b), "\n") {
			if p != "" {
				v.ChangedFiles = append(v.ChangedFiles, content(p, mode))
			}
		}
	}
	v.Disconnected = len(v.MergeBases) == 0
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch != s.epoch {
		return Comparison{}, errors.New("privacy changed; retry comparison")
	}
	return v, nil
}
