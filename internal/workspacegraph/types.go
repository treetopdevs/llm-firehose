// Package workspacegraph provides disposable, read-only local VCS snapshots.
package workspacegraph

import "time"

type Repository struct {
	ID  string `json:"id"` // follows the privacy mode (a digest outside full mode)
	VCS string `json:"vcs"`
	// Label is the canonical root path, readable in every privacy mode.
	Label      string    `json:"label"`
	ObservedAt time.Time `json:"observed_at"`
	Status     string    `json:"status"`
	// ProjectID is shared by every registration of one project: a Git repository
	// and the JJ repository colocated with it carry the same value, the Git
	// repository identity (so it equals the repo_id Capture stamps on events and
	// follows the privacy mode like ID). ProjectLabel is the project's main
	// checkout, readable in every mode.
	ProjectID    string `json:"project_id,omitempty"`
	ProjectLabel string `json:"project_label,omitempty"`
}
type Revision struct {
	Key         string    `json:"key"`
	CommitID    string    `json:"commit_id"`
	ChangeID    string    `json:"change_id,omitempty"`
	Parents     []string  `json:"parents"`
	Description string    `json:"description"`
	Timestamp   time.Time `json:"timestamp"`
	Conflicted  bool      `json:"conflicted"`
}

// FileChange describes one changed path with its status letter and, when the
// VCS can supply them, line counts. Path is the VCS's own path, readable and
// untruncated in every privacy mode like every other display value in a graph
// response (only Repository.ID and Workspace.ID follow the mode). Additions and
// Deletions are pointers so a real zero ("+0 -3") stays distinct from "no
// counts" (untracked, binary, unborn HEAD, or counts unavailable).
type FileChange struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions *int   `json:"additions,omitempty"`
	Deletions *int   `json:"deletions,omitempty"`
	Binary    bool   `json:"binary,omitempty"`
}
type Workspace struct {
	rawIdentity string
	ID          string `json:"id"`
	RepoID      string `json:"repo_id"`
	// Label is the worktree path (Git) or the workspace name (JJ), readable in
	// every privacy mode; ID is what follows the mode.
	Label            string       `json:"label"`
	Revision         string       `json:"revision"`
	Refs             []string     `json:"refs"`
	ChangedFiles     []string     `json:"changed_files"`
	Changes          []FileChange `json:"changes,omitempty"`
	ChangesTruncated bool         `json:"changes_truncated,omitempty"`
	Dirty            bool         `json:"dirty"`
	Conflicted       bool         `json:"conflicted"`
	Availability     string       `json:"availability"`
	Unborn           bool         `json:"unborn"`
	// Primary marks a Git repository's main checkout. A bare repository has
	// none, so its first linked worktree is not primary.
	Primary bool `json:"primary,omitempty"`
}
type Edge struct {
	Child  string `json:"child"`
	Parent string `json:"parent"`
}
type Boundary struct {
	Child  string `json:"child"`
	Parent string `json:"parent"`
	Reason string `json:"reason"`
}
type Snapshot struct {
	Repository    Repository  `json:"repository"`
	Generation    string      `json:"generation"`
	Nodes         []Revision  `json:"nodes"`
	Edges         []Edge      `json:"edges"`
	Workspaces    []Workspace `json:"workspaces"`
	Boundaries    []Boundary  `json:"boundaries"`
	Warnings      []string    `json:"warnings"`
	NextCursor    string      `json:"next_cursor,omitempty"`
	Stale         bool        `json:"stale"`
	DefaultTarget string      `json:"default_target,omitempty"`
	// DefaultTargetRef names the ref behind DefaultTarget ("main", "master",
	// or the JJ bookmark), as written.
	DefaultTargetRef string `json:"default_target_ref,omitempty"`
}
type Comparison struct {
	Selected         string       `json:"selected"`
	Target           string       `json:"target"`
	SelectedOnly     []string     `json:"selected_only"`
	TargetOnly       []string     `json:"target_only"`
	MergeBases       []string     `json:"merge_bases"`
	ChangedFiles     []string     `json:"changed_files"`
	Changes          []FileChange `json:"changes,omitempty"`
	ChangesTruncated bool         `json:"changes_truncated,omitempty"`
	Disconnected     bool         `json:"disconnected"`
	Warnings         []string     `json:"warnings"`
}
