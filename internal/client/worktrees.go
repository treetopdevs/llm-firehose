package client

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// ErrWorktreesUnsupported means the daemon does not serve GET /worktrees.
var ErrWorktreesUnsupported = errors.New("client: daemon does not support worktrees")

// WorktreeSession is one session listed on a worktree.
type WorktreeSession struct {
	Source    string    `json:"source"`
	SessionID string    `json:"session_id"`
	FirstTime time.Time `json:"first_time"`
	LastTime  time.Time `json:"last_time"`
	Events    int       `json:"events"`
}

// Worktree is one GET /worktrees item. The marks array is intentionally
// omitted; Ahead, Behind, Dirty and LastObserved are nil when the daemon
// has not observed the worktree.
type Worktree struct {
	RepoID          string            `json:"repo_id"`
	WorktreeID      string            `json:"worktree_id"`
	Label           string            `json:"label,omitempty"`
	FirstTime       time.Time         `json:"first_time"`
	LastTime        time.Time         `json:"last_time"`
	Sessions        []WorktreeSession `json:"sessions"`
	SessionsTotal   int               `json:"sessions_total"`
	Paths           []string          `json:"paths"`
	PathsTotal      int               `json:"paths_total"`
	PathsSaturated  bool              `json:"paths_saturated,omitempty"`
	SignalEvents    int               `json:"signal_events"`
	MetaEvents      int               `json:"meta_events"`
	MarksTotal      int               `json:"marks_total"`
	MarksAvailable  bool              `json:"marks_available"`
	State           string            `json:"state"`
	Outcome         string            `json:"outcome,omitempty"`
	StateReason     string            `json:"state_reason,omitempty"`
	DefaultTargetRf string            `json:"default_target_ref,omitempty"`
	Head            string            `json:"head,omitempty"`
	Ahead           *int              `json:"ahead,omitempty"`
	Behind          *int              `json:"behind,omitempty"`
	Dirty           *bool             `json:"dirty,omitempty"`
	LastObserved    *time.Time        `json:"last_observed,omitempty"`
}

// Worktrees returns the daemon's worktree lifetimes. Any 404 deliberately
// means the daemon predates the route: ErrWorktreesUnsupported.
func (c *Client) Worktrees(ctx context.Context) ([]Worktree, error) {
	var wts []Worktree
	if err := c.getJSON(ctx, "/worktrees", &wts); err != nil {
		var se *statusError
		if errors.As(err, &se) && se.Code == http.StatusNotFound {
			return nil, ErrWorktreesUnsupported
		}
		return nil, err
	}
	if wts == nil {
		wts = []Worktree{}
	}
	return wts, nil
}
