package tui

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// The band and lane views are derived entirely from what the viewer already
// holds: the event ring and engine-owned attention. Nothing here re-folds the
// attention state machine; it only places the engine's answer next to activity.

const (
	bandBuckets = 10
	bandBucket  = 30 * time.Second
	// bandWindow is how long a quiet session stays in the band. Sessions the
	// engine reports as working or needing you stay regardless.
	bandWindow = 10 * time.Minute
	// attentionCap bounds the viewer's copy of engine attention; needs-input
	// entries are never evicted.
	attentionCap = 64
	// laneMaxOpenSpan caps how far an unfinished tool call is drawn: past this
	// we cannot honestly claim it is still running.
	laneMaxOpenSpan = 30 * time.Minute
	// Engine state is trusted only while it is still plausible. A session that
	// has not reported anything for longer than this is a ghost, not a live one.
	needsStaleAfter   = 24 * time.Hour
	workingStaleAfter = laneMaxOpenSpan
	minLaneWidth      = 10
	maxLabelRunes     = 12
	// The dwell bar measures time in the current state at half-minute
	// resolution against a hairline at five minutes: a session waiting past
	// the line is the one you forgot.
	dwellCell  = 30 * time.Second
	dwellCells = 15
	dwellHair  = 10 // cell index of the five-minute hairline

	stateWorking = "working"
	stateIdle    = "idle"
	stateDone    = "done"
)

var laneWindows = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour}

var sparkGlyphs = []rune("▁▂▃▄▅▆▇█")

// sessionInfo is one session as the band and lane views see it.
type sessionInfo struct {
	ID      string
	Label   string // agent, falling back to source family
	Last    time.Time
	Summary string
	State   string
	Since   time.Time
	Reason  string
	Buckets [bandBuckets]int // events per bandBucket, oldest first
}

func isTransition(ev event.Event) bool {
	return ev.Source == "firehose" && ev.Name == "state.transition"
}

func agentLabel(agent, source string) string {
	label := orDefault(agent, source)
	if r := []rune(label); len(r) > maxLabelRunes {
		label = string(r[:maxLabelRunes])
	}
	return label
}

// liveSessions folds the timeline and engine attention into one entry per
// session: needs-you first (longest wait first), then most recent activity.
func (m Model) liveSessions(now time.Time) []sessionInfo {
	byID := map[string]*sessionInfo{}
	for _, ev := range m.events {
		if ev.SessionID == "" || isTransition(ev) {
			continue
		}
		s := byID[ev.SessionID]
		if s == nil {
			s = &sessionInfo{ID: ev.SessionID, Label: agentLabel(ev.Agent, ev.Source)}
			byID[ev.SessionID] = s
		}
		if !ev.Time.Before(s.Last) {
			s.Last = ev.Time
			s.Summary = ev.Summary
		}
		age := now.Sub(ev.Time)
		if age < 0 {
			age = 0
		}
		if idx := bandBuckets - 1 - int(age/bandBucket); idx >= 0 && idx < bandBuckets {
			s.Buckets[idx]++
		}
	}
	for id, a := range m.attention {
		s := byID[id]
		if s == nil {
			s = &sessionInfo{ID: id, Label: agentLabel(a.Agent, a.Source)}
			byID[id] = s
		}
		s.State, s.Since, s.Reason = a.State, a.Since, a.Reason
	}
	out := make([]sessionInfo, 0, len(byID))
	for _, s := range byID {
		ref := s.Last
		if s.Since.After(ref) {
			ref = s.Since
		}
		if !stateFresh(s.State, ref, now) {
			continue
		}
		if s.Label == "" {
			s.Label = agentLabel("", s.ID)
		}
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.State == stateNeedsInput) != (b.State == stateNeedsInput) {
			return a.State == stateNeedsInput
		}
		if a.State == stateNeedsInput && !a.Since.Equal(b.Since) {
			return a.Since.Before(b.Since)
		}
		if !a.Last.Equal(b.Last) {
			return a.Last.After(b.Last)
		}
		return a.ID < b.ID
	})
	return out
}

// stateFresh reports whether a session still belongs on screen: recent
// activity, or an engine state that is still plausible given its age.
func stateFresh(state string, ref, now time.Time) bool {
	if ref.IsZero() {
		return false
	}
	age := now.Sub(ref)
	switch state {
	case stateNeedsInput:
		return age <= needsStaleAfter
	case stateWorking:
		return age <= workingStaleAfter
	default:
		return age <= bandWindow
	}
}

// sparkline draws counts on a shared scale so shapes compare across rows.
// Zero is blank: a gap is the signal, not a short bar.
func sparkline(buckets []int, scale int) string {
	var b strings.Builder
	for _, n := range buckets {
		if n <= 0 || scale <= 0 {
			b.WriteRune(' ')
			continue
		}
		level := (n*len(sparkGlyphs) + scale - 1) / scale
		level = min(max(level, 1), len(sparkGlyphs))
		b.WriteRune(sparkGlyphs[level-1])
	}
	return b.String()
}

