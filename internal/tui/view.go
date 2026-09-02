package tui

import (
	"encoding/json"
	"fmt"
	"regexp"
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
		return m.viewDetail()
	}
	if m.help {
		return m.viewHelp()
	}
	var b strings.Builder
	b.WriteString(m.viewHeader())
	b.WriteString("\n")
	now := m.now()
	var body []string
	if m.lanes {
		body = m.viewLanes(now)
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
	if m.lanes {
		parts = append(parts, dimStyle.Render("lanes · "+windowLabel(laneWindows[m.laneIdx])))
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

// viewFeed is the session band over the event rows.
func (m Model) viewFeed(now time.Time) []string {
	rows := m.visibleRows()
	var sessions []sessionInfo
	if m.height >= minBandHeight {
		sessions = m.liveSessions(now)
	}
	agentW := agentWidth(rows, sessions)
	lines := m.viewBand(sessions, now, agentW)

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
	prefixW := 1 + 1 + agentW + 1 + bandBuckets + 1 + dwellCells + 1 + 3 + 1 + stateWidth + 1
	// A narrow terminal keeps the number and gives the bar's cells to the text.
	withBar := m.width-prefixW >= minBandText
	if !withBar {
		prefixW -= dwellCells + 1
	}
	lines := make([]string, 0, maxRows+2)
	for i, s := range sessions {
		if i >= maxRows {
			lines = append(lines, dimStyle.Render(fmt.Sprintf("+%d more", len(sessions)-i)))
			break
		}
		text := s.Summary
		if s.State == stateNeedsInput && s.Reason != "" {
			text = s.Reason
		}
		line := sessionBar(s.ID) + " " + dimStyle.Render(padRight(s.Label, agentW)) + " " +
			sparkline(s.Buckets[:], scale) + " " + renderDwell(s, now, withBar) + " " +
			stateLabel(s.State) + " " + fit(stripControl(text), m.width-prefixW)
		lines = append(lines, line)
	}
	return append(lines, "")
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
	glyph := categoryGlyphs[ev.Category]
	if glyph == "" {
		glyph = "○"
	}
	summary := stripControl(ev.Summary)
	tone := dimStyle
	var summaryStyle *lipgloss.Style
	switch {
	case ev.Severity == event.SeverityError || ev.Category == event.CategoryError:
		tone, summaryStyle = errorStyle, &errorStyle
	case ev.Severity == event.SeverityWarn:
		tone, summaryStyle = warnStyle, &warnStyle
	}
	count := ""
	if row.Count > 1 {
		count = fmt.Sprintf(" ×%d", row.Count)
	}
	// Like the clock, the working directory is only printed when it changes.
	ctx := ""
	if !m.compact && ev.CWD != "" && (prev == nil || prev.Event.CWD != ev.CWD) {
		ctx = " " + shortPath(ev.CWD)
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
	if summaryStyle != nil {
		summary = summaryStyle.Render(summary)
	}
	return dimStyle.Render(ts) + " " + sessionBar(ev.SessionID) + " " +
		dimStyle.Render(padRight(agentLabel(ev.Agent, ev.Source), agentW)) + " " +
		tone.Render(glyph) + " " + summary + dimStyle.Render(count) + dimStyle.Render(ctx)
}

// viewLanes is a Marey-style timetable: wall time across, now at the right
// edge, one lane per live session. An empty stretch is the idle signal.
func (m Model) viewLanes(now time.Time) []string {
	sessions := m.liveSessions(now)
	agentW := agentWidth(nil, sessions)
	prefixW := 1 + 1 + agentW + 1 + stateWidth + 1
	laneW := max(m.width-prefixW, minLaneWidth)
	window := laneWindows[m.laneIdx]
	lines := []string{strings.Repeat(" ", prefixW) + dimStyle.Render(laneAxis(now, window, laneW))}
	if len(sessions) == 0 {
		return append(lines, dimStyle.Render("  no live sessions"))
	}
	maxLanes := max(m.height-4, 1)
	for i, ln := range buildLanes(m.events, sessions, now, window, laneW) {
		if i >= maxLanes {
			lines = append(lines, dimStyle.Render(fmt.Sprintf("+%d more", len(sessions)-i)))
			break
		}
		lines = append(lines, sessionBar(ln.ID)+" "+dimStyle.Render(padRight(ln.Label, agentW))+" "+
			stateLabel(ln.State)+" "+renderLaneCells(ln.Cells))
	}
	return lines
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
	help := "? help · l lanes"
	if m.lanes {
		help = "? help · l feed"
	}
	if m.status != "" {
		return m.status + "  " + dimStyle.Render(help)
	}
	return dimStyle.Render(help)
}

func (m Model) viewHelp() string {
	var b strings.Builder
	b.WriteString(headerStyle.Render("HELP") + dimStyle.Render("  (? or esc to close)") + "\n\n")
	b.WriteString("  keys\n")
	b.WriteString("  space  pause / resume      ↑↓ j k  scroll         enter  event detail\n")
	b.WriteString("  f      cycle category      a       cycle source   /      search summaries\n")
	b.WriteString("  l      lanes ⇄ feed        - +     lane window    t      hide / show cwd\n")
	b.WriteString("  e      export visible      q       quit\n\n")
	b.WriteString("  glyphs\n ")
	for _, cat := range glyphOrder {
		b.WriteString("  " + categoryGlyphs[cat] + " " + string(cat))
	}
	b.WriteString("\n\n  color\n")
	b.WriteString("  │ one hue per session   " + warnStyle.Render("warn") + "   " + errorStyle.Render("error") + "   " + needsStyle.Render("NEEDS YOU") + "\n\n")
	b.WriteString("  band\n")
	b.WriteString("  one line per live session: agent · events per 30s over the last 5m · time in its state as a bar, │ marks 5m · state · what it last did\n\n")
	b.WriteString("  lanes\n")
	b.WriteString("  wall time across, now at the right edge · ▂▄▆█ events per slot · ─ tool call still running · ! error · ? needs you\n")
	return b.String()
}

func (m Model) viewDetail() string {
	ev := *m.detail
	var b strings.Builder
	b.WriteString(headerStyle.Render("EVENT DETAIL") + dimStyle.Render("  (esc to close)") + "\n\n")
	b.WriteString(fmt.Sprintf("  id        %s\n", ev.ID))
	b.WriteString(fmt.Sprintf("  time      %s\n", ev.Time.Local().Format("2006-01-02 15:04:05.000")))
	b.WriteString(fmt.Sprintf("  source    %s (%s)\n", ev.Source, ev.Agent))
	b.WriteString(fmt.Sprintf("  session   %s\n", ev.SessionID))
	b.WriteString(fmt.Sprintf("  category  %s / %s [%s]\n", ev.Category, ev.Name, ev.Severity))
	if ev.CWD != "" {
		b.WriteString(fmt.Sprintf("  cwd       %s\n", ev.CWD))
	}
	b.WriteString(fmt.Sprintf("  summary   %s\n", stripControl(ev.Summary)))
	if len(ev.Payload) > 0 {
		data, err := json.MarshalIndent(ev.Payload, "  ", "  ")
		if err == nil {
			b.WriteString("\n  payload\n  " + string(data) + "\n")
		}
	}
	if ev.Raw != "" {
		b.WriteString("\n  raw\n  " + dimStyle.Render(truncate(stripControl(ev.Raw), 2000)) + "\n")
	}
	return b.String()
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
