package projection

import (
	"encoding/json"
	"slices"
	"strings"

	"agentfirehose/internal/event"
)

// EventActivityPaths extracts an event's paths. A minimal-mode {sha256,len} digest
// where a codex changes map was is no path; EventFilePaths guards
// that. A Codex apply_patch event names its paths only in its patch text and its
// result text: the rollout splits them across the call and its output, the
// hook's PostToolUse carries both. Both are read here, once each path. The file
// artifact views keep using EventFilePaths, so /artifacts/files is unchanged.
func EventActivityPaths(ev event.Event) []string {
	if paths := EventFilePaths(ev); len(paths) > 0 {
		return paths
	}
	paths := ApplyPatchPaths(applyPatchText(ev.Payload))
	for _, p := range ApplyPatchSummaryPaths(applyPatchOutput(ev.Payload)) {
		if !slices.Contains(paths, p) {
			paths = append(paths, p)
		}
	}
	return paths
}

// applyPatchText is a Codex apply_patch call's patch: the rollout
// custom_tool_call's input, or the hook's tool_input.command. A minimal-mode
// digest is not a string and yields nothing.
func applyPatchText(payload map[string]any) string {
	if payload["tool_name"] != "apply_patch" {
		return ""
	}
	if s, ok := payload["input"].(string); ok {
		return s
	}
	if in, ok := payload["tool_input"].(map[string]any); ok {
		s, _ := in["command"].(string)
		return s
	}
	return ""
}

var applyPatchHeaders = []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "}

// ApplyPatchPaths returns the paths a patch's file headers name, in order and
// once each. Only newline-terminated lines count: balanced mode cuts long text
// at 240 runes and ends it with "…", so an unterminated last line may hold a
// cut path.
func ApplyPatchPaths(text string) []string {
	var out []string
	for {
		line, rest, ok := strings.Cut(text, "\n")
		if !ok {
			return out
		}
		text = rest
		for _, h := range applyPatchHeaders {
			if p, ok := strings.CutPrefix(line, h); ok && p != "" && !slices.Contains(out, p) {
				out = append(out, p)
			}
		}
	}
}

// applyPatchOutput is a Codex apply_patch result text: the rollout
// custom_tool_call_output's, or the hook PostToolUse's. Balanced mode often
// cuts a patch after its first header's diff, while its output lists its
// files one per line with no diff between them, so it can name files the
// patch text no longer does.
func applyPatchOutput(payload map[string]any) string {
	if payload["tool_name"] != "apply_patch" {
		return ""
	}
	s, _ := payload["output"].(string)
	return s
}

const applyPatchSummary = "Success. Updated the following files:\n"

// ApplyPatchSummaryPaths returns the paths an apply_patch result lists after
// its "Success. Updated the following files:" line, one "A ", "M " or "D " line
// each, in order and once each. Older captures wrap the text in
// {"output": ...}. As for headers, only newline-terminated lines count, so a
// line cut by truncation is no path; a failure lists nothing.
func ApplyPatchSummaryPaths(output string) []string {
	if strings.HasPrefix(output, "{") {
		output = unwrapApplyPatchOutput(output)
	}
	text, ok := strings.CutPrefix(output, applyPatchSummary)
	if !ok {
		if _, text, ok = strings.Cut(output, "\n"+applyPatchSummary); !ok {
			return nil
		}
	}
	var out []string
	for {
		line, rest, ok := strings.Cut(text, "\n")
		if !ok || len(line) < 2 || !strings.ContainsRune("AMD", rune(line[0])) || line[1] != ' ' {
			return out
		}
		text = rest
		if p := line[2:]; p != "" && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
}

// unwrapApplyPatchOutput returns the "output" string of a JSON-wrapped result.
// A wrapper cut by truncation inside that string is read up to its last
// complete "\n" escape.
func unwrapApplyPatchOutput(s string) string {
	var w struct {
		Output string `json:"output"`
	}
	if json.Unmarshal([]byte(s), &w) == nil {
		return w.Output
	}
	lit, ok := strings.CutPrefix(s, `{"output":"`)
	if !ok {
		return ""
	}
	end := 0
scan:
	for i := 0; i < len(lit); i++ {
		switch lit[i] {
		case '"':
			end = i
			break scan
		case '\\':
			i++
			if i < len(lit) && lit[i] == 'n' {
				end = i + 1
			}
		}
	}
	var out string
	if json.Unmarshal([]byte(`"`+lit[:end]+`"`), &out) != nil {
		return ""
	}
	return out
}