// dwellBar draws d as a horizontal bar of dwellCells cells with the hairline
// in place. Half a cell (▌) marks a remainder past fifteen seconds, so the bar
// visibly grows while a session waits.
func dwellBar(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	full := int(d / dwellCell)
	half := d%dwellCell >= dwellCell/2
	cells := make([]rune, dwellCells)
	for i := range cells {
		unit := i
		if i > dwellHair {
			unit = i - 1
		}
		switch {
		case i == dwellHair:
			cells[i] = '│'
		case unit < full:
			cells[i] = '█'
		case unit == full && half:
			cells[i] = '▌'
		default:
			cells[i] = ' '
		}
	}
	return string(cells)
}

func formatAge(d time.Duration) string {
	switch {
	case d < time.Second:
		return "0s"
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// laneCell is one slot of wall time in one session's lane.
type laneCell struct {
	Events int
	Span   bool // a tool call opened earlier is still running through this slot
	Error  bool
	Needs  bool
}

type lane struct {
	sessionInfo
	Cells []laneCell
}

// buildLanes places every session's events on one wall-clock axis that ends
// at now. Tool calls are paired by call id: a start opens a span, the matching
// end closes it, and an unfinished call runs to now (bounded by laneMaxOpenSpan).
func buildLanes(events []event.Event, sessions []sessionInfo, now time.Time, window time.Duration, width int) []lane {
	width = max(width, 1)
	slot := max(window/time.Duration(width), time.Millisecond)
	cellAt := func(t time.Time) int {
		if !t.Before(now) {
			return width - 1
		}
		return width - 1 - int(now.Sub(t)/slot)
	}
	index := make(map[string]int, len(sessions))
	lanes := make([]lane, len(sessions))
	for i, s := range sessions {
		lanes[i] = lane{sessionInfo: s, Cells: make([]laneCell, width)}
		index[s.ID] = i
	}

	type spanKey struct{ session, call string }
	type span struct {
		start, end     time.Time
		started, ended bool
	}
	spans := map[spanKey]*span{}
	var order []spanKey
	for _, ev := range events {
		i, ok := index[ev.SessionID]
		if !ok {
			continue
		}
		cells := lanes[i].Cells
		if isTransition(ev) {
			if state, _ := ev.Payload["state"].(string); state == stateNeedsInput {
				if c := cellAt(ev.Time); c >= 0 {
					cells[c].Needs = true
				}
			}
			continue
		}
		if c := cellAt(ev.Time); c >= 0 {
			cells[c].Events++
			if ev.Severity == event.SeverityError || ev.Category == event.CategoryError {
				cells[c].Error = true
			}
		}
		if ev.CallID == "" {
			continue
		}
		phase, _ := ev.Payload["phase"].(string)
		if phase != "start" && phase != "end" {
			continue
		}
		key := spanKey{ev.SessionID, ev.CallID}
		sp := spans[key]
		if sp == nil {
			sp = &span{}
			spans[key] = sp
			order = append(order, key)
		}
		if phase == "start" && !sp.started {
			sp.start, sp.started = ev.Time, true
		} else if phase == "end" && !sp.ended {
			sp.end, sp.ended = ev.Time, true
		}
	}
	for _, key := range order {
		sp := spans[key]
		if !sp.started {
			continue
		}
		ln := &lanes[index[key.session]]
		end := sp.end
		if !sp.ended || end.Before(sp.start) {
			// An unfinished call runs to now only while the engine still says
			// the session is working; otherwise it ends at the last report.
			end = now
			if ln.State != stateWorking && ln.State != "" && !ln.Last.IsZero() {
				end = ln.Last
			}
			if limit := sp.start.Add(laneMaxOpenSpan); limit.Before(end) {
				end = limit
			}
		}
		from, to := max(cellAt(sp.start), 0), cellAt(end)
		for c := from; c <= to && c < width; c++ {
			ln.Cells[c].Span = true
		}
	}
	return lanes
}

var axisSteps = []time.Duration{
	10 * time.Second, 30 * time.Second, time.Minute, 5 * time.Minute,
	15 * time.Minute, 30 * time.Minute, time.Hour,
}

func axisStep(slot time.Duration) time.Duration {
	for _, step := range axisSteps {
		if step >= 10*slot {
			return step
		}
	}
	return axisSteps[len(axisSteps)-1]
}

// laneAxis labels whole clock times that fall inside the window, so labels
// slide left as time passes instead of showing arbitrary offsets from now.
func laneAxis(now time.Time, window time.Duration, width int) string {
	width = max(width, 1)
	slot := max(window/time.Duration(width), time.Millisecond)
	step := axisStep(slot)
	layout := "15:04"
	if step < time.Minute {
		layout = "15:04:05"
	}
	cells := []rune(strings.Repeat(" ", width))
	start := now.Add(-window)
	next := 0
	for i := 0; i < width; i++ {
		t := start.Add(time.Duration(i) * slot)
		mark := t.Truncate(step)
		if !mark.After(t.Add(-slot)) {
			continue
		}
		label := []rune("╷" + mark.Local().Format(layout))
		if i < next || i+len(label) > width {
			continue
		}
		copy(cells[i:], label)
		next = i + len(label) + 1
	}
	return string(cells)
}

func windowLabel(d time.Duration) string {
	if d >= time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dm", int(d.Minutes()))
}
