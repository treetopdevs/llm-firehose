// Package workspacegraph provides disposable, read-only local VCS snapshots.
package workspacegraph

import "time"

type Repository struct {
	ID         string    `json:"id"`
	VCS        string    `json:"vcs"`
	Label      string    `json:"label"`
	ObservedAt time.Time `json:"observed_at"`
	Status     string    `json:"status"`
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
type Workspace struct {
	rawIdentity  string
	ID           string   `json:"id"`
	RepoID       string   `json:"repo_id"`
	Label        string   `json:"label"`
	Revision     string   `json:"revision"`
	Refs         []string `json:"refs"`
	ChangedFiles []string `json:"changed_files"`
	Dirty        bool     `json:"dirty"`
	Conflicted   bool     `json:"conflicted"`
	Availability string   `json:"availability"`
	Unborn       bool     `json:"unborn"`
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
}
type Comparison struct {
	Selected     string   `json:"selected"`
	Target       string   `json:"target"`
	SelectedOnly []string `json:"selected_only"`
	TargetOnly   []string `json:"target_only"`
	MergeBases   []string `json:"merge_bases"`
	ChangedFiles []string `json:"changed_files"`
	Disconnected bool     `json:"disconnected"`
	Warnings     []string `json:"warnings"`
}
