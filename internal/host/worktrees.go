package host

import (
	"context"
	"errors"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/client"
	"agentfirehose/internal/tui"
)

type worktreeFunc func(ctx context.Context) (tui.WorktreeList, error)

func (f worktreeFunc) Worktrees(ctx context.Context) (tui.WorktreeList, error) { return f(ctx) }

// DaemonWorktrees adapts the daemon's GET /worktrees to the TUI source. The
// daemon classifies state, so StateKnown is true.
func DaemonWorktrees(c *client.Client) tui.WorktreeSource {
	return worktreeFunc(func(ctx context.Context) (tui.WorktreeList, error) {
		wts, err := c.Worktrees(ctx)
		if err != nil {
			if errors.Is(err, client.ErrWorktreesUnsupported) {
				return tui.WorktreeList{}, tui.ErrWorktreesUnavailable
			}
			return tui.WorktreeList{}, err
		}
		rows := make([]tui.WorktreeRow, 0, len(wts))
		for _, w := range wts {
			path := w.Label
			if path == "" {
				path = w.WorktreeID
			}
			refs := make([]tui.SessionRef, 0, len(w.Sessions))
			for _, s := range w.Sessions {
				refs = append(refs, tui.SessionRef{Source: s.Source, ID: s.SessionID})
			}
			rows = append(rows, tui.WorktreeRow{
				ID: w.WorktreeID, Repo: w.RepoID, Path: path, State: w.State,
				Last: w.LastTime, LastObserved: w.LastObserved,
				Sessions: refs, SessionsTotal: w.SessionsTotal,
				Ahead: w.Ahead, Behind: w.Behind, Dirty: w.Dirty,
			})
		}
		return tui.WorktreeList{Rows: rows, StateKnown: true}, nil
	})
}

// EngineWorktrees lists the in-process engine's spool-only lifetimes. It has
// no git knowledge, so State is empty and StateKnown false.
func EngineWorktrees(e *capture.Engine) tui.WorktreeSource {
	return worktreeFunc(func(ctx context.Context) (tui.WorktreeList, error) {
		if err := ctx.Err(); err != nil {
			return tui.WorktreeList{}, err
		}
		lts := e.Worktrees()
		rows := make([]tui.WorktreeRow, 0, len(lts))
		for _, lt := range lts {
			refs := make([]tui.SessionRef, 0, len(lt.Sessions))
			for _, s := range lt.Sessions {
				refs = append(refs, tui.SessionRef{Source: s.Source, ID: s.SessionID})
			}
			rows = append(rows, tui.WorktreeRow{
				ID: lt.WorktreeID, Repo: lt.RepoID, Path: lt.WorktreeID,
				Last: lt.LastTime, Sessions: refs, SessionsTotal: lt.SessionsTotal,
			})
		}
		return tui.WorktreeList{Rows: rows}, nil
	})
}

// SelectWorktrees prefers the daemon client and falls back to the feed's
// in-process source. It returns nil when neither exists.
func SelectWorktrees(c *client.Client, f Feed) tui.WorktreeSource {
	if c != nil {
		return DaemonWorktrees(c)
	}
	return f.Worktrees
}
