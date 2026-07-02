// Package event defines the normalized envelope every capture source is
// mapped into before display, persistence, or export.
package event

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// Category classifies an event for display grouping and filtering.
type Category string

const (
	CategorySession    Category = "session"
	CategoryPrompt     Category = "prompt"
	CategoryMessage    Category = "message"
	CategoryTool       Category = "tool"
	CategoryFile       Category = "file"
	CategoryPermission Category = "permission"
	CategoryShell      Category = "shell"
	CategoryError      Category = "error"
	CategoryMeta       Category = "meta"
)

// Severity ranks how prominently an event should surface.
type Severity string

const (
	SeverityInfo   Severity = "info"
	SeverityNotice Severity = "notice"
	SeverityWarn   Severity = "warn"
	SeverityError  Severity = "error"
)

var validCategories = map[Category]bool{
	CategorySession: true, CategoryPrompt: true, CategoryMessage: true,
	CategoryTool: true, CategoryFile: true, CategoryPermission: true,
	CategoryShell: true, CategoryError: true, CategoryMeta: true,
}

var validSeverities = map[Severity]bool{
	SeverityInfo: true, SeverityNotice: true, SeverityWarn: true, SeverityError: true,
}

// Event is the common envelope for all agent activity.
type Event struct {
	ID        string         `json:"id"`
	Time      time.Time      `json:"time"`
	Source    string         `json:"source"`               // agent family: claude-code, codex, opencode, generic, procwatch
	Agent     string         `json:"agent,omitempty"`      // specific agent/binary name
	SessionID string         `json:"session_id,omitempty"`
	Category  Category       `json:"category"`
	Name      string         `json:"name,omitempty"` // source-specific event name
	Severity  Severity       `json:"severity,omitempty"`
	Summary   string         `json:"summary,omitempty"`
	Repo      string         `json:"repo,omitempty"`
	CWD       string         `json:"cwd,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	Raw       string         `json:"raw,omitempty"` // original source payload, privacy mode permitting
}

// Validate reports whether the event has the minimum required shape.
func (e *Event) Validate() error {
	if e.Source == "" {
		return fmt.Errorf("event: source is required")
	}
	if e.Time.IsZero() {
		return fmt.Errorf("event: time is required")
	}
	if !validCategories[e.Category] {
		return fmt.Errorf("event: invalid category %q", e.Category)
	}
	if e.Severity != "" && !validSeverities[e.Severity] {
		return fmt.Errorf("event: invalid severity %q", e.Severity)
	}
	return nil
}

// NewID returns a random 16-byte hex identifier.
func NewID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
