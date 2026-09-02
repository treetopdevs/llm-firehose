package tui

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/charmbracelet/lipgloss"

	"agentfirehose/internal/event"
	"agentfirehose/internal/store"
)

// Colour is reserved for what the reader must not miss: warn, error, and a
// session that needs them. Everything routine is plain or dim, and the only
// other hue is the session bar, which is how a thread stays traceable.
var (
	headerStyle = lipgloss.NewStyle().Bold(true)
	liveStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("10")).Bold(true)
	pauseStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("11")).Bold(true)
	needsStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("208")).Bold(true)
	warnStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	errorStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	selStyle    = lipgloss.NewStyle().Reverse(true)

	// categoryGlyphs replace bracketed words: one cell, one category.
	categoryGlyphs = map[event.Category]string{
		event.CategorySession:    "◆",
		event.CategoryPrompt:     "▸",
		event.CategoryMessage:    "≡",
		event.CategoryTool:       "●",
		event.CategoryFile:       "■",
		event.CategoryPermission: "?",
		event.CategoryShell:      "$",
		event.CategoryError:      "!",
		event.CategoryMeta:       "·",
	}
	glyphOrder = []event.Category{
		event.CategorySession, event.CategoryPrompt, event.CategoryMessage,
		event.CategoryTool, event.CategoryFile, event.CategoryPermission,
		event.CategoryShell, event.CategoryError, event.CategoryMeta,
	}
	// sessionColors gives thread continuity: a session id hashes to one color.
	sessionColors = []string{"1", "2", "3", "4", "5", "6", "9", "10", "11", "12", "13", "14"}
)

const (
	clockWidth = len("15:04:05")
	stateWidth = len("NEEDS YOU")
	// minBandHeight is the smallest terminal that still gets the session band.
	minBandHeight = 12
	// minBandText is the text budget below which the band drops the dwell bar.
	minBandText = 12
)

