package tui

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/charmbracelet/lipgloss"

	"agentfirehose/internal/event"
	"agentfirehose/internal/store"
)

var (
	headerStyle = lipgloss.NewStyle().Bold(true)
	liveStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("10")).Bold(true)
	pauseStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("11")).Bold(true)
	needsStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("208")).Bold(true)
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	countStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("13")).Bold(true)
	selStyle    = lipgloss.NewStyle().Reverse(true)

	agentColors = map[string]string{
		"claude-code": "12", // blue
		"codex":       "10", // green
		"opencode":    "13", // magenta
		"generic":     "14", // cyan
		"procwatch":   "8",  // grey
		"firehose":    "8",
	}
	categoryColors = map[event.Category]string{
		event.CategorySession:    "13",
		event.CategoryPrompt:     "14",
		event.CategoryMessage:    "7",
		event.CategoryTool:       "12",
		event.CategoryFile:       "11",
		event.CategoryPermission: "208",
		event.CategoryShell:      "10",
		event.CategoryError:      "9",
		event.CategoryMeta:       "8",
	}
	// sessionColors gives thread continuity: a session id hashes to one color.
	sessionColors = []string{"1", "2", "3", "4", "5", "6", "9", "10", "11", "12", "13", "14"}
)

func (m Model) View() string {
	if m.detail != nil {
		return m.viewDetail()
	}
	var b strings.Builder
	b.WriteString(m.viewHeader())
	b.WriteString("\n")

	rows := m.visibleRows()
	listHeight := max(1, m.height-3)
	start := 0
	sel := m.cursor
	if sel < 0 { // follow bottom
		if len(rows) > listHeight {
			start = len(rows) - listHeight
		}
	} else if sel >= listHeight {
		start = sel - listHeight + 1
	}
	for i := start; i < len(rows) && i-start < listHeight; i++ {
		line := m.renderRow(rows[i])
		if i == sel {
			line = selStyle.Render(line)
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	if len(rows) == 0 {
		b.WriteString(dimStyle.Render("  waiting for agent activity…"))
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

func (m Model) renderRow(row store.Row) string {
	ev := row.Event
	ts := dimStyle.Render(ev.Time.Local().Format("15:04:05"))
	agent := badge(orDefault(ev.Agent, ev.Source), agentColors[ev.Source])
	cat := badge(string(ev.Category), categoryColors[ev.Category])
	sess := ""
	if ev.SessionID != "" {
		sess = lipgloss.NewStyle().Foreground(lipgloss.Color(sessionColor(ev.SessionID))).Render("│")
	} else {
		sess = " "
	}
	summary := ev.Summary
	if ev.Severity == event.SeverityError {
		summary = lipgloss.NewStyle().Foreground(lipgloss.Color("9")).Render(summary)
	} else if ev.Severity == event.SeverityWarn {
		summary = lipgloss.NewStyle().Foreground(lipgloss.Color("11")).Render(summary)
	}
	count := ""
	if row.Count > 1 {
		count = " " + countStyle.Render(fmt.Sprintf("×%d", row.Count))
	}
	ctx := ""
	if !m.compact && ev.CWD != "" {
		ctx = " " + dimStyle.Render(shortPath(ev.CWD))
	}
	return fmt.Sprintf("%s %s %s %s %s%s%s", ts, sess, agent, cat, summary, count, ctx)
}

func (m Model) viewFooter() string {
	help := "space pause · ↑/↓ scroll · enter detail · f category · a source · / search · t density · e export · q quit"
	if m.status != "" {
		return m.status + "  " + dimStyle.Render(help)
	}
	return dimStyle.Render(help)
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
	b.WriteString(fmt.Sprintf("  summary   %s\n", ev.Summary))
	if len(ev.Payload) > 0 {
		data, err := json.MarshalIndent(ev.Payload, "  ", "  ")
		if err == nil {
			b.WriteString("\n  payload\n  " + string(data) + "\n")
		}
	}
	if ev.Raw != "" {
		b.WriteString("\n  raw\n  " + dimStyle.Render(truncate(ev.Raw, 2000)) + "\n")
	}
	return b.String()
}

func badge(label, color string) string {
	if color == "" {
		color = "7"
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Render("[" + label + "]")
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

const needsYouReasonMaxRunes = 80

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-]`)

// sanitizeNeedsYouReason strips terminal control sequences and bounds length
// before the reason is appended to the header label.
func sanitizeNeedsYouReason(reason string) string {
	reason = ansiEscape.ReplaceAllString(reason, "")
	reason = strings.Map(func(r rune) rune {
		if r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, reason)
	reason = strings.Join(strings.Fields(reason), " ")
	runes := []rune(reason)
	if len(runes) > needsYouReasonMaxRunes {
		reason = string(runes[:needsYouReasonMaxRunes]) + "…"
	}
	return reason
}
