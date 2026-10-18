package projection

import (
	"strconv"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// titleMaxRunes bounds a prompt-derived title to one readable line.
const titleMaxRunes = 88

// titleState folds title evidence deterministically: a source's own session
// title (authoritative) wins over any prompt excerpt, the latest authoritative
// title by source time wins, and among prompt excerpts the earliest wins.
// Ties on time break on event ID, so a live fold and a chronological rebuild
// from the spool agree whatever order events arrived in.
type titleState struct {
	title         string
	authoritative bool
	at            time.Time
	id            string
}

// consider applies one event's title evidence and reports whether the title changed.
func (t *titleState) consider(ev event.Event) bool {
	title, authoritative := SessionTitle(ev)
	if title == "" {
		return false
	}
	switch {
	case t.title == "":
	case authoritative && !t.authoritative:
	case authoritative && t.authoritative && later(ev.Time, ev.ID, t.at, t.id):
	case !authoritative && !t.authoritative && later(t.at, t.id, ev.Time, ev.ID):
	default:
		return false
	}
	t.title, t.authoritative, t.at, t.id = title, authoritative, ev.Time, ev.ID
	return true
}

func later(aT time.Time, aID string, bT time.Time, bID string) bool {
	if !aT.Equal(bT) {
		return aT.After(bT)
	}
	return aID > bID
}

// SessionTitle derives a human name for a session from one event.
//
// A source's own session title (Claude Code's `session_title`) is
// authoritative. Otherwise a prompt event's text (Codex's `message`, or the
// quoted excerpt in its summary) names the session. Digested payloads
// (minimal mode) never yield a title, so no name is invented from a hash.
func SessionTitle(ev event.Event) (title string, authoritative bool) {
	if t, ok := ev.Payload["session_title"].(string); ok && strings.TrimSpace(t) != "" {
		return excerpt(t, titleMaxRunes), true
	}
	if ev.Category != event.CategoryPrompt {
		return "", false
	}
	for _, key := range []string{"message", "prompt"} {
		if t, ok := ev.Payload[key].(string); ok && strings.TrimSpace(t) != "" {
			return excerpt(t, titleMaxRunes), false
		}
	}
	if rest, ok := strings.CutPrefix(ev.Summary, "prompt: "); ok {
		// Codex writes the excerpt with %q: decode it so escapes read as text.
		if decoded, err := strconv.Unquote(rest); err == nil {
			rest = decoded
		} else {
			rest = strings.Trim(rest, `"`)
		}
		if strings.TrimSpace(rest) != "" {
			return excerpt(rest, titleMaxRunes), false
		}
	}
	return "", false
}

// excerpt collapses whitespace to single spaces and bounds the rune count.
func excerpt(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > max {
		return strings.TrimRight(string(r[:max]), " ") + "…"
	}
	return s
}