func (m Model) View() string {
	if m.detail != nil {
		return m.viewCall(m.now())
	}
	if m.help {
		return m.viewHelp()
	}
	var b strings.Builder
	b.WriteString(m.viewHeader())
	b.WriteString("\n")
	now := m.now()
	var body []string
	if m.alt == altWorkspace {
		body = m.viewWorkspace(now)
	} else {
		body = m.viewFeed(now)
	}
	for _, line := range body {
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString(m.viewFooter())
	return b.String()
}

func (m Model) viewHeader() string {
	mode := liveStyle.Render("● LIVE")
	if m.paused {
		mode = pauseStyle.Render(fmt.Sprintf("⏸ PAUSED · %d new", m.unread))
	}
	parts := []string{headerStyle.Render("AGENT FIREHOSE"), mode, dimStyle.Render(fmt.Sprintf("%d events", m.total))}
	if n := m.needsYouCount(); n > 0 {
		label := fmt.Sprintf("NEEDS YOU · %d", n)
		if reason := sanitizeNeedsYouReason(m.oldestNeedsYouReason()); reason != "" {
			label += " · " + reason
		}
		parts = append(parts, needsStyle.Render(label))
	}
	switch {
	case m.alt == altWorkspace:
		parts = append(parts, dimStyle.Render("workspace"))
	case m.lanes:
		parts = append(parts, dimStyle.Render("lanes · "+windowLabel(laneWindows[m.laneIdx])))
	}
	if m.scope != nil {
		parts = append(parts, dimStyle.Render("▸ ")+whereLabel(m.scope.Where)+" · "+m.scope.Agent)
	}
	if f := m.filterLabel(); f != "" {
		parts = append(parts, dimStyle.Render("filter: ")+f)
	}
	if m.search {
		parts = append(parts, "search: "+m.buf+"█")
	}
	return strings.Join(parts, "  ")
}

func (m Model) filterLabel() string {
	var parts []string
	if m.filter.Source != "" {
		parts = append(parts, "source="+m.filter.Source)
	}
	if m.filter.Category != "" {
		parts = append(parts, "category="+string(m.filter.Category))
	}
	if m.filter.Text != "" {
		parts = append(parts, fmt.Sprintf("text=%q", m.filter.Text))
	}
	return strings.Join(parts, " ")
}

// viewFeed is the session altitude: a strip of live sessions (the band, or
// lanes) over the event rows.
func (m Model) viewFeed(now time.Time) []string {
	rows := m.visibleRows()
	var sessions []sessionInfo
	if m.height >= minBandHeight {
		sessions = m.liveSessions(now)
	}
	agentW := agentWidth(rows, sessions)
	var lines []string
	if m.lanes {
		lines = m.viewLaneStrip(sessions, now, agentW)
	} else {
		lines = m.viewBand(sessions, now, agentW)
	}

	listHeight := max(1, m.height-3-len(lines))
	start := 0
	sel := m.cursor
	if sel < 0 { // follow bottom
		if len(rows) > listHeight {
			start = len(rows) - listHeight
		}
	} else if sel >= listHeight {
		start = sel - listHeight + 1
	}
	end := min(len(rows), start+listHeight)
	var prev *store.Row
	for i := start; i < end; i++ {
		line := m.renderRow(rows[i], prev, agentW)
		if i == sel {
			line = selStyle.Render(line)
		}
		lines = append(lines, line)
		prev = &rows[i]
	}
	if len(rows) == 0 {
		lines = append(lines, dimStyle.Render("  waiting for agent activity…"))
	}
	return lines
}

// viewBand is Tufte's small multiples: the same encoding repeated per live
// session so the eye compares shapes instead of reading. It returns nothing
// when there is nothing live, and ends with a blank separator otherwise.
func (m Model) viewBand(sessions []sessionInfo, now time.Time, agentW int) []string {
	if len(sessions) == 0 {
		return nil
	}
	maxRows := min(max((m.height-4)/4, 1), 6)
	scale := 0
	for _, s := range sessions {
		for _, n := range s.Buckets {
			scale = max(scale, n)
		}
	}
	prefixW, withBar := m.bandLayout(agentW)
	lines := make([]string, 0, maxRows+2)
	for i, s := range sessions {
		if i >= maxRows {
			lines = append(lines, dimStyle.Render(fmt.Sprintf("+%d more", len(sessions)-i)))
			break
		}
		lines = append(lines, m.bandLine(s, now, scale, agentW, withBar, m.width-prefixW))
	}
	return append(lines, "")
}

// bandLayout sizes the band's fixed columns. A narrow terminal keeps the dwell
// number and gives the bar's cells to the text.
func (m Model) bandLayout(agentW int) (prefixW int, withBar bool) {
	prefixW = 1 + 1 + agentW + 1 + bandBuckets + 1 + dwellCells + 1 + 3 + 1 + stateWidth + 1
	withBar = m.width-prefixW >= minBandText
	if !withBar {
		prefixW -= dwellCells + 1
	}
	return prefixW, withBar
}

func (m Model) bandLine(s sessionInfo, now time.Time, scale, agentW int, withBar bool, textW int) string {
	text := s.Summary
	if s.State == stateNeedsInput && s.Reason != "" {
		text = s.Reason
	}
	return sessionBar(s.ID) + " " + dimStyle.Render(padRight(s.Label, agentW)) + " " +
		sparkline(s.Buckets[:], scale) + " " + renderDwell(s, now, withBar) + " " +
		stateLabel(s.State) + " " + fit(stripControl(text), textW)
}

// renderDwell is the dwell bar with its number as the label. A session whose
// state the engine has not reported has no dwell, only the hairline.
func renderDwell(s sessionInfo, now time.Time, withBar bool) string {
	d, label := time.Duration(-1), strings.Repeat(" ", 3)
	if s.State != "" && !s.Since.IsZero() {
		d = now.Sub(s.Since)
		label = dimStyle.Render(padLeft(formatAge(d), 3))
	}
	if !withBar {
		return label
	}
	return dwellStyled(dwellBar(d)) + " " + label
}

func dwellStyled(bar string) string {
	r := []rune(bar)
	return string(r[:dwellHair]) + dimStyle.Render(string(r[dwellHair])) + string(r[dwellHair+1:])
}

func stateLabel(state string) string {
	switch state {
	case stateNeedsInput:
		return needsStyle.Render(padRight("NEEDS YOU", stateWidth))
	case "":
		return strings.Repeat(" ", stateWidth)
	default:
		return dimStyle.Render(padRight(state, stateWidth))
	}
}

// agentWidth sizes the agent column to what is actually on screen, so the
// column is never wider than its widest label.
func agentWidth(rows []store.Row, sessions []sessionInfo) int {
	w := 1
	for _, r := range rows {
		w = max(w, lipgloss.Width(agentLabel(r.Event.Agent, r.Event.Source)))
	}
	for _, s := range sessions {
		w = max(w, lipgloss.Width(s.Label))
	}
	return w
}

// renderRow prints one event. The clock is only spelled out when the minute
// changes from the row above; within a minute the seconds are the only news.
func (m Model) renderRow(row store.Row, prev *store.Row, agentW int) string {
	ev := row.Event
	local := ev.Time.Local()
	ts := local.Format("15:04:05")
	if prev != nil && prev.Event.Time.Local().Truncate(time.Minute).Equal(local.Truncate(time.Minute)) {
		ts = padLeft(local.Format(":05"), clockWidth)
	}
	glyph, tone, loud := eventTone(ev)
	summary := stripControl(ev.Summary)
	count := ""
	if row.Count > 1 {
		count = fmt.Sprintf(" ×%d", row.Count)
	}
	// Like the clock, the workspace is only printed when it changes.
	ctx := ""
	if where := workspaceLabel(ev.Repo, ev.CWD); !m.compact && where != "" &&
		(prev == nil || workspaceLabel(prev.Event.Repo, prev.Event.CWD) != where) {
		ctx = " " + where
	}
	prefixW := clockWidth + 1 + 1 + 1 + agentW + 1 + 1 + 1
	budget := m.width - prefixW - lipgloss.Width(count)
	if ctxW := lipgloss.Width(ctx); ctxW > 0 {
		if lipgloss.Width(summary)+ctxW <= budget || budget-ctxW >= 20 {
			budget -= ctxW
		} else {
			ctx = ""
		}
	}
	summary = fit(summary, budget)
	if loud {
		summary = tone.Render(summary)
	}
	return dimStyle.Render(ts) + " " + sessionBar(ev.SessionID) + " " +
		dimStyle.Render(padRight(agentLabel(ev.Agent, ev.Source), agentW)) + " " +
		tone.Render(glyph) + " " + summary + dimStyle.Render(count) + dimStyle.Render(ctx)
}

// viewLaneStrip is a Marey-style timetable: wall time across, now at the
// right edge, one lane per live session. An empty stretch is the idle signal.
func (m Model) viewLaneStrip(sessions []sessionInfo, now time.Time, agentW int) []string {
	if len(sessions) == 0 {
		return nil
	}
	maxRows := min(max((m.height-4)/4, 1), 6)
	prefixW := 1 + 1 + agentW + 1 + stateWidth + 1
	laneW := max(m.width-prefixW, minLaneWidth)
	window := laneWindows[m.laneIdx]
	lines := make([]string, 0, maxRows+3)
	lines = append(lines, strings.Repeat(" ", prefixW)+dimStyle.Render(laneAxis(now, window, laneW)))
	for i, ln := range buildLanes(m.events, sessions, now, window, laneW) {
		if i >= maxRows {
			lines = append(lines, dimStyle.Render(fmt.Sprintf("+%d more", len(sessions)-i)))
			break
		}
		lines = append(lines, sessionBar(ln.ID)+" "+dimStyle.Render(padRight(ln.Label, agentW))+" "+
			stateLabel(ln.State)+" "+renderLaneCells(ln.Cells))
	}
	return append(lines, "")
}

const (
	maxWhereWidth = 20
	// matrixCellWidth is sparkline · state glyph · session count.
	matrixCellWidth = bandBuckets + 1 + 1 + 1 + 2
)

// viewWorkspace is the top altitude: one row per workspace, one column per
// agent, and in each occupied cell the same sparkline as the band, the worst
// state among the cell's sessions, and how many there are.
func (m Model) viewWorkspace(now time.Time) []string {
	mx := buildMatrix(m.liveSessions(now))
	if len(mx.Cells) == 0 {
		return []string{dimStyle.Render("  no live sessions")}
	}
	whereW := 1
	for _, w := range mx.Wheres {
		whereW = max(whereW, lipgloss.Width(whereLabel(w)))
	}
	whereW = min(whereW, maxWhereWidth, max(m.width/3, 4))
	// Columns that do not fit are not drawn; the header ends with an ellipsis
	// so the reader knows there are more. Cells keep their reading-order index
	// so the selection still names the right cell.
	cols := min(len(mx.Agents), max((m.width-whereW)/(2+matrixCellWidth), 1))
	scale := 0
	for _, c := range mx.Cells {
		for _, n := range c.Buckets {
			scale = max(scale, n)
		}
	}
	head := strings.Repeat(" ", whereW)
	for _, a := range mx.Agents[:cols] {
		head += "  " + padRight(fit(a, matrixCellWidth), matrixCellWidth)
	}
	if cols < len(mx.Agents) {
		head += " …"
	}
	lines := []string{dimStyle.Render(strings.TrimRight(fit(head, m.width), " "))}
	sel := min(m.cellIdx, len(mx.Cells)-1)
	idx := 0
	for _, w := range mx.Wheres {
		line := padRight(fit(whereLabel(w), whereW), whereW)
		for i, a := range mx.Agents {
			c, ok := mx.cell(w, a)
			if !ok {
				if i < cols {
					line += "  " + strings.Repeat(" ", matrixCellWidth)
				}
				continue
			}
			if i < cols {
				line += "  " + renderMatrixCell(c, scale, idx == sel)
			}
			idx++
		}
		lines = append(lines, strings.TrimRight(line, " "))
	}
	return lines
}

func renderMatrixCell(c matrixCell, scale int, selected bool) string {
	glyph, style := stateGlyph(c.State)
	count := "  "
	if c.Sessions > 1 {
		count = padLeft(strconv.Itoa(min(c.Sessions, 99)), 2)
	}
	spark := sparkline(c.Buckets[:], scale)
	if selected {
		return selStyle.Render(spark + " " + glyph + " " + count)
	}
	return spark + " " + style.Render(glyph) + " " + dimStyle.Render(count)
}

// stateGlyph is the one-cell form of the band's state column.
func stateGlyph(state string) (string, lipgloss.Style) {
	switch state {
	case stateNeedsInput:
		return "?", needsStyle
	case stateWorking:
		return "●", lipgloss.NewStyle()
	case stateIdle:
		return "·", dimStyle
	default:
		return " ", dimStyle
	}
}

// whereLabel prints a matrix row or scope; a session that never reported a
// workspace gets a dash rather than a blank.
func whereLabel(key string) string {
	if key == "" {
		return "—"
	}
	return workspaceLabel("", key)
}

func renderLaneCells(cells []laneCell) string {
	var b strings.Builder
	var run strings.Builder
	var runStyle *lipgloss.Style
	flush := func() {
		if run.Len() == 0 {
			return
		}
		if runStyle != nil {
			b.WriteString(runStyle.Render(run.String()))
		} else {
			b.WriteString(run.String())
		}
		run.Reset()
	}
	for _, c := range cells {
		glyph, style := laneGlyph(c)
		if style != runStyle {
			flush()
			runStyle = style
		}
		run.WriteString(glyph)
	}
	flush()
	return b.String()
}

func laneGlyph(c laneCell) (string, *lipgloss.Style) {
	switch {
	case c.Error:
		return "!", &errorStyle
	case c.Needs:
		return "?", &needsStyle
	case c.Events >= 4:
		return "█", nil
	case c.Events == 3:
		return "▆", nil
	case c.Events == 2:
		return "▄", nil
	case c.Events == 1:
		return "▂", nil
	case c.Span:
		return "─", &dimStyle
	default:
		return " ", nil
	}
}

func (m Model) viewFooter() string {
	help := "? help · esc workspace · l lanes"
	switch {
	case m.alt == altWorkspace:
		help = "? help · ↑↓ pick · enter open"
	case m.lanes:
		help = "? help · esc workspace · l band"
	}
	if m.status != "" {
		return m.status + "  " + dimStyle.Render(help)
	}
	return dimStyle.Render(help)
}

func (m Model) viewHelp() string {
	var b strings.Builder
	b.WriteString(headerStyle.Render("HELP") + dimStyle.Render("  (? or esc to close)") + "\n\n")
	b.WriteString("  altitudes\n")
	b.WriteString("  workspace (repos × agents)  ›  session (band or lanes over rows)  ›  call\n")
	b.WriteString("  enter descends, esc ascends; the header keeps the scope as a breadcrumb\n\n")
	b.WriteString("  keys\n")
	b.WriteString("  space  pause / resume      ↑↓ j k  scroll / pick  enter  descend\n")
	b.WriteString("  f      cycle category      a       cycle source   /      search summaries\n")
	b.WriteString("  l      lanes ⇄ band        - +     lane window    t      hide / show cwd\n")
	b.WriteString("  e      export visible      q       quit           esc    ascend\n\n")
	b.WriteString("  glyphs\n ")
	for _, cat := range glyphOrder {
		b.WriteString("  " + categoryGlyphs[cat] + " " + string(cat))
	}
	b.WriteString("\n\n  color\n")
	b.WriteString("  │ one hue per session   " + warnStyle.Render("warn") + "   " + errorStyle.Render("error") + "   " + needsStyle.Render("NEEDS YOU") + "\n\n")
	b.WriteString("  band\n")
	b.WriteString("  one line per live session: agent · events per 30s over the last 5m · time in its state as a bar, │ marks 5m and full is 10m · state · what it last did\n\n")
	b.WriteString("  lanes\n")
	b.WriteString("  wall time across, now at the right edge · ▂▄▆█ events per slot · ─ tool call still running · ! error · ? needs you\n\n")
	b.WriteString("  workspace\n")
	b.WriteString("  one row per workspace, one column per agent · sparkline · ? needs you  ● working  · idle · count when more than one session\n")
	return b.String()
}

// eventTone picks the category glyph and the one colour an event may claim:
// red for error, yellow for warn, dim otherwise. loud says the summary shares it.
func eventTone(ev event.Event) (glyph string, tone lipgloss.Style, loud bool) {
	glyph = categoryGlyphs[ev.Category]
	if glyph == "" {
		glyph = "○"
	}
	switch {
	case ev.Severity == event.SeverityError || ev.Category == event.CategoryError:
		return glyph, errorStyle, true
	case ev.Severity == event.SeverityWarn:
		return glyph, warnStyle, true
	}
	return glyph, dimStyle, false
}

const callKeyWidth = len("severity") + 1

// viewCall is the call altitude: one event as a designed table rather than a
// marshalled dump. Start and end are paired by call id, the duration is the
// difference, and the parent session stays on screen as a one-line breadcrumb
// so context survives the zoom.
func (m Model) viewCall(now time.Time) string {
	ev := *m.detail
	var b strings.Builder
	crumb := joinNonEmpty(" · ", workspaceLabel(ev.Repo, ev.CWD), agentLabel(ev.Agent, ev.Source), prefixed("session ", shortID(ev.SessionID)))
	b.WriteString(headerStyle.Render("CALL") + "  " + dimStyle.Render(crumb) + dimStyle.Render("  (esc to close)") + "\n")
	if s, ok := m.sessionByID(ev.SessionID, now); ok {
		scale := 0
		for _, n := range s.Buckets {
			scale = max(scale, n)
		}
		agentW := lipgloss.Width(s.Label)
		prefixW, withBar := m.bandLayout(agentW)
		b.WriteString(m.bandLine(s, now, scale, agentW, withBar, m.width-prefixW) + "\n")
	}
	b.WriteString("\n")

	glyph, tone, _ := eventTone(ev)
	title := string(ev.Category)
	if name := toolName(ev); name != "" {
		title += "  " + name
	} else if ev.Name != "" {
		title += " / " + ev.Name
	}
	b.WriteString("  " + clockMs(ev.Time) + "  " + tone.Render(glyph) + " " + fit(stripControl(title), m.width-16) + "\n")
	if ev.Summary != "" {
		b.WriteString("  " + fit(stripControl(ev.Summary), m.width-2) + "\n")
	}
	b.WriteString("\n")
	var start, end *event.Event
	if ev.CallID != "" {
		start, end = pairCall(m.events, ev)
	}
	for _, row := range m.callRows(ev, start, end, now) {
		b.WriteString("  " + padRight(row[0], callKeyWidth) + " " + fit(stripControl(row[1]), m.width-3-callKeyWidth) + "\n")
	}

	// Request and response are the two halves of one call; keys the headline
	// and timing rows already express are not repeated.
	omit := map[string]bool{"tool_name": toolName(ev) != ""}
	if start != nil || end != nil {
		omit["phase"] = true
		if start != nil {
			b.WriteString(m.payloadTable("request", start.Payload, omit))
		}
		if end != nil {
			b.WriteString(m.payloadTable("response", end.Payload, omit))
		}
		if phase, _ := ev.Payload["phase"].(string); phase != "start" && phase != "end" {
			b.WriteString(m.payloadTable("payload", ev.Payload, omit))
		}
	} else {
		b.WriteString(m.payloadTable("payload", ev.Payload, omit))
	}
	if ev.Raw != "" {
		b.WriteString("\n  raw\n  " + dimStyle.Render(truncate(stripControl(ev.Raw), 2000)) + "\n")
	}
	return b.String()
}

// payloadTable is one key/value section, keys sorted, one line per value.
func (m Model) payloadTable(title string, payload map[string]any, omit map[string]bool) string {
	keys := make([]string, 0, len(payload))
	kw := 0
	for k := range payload {
		if omit[k] {
			continue
		}
		keys = append(keys, k)
		kw = max(kw, lipgloss.Width(k))
	}
	if len(keys) == 0 {
		return ""
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("\n  " + title + "\n")
	for _, k := range keys {
		b.WriteString("  " + padRight(stripControl(k), kw) + "  " + fit(formatValue(payload[k]), m.width-4-kw) + "\n")
	}
	return b.String()
}

// callRows is the timing and identity table under the headline.
func (m Model) callRows(ev event.Event, start, end *event.Event, now time.Time) [][2]string {
	var rows [][2]string
	add := func(k, v string) { rows = append(rows, [2]string{k, v}) }
	if ev.CallID != "" {
		if start != nil {
			add("started", clockMs(start.Time))
		}
		switch {
		case start != nil && end != nil:
			add("ended", clockMs(end.Time)+"  "+fmtDuration(end.Time.Sub(start.Time)))
		case start != nil:
			if m.attention[ev.SessionID].State == stateWorking {
				add("ended", "still running · "+formatAge(now.Sub(start.Time)))
			} else {
				add("ended", "no end captured")
			}
		case end != nil:
			add("ended", clockMs(end.Time)+"  no start captured")
		}
	}
	if ev.SourceTime != nil && ev.CaptureTime != nil {
		add("captured", latencyLabel(ev.CaptureTime.Sub(*ev.SourceTime)))
	}
	if ids := joinNonEmpty(" · ", prefixed("session ", ev.SessionID), prefixed("turn ", ev.TurnID),
		prefixed("call ", ev.CallID), prefixed("trace ", ev.TraceID)); ids != "" {
		add("ids", ids)
	}
	if ev.Repo != "" {
		add("repo", ev.Repo)
	}
	if ev.CWD != "" {
		add("cwd", ev.CWD)
	}
	if ev.Severity != "" && ev.Severity != event.SeverityInfo {
		add("severity", string(ev.Severity))
	}
	add("id", ev.ID)
	return rows
}

// pairCall finds the start and end observations of ev's tool call: the first
// start and the first end at or after it, in the same session. Dual
// observations of one phase (a hook push and a rollout tail) are coalesced
// first, exactly as the feed coalesces them, so the pair agrees with the row.
func pairCall(events []event.Event, ev event.Event) (start, end *event.Event) {
	var same []event.Event
	for _, other := range events {
		if other.SessionID == ev.SessionID && other.CallID == ev.CallID {
			same = append(same, other)
		}
	}
	rows := store.Coalesce(same, coalesceWindow)
	for i := range rows {
		other := &rows[i].Event
		switch phase, _ := other.Payload["phase"].(string); phase {
		case "start":
			if start == nil {
				start = other
			}
		case "end":
			if end == nil && (start == nil || !other.Time.Before(start.Time)) {
				end = other
			}
		}
	}
	return start, end
}

func (m Model) sessionByID(id string, now time.Time) (sessionInfo, bool) {
	if id == "" {
		return sessionInfo{}, false
	}
	for _, s := range m.liveSessions(now) {
		if s.ID == id {
			return s, true
		}
	}
	return sessionInfo{}, false
}

func toolName(ev event.Event) string {
	name, _ := ev.Payload["tool_name"].(string)
	return name
}

func clockMs(t time.Time) string { return t.Local().Format("15:04:05.000") }

// fmtDuration prints one resolution per magnitude: ms, s with two decimals,
// then m and h with a two-digit remainder.
func fmtDuration(d time.Duration) string {
	if d < 0 {
		d = -d
	}
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	case d < time.Minute:
		return fmt.Sprintf("%.2fs", d.Seconds())
	case d < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	default:
		return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	}
}

// latencyLabel reads capture time against the source's own clock.
func latencyLabel(d time.Duration) string {
	if d < 0 {
		return fmtDuration(d) + " before source"
	}
	return "+" + fmtDuration(d) + " after source"
}

// formatValue renders one payload value on one line. Privacy digests
// ({sha256, len}) read as a short hash and a length instead of an object.
func formatValue(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return stripControl(x)
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case map[string]any:
		if sum, ok := x["sha256"].(string); ok {
			if n, ok := x["len"]; ok {
				return "#" + shortID(sum) + " · len " + formatValue(n)
			}
		}
	}
	data, err := json.Marshal(v)
	if err != nil {
		return stripControl(fmt.Sprint(v))
	}
	return stripControl(string(data))
}

// shortID is the one place a source-supplied id is prepared for the terminal.
func shortID(id string) string {
	id = stripControl(id)
	if r := []rune(id); len(r) > 8 {
		return string(r[:8])
	}
	return id
}

func prefixed(prefix, s string) string {
	if s == "" {
		return ""
	}
	return prefix + s
}

func joinNonEmpty(sep string, parts ...string) string {
	kept := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, sep)
}

// workspaceLabel names where an event happened with what privacy allows: the
// repo name, a short path, or the first eight hex digits of a digested path.
// It is the one place a workspace is prepared for the terminal.
func workspaceLabel(repo, cwd string) string {
	if repo != "" {
		return stripControl(repo)
	}
	if isDigest(cwd) {
		return cwd[:8]
	}
	return stripControl(shortPath(cwd))
}

func isDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return false
		}
	}
	return true
}

func sessionBar(id string) string {
	if id == "" {
		return " "
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color(sessionColor(id))).Render("│")
}

func sessionColor(id string) string {
	h := 0
	for _, r := range id {
		h = (h*31 + int(r)) % len(sessionColors)
	}
	return sessionColors[h]
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func shortPath(p string) string {
	parts := strings.Split(p, "/")
	if len(parts) > 2 {
		return "…/" + strings.Join(parts[len(parts)-2:], "/")
	}
	return p
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func padRight(s string, w int) string {
	if pad := w - lipgloss.Width(s); pad > 0 {
		return s + strings.Repeat(" ", pad)
	}
	return s
}

func padLeft(s string, w int) string {
	if pad := w - lipgloss.Width(s); pad > 0 {
		return strings.Repeat(" ", pad) + s
	}
	return s
}

// fit truncates s to at most w display cells, marking the cut with an ellipsis.
func fit(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= w {
		return s
	}
	var b strings.Builder
	used := 0
	for _, r := range s {
		rw := lipgloss.Width(string(r))
		if used+rw > w-1 {
			break
		}
		b.WriteRune(r)
		used += rw
	}
	return b.String() + "…"
}

const needsYouReasonMaxRunes = 80

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-]`)

// stripControl removes terminal control sequences and control characters so
// event-derived text cannot steer the terminal. Tabs and newlines become spaces.
func stripControl(s string) string {
	s = ansiEscape.ReplaceAllString(s, "")
	return strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\n', '\r':
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

// sanitizeNeedsYouReason strips terminal control sequences and bounds length
// before the reason is appended to the header label.
func sanitizeNeedsYouReason(reason string) string {
	reason = strings.Join(strings.Fields(stripControl(reason)), " ")
	runes := []rune(reason)
	if len(runes) > needsYouReasonMaxRunes {
		reason = string(runes[:needsYouReasonMaxRunes]) + "…"
	}
	return reason
}
