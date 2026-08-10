package antigravity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"agentfirehose/internal/event"
)

// fixtureEvents pairs every real agy 1.1.10 capture with the event name its
// per-event capture file was registered under (see testdata/README.md — the
// payloads themselves carry no event-name field).
var fixtureEvents = map[string]string{
	"pre_tool_use_run_command.json":          "PreToolUse",
	"pre_tool_use_list_dir.json":             "PreToolUse",
	"pre_tool_use_view_file.json":            "PreToolUse",
	"pre_tool_use_replace_file_content.json": "PreToolUse",
	"post_tool_use_run_command.json":         "PostToolUse",
	"post_tool_use_list_dir.json":            "PostToolUse",
	"post_tool_use_view_file.json":           "PostToolUse",
	"post_tool_use_grep_search.json":         "PostToolUse",
	"pre_invocation.json":                    "PreInvocation",
	"post_invocation.json":                   "PostInvocation",
	"stop.json":                              "Stop",
}

const (
	fixtureConversationID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb"
	fixtureBrainDir       = "/tmp/agent-firehose-agy-fixture/brain"
)

func fixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return strings.TrimSpace(string(data))
}

func parse(t *testing.T, eventName, raw string) event.Event {
	t.Helper()
	parsed, err := Parse(eventName, []byte(raw))
	if err != nil {
		t.Fatalf("Parse(%s): %v", eventName, err)
	}
	if parsed == nil {
		t.Fatalf("Parse(%s) unexpectedly skipped event", eventName)
	}
	ev := *parsed
	if ev.Source != "antigravity" {
		t.Errorf("source = %q, want antigravity", ev.Source)
	}
	if ev.Transport != "hook" {
		t.Errorf("transport = %q, want hook", ev.Transport)
	}
	if ev.Time.IsZero() {
		t.Error("time not set")
	}
	if ev.CaptureTime == nil || !ev.Time.Equal(*ev.CaptureTime) {
		t.Errorf("capture_time = %v, want the locally assigned event time %v", ev.CaptureTime, ev.Time)
	}
	if ev.SourceTime != nil {
		t.Errorf("source_time = %v, want absent because agy hooks supply no timestamp", ev.SourceTime)
	}
	return ev
}

func safeDetails(t *testing.T, ev event.Event) string {
	t.Helper()
	data, err := json.Marshal(struct {
		Summary string         `json:"summary"`
		Payload map[string]any `json:"payload"`
	}{ev.Summary, ev.Payload})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestManifestIsValid(t *testing.T) {
	if err := Manifest.Validate(); err != nil {
		t.Fatalf("Manifest.Validate: %v", err)
	}
	want := []string{"PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"}
	if !reflect.DeepEqual(Manifest.Mapped, want) {
		t.Errorf("Mapped = %v, want %v", Manifest.Mapped, want)
	}
	if Manifest.Transport != "hook" || Manifest.SourceSchema != "antigravity-cli@1.1.10" {
		t.Errorf("manifest identity wrong: %+v", Manifest)
	}
}

func TestEveryFixtureEventIsInTheManifest(t *testing.T) {
	mapped := map[string]bool{}
	for _, name := range Manifest.Mapped {
		mapped[name] = true
	}
	for fixtureName, eventName := range fixtureEvents {
		if !mapped[eventName] {
			t.Errorf("fixture %s uses unmapped event %s", fixtureName, eventName)
		}
	}
}

func TestPreToolUseRunCommandMapsToShellStart(t *testing.T) {
	ev := parse(t, "PreToolUse", fixture(t, "pre_tool_use_run_command.json"))
	if ev.Category != event.CategoryShell {
		t.Errorf("category = %q, want shell", ev.Category)
	}
	if ev.Name != "PreToolUse:run_command" {
		t.Errorf("name = %q", ev.Name)
	}
	if ev.SessionID != fixtureConversationID {
		t.Errorf("session_id = %q", ev.SessionID)
	}
	// No native tool-call correlation id exists; stepIdx is an ordering value,
	// not a call id, and must never be promoted into one.
	if ev.CallID != "" {
		t.Errorf("call_id = %q, want empty (agy supplies no native call id)", ev.CallID)
	}
	// Fixtures carry an empty workspacePaths array, so no CWD is observable.
	if ev.CWD != "" {
		t.Errorf("cwd = %q, want empty for empty workspacePaths", ev.CWD)
	}
	if ev.Payload["phase"] != "start" || ev.Payload["status"] != "started" {
		t.Errorf("outcome = %+v", ev.Payload)
	}
	if got, ok := ev.Payload["step_idx"].(int64); !ok || got != 8 {
		t.Errorf("step_idx = %v (%T)", ev.Payload["step_idx"], ev.Payload["step_idx"])
	}
	if ev.Payload["model"] != "gemini-3-flash-agent" {
		t.Errorf("model = %v", ev.Payload["model"])
	}
	if ev.Payload["tool_name"] != "run_command" {
		t.Errorf("tool_name = %v", ev.Payload["tool_name"])
	}
	if ev.Severity != event.SeverityInfo {
		t.Errorf("severity = %q", ev.Severity)
	}
}

func TestPreToolUseViewFileMapsToFileWithPath(t *testing.T) {
	ev := parse(t, "PreToolUse", fixture(t, "pre_tool_use_view_file.json"))
	if ev.Category != event.CategoryFile {
		t.Errorf("category = %q, want file", ev.Category)
	}
	if ev.Payload["file_path"] != "/tmp/definitely-absent-9x7.txt" {
		t.Errorf("file_path = %v", ev.Payload["file_path"])
	}
	if !strings.Contains(ev.Summary, "definitely-absent-9x7.txt") {
		t.Errorf("summary should name the file base: %q", ev.Summary)
	}
}

func TestReplaceFileContentMapsToFileWithPath(t *testing.T) {
	ev := parse(t, "PreToolUse", fixture(t, "pre_tool_use_replace_file_content.json"))
	if ev.Category != event.CategoryFile {
		t.Errorf("category = %q, want file", ev.Category)
	}
	if ev.Payload["file_path"] != "/tmp/agent-firehose-agy-fixture/work/edited_file.go" {
		t.Errorf("file_path = %v", ev.Payload["file_path"])
	}
	if !strings.Contains(ev.Summary, "edited_file.go") {
		t.Errorf("summary should name the file base: %q", ev.Summary)
	}
}

func TestPostToolUseViewFileAndGrepSearchStaySafe(t *testing.T) {
	view := parse(t, "PostToolUse", fixture(t, "post_tool_use_view_file.json"))
	if view.Category != event.CategoryFile || view.Payload["status"] != "success" {
		t.Errorf("post view_file = %q/%v", view.Category, view.Payload["status"])
	}
	grep := parse(t, "PostToolUse", fixture(t, "post_tool_use_grep_search.json"))
	if grep.Category != event.CategoryTool || grep.Payload["status"] != "success" {
		t.Errorf("post grep_search = %q/%v", grep.Category, grep.Payload["status"])
	}
}

func TestPreToolUseListDirIsPlainTool(t *testing.T) {
	ev := parse(t, "PreToolUse", fixture(t, "pre_tool_use_list_dir.json"))
	if ev.Category != event.CategoryTool {
		t.Errorf("category = %q, want tool", ev.Category)
	}
	if _, ok := ev.Payload["file_path"]; ok {
		t.Errorf("list_dir must not surface its DirectoryPath arg: %+v", ev.Payload)
	}
}

func TestPostToolUseSuccessOutcomes(t *testing.T) {
	for _, tt := range []struct {
		fixture  string
		category event.Category
		name     string
	}{
		{"post_tool_use_run_command.json", event.CategoryShell, "PostToolUse:run_command"},
		{"post_tool_use_list_dir.json", event.CategoryTool, "PostToolUse:list_dir"},
	} {
		ev := parse(t, "PostToolUse", fixture(t, tt.fixture))
		if ev.Category != tt.category || ev.Name != tt.name {
			t.Errorf("%s: category/name = %q/%q", tt.fixture, ev.Category, ev.Name)
		}
		if ev.Payload["phase"] != "end" || ev.Payload["status"] != "success" {
			t.Errorf("%s: outcome = %+v", tt.fixture, ev.Payload)
		}
		if ev.Severity != event.SeverityInfo {
			t.Errorf("%s: severity = %q", tt.fixture, ev.Severity)
		}
	}
}

func TestPostToolUseWithErrorIsWarnLevelWithoutLeakingText(t *testing.T) {
	// An error-populated PostToolUse has not been observed in the wild: agy
	// 1.1.10 left `error` empty even for a failing command (testdata README).
	// This case substitutes a value into the real fixture's existing empty
	// `error` field — the same value-only sanitization the README documents —
	// without inventing any field or shape.
	raw := strings.Replace(
		fixture(t, "post_tool_use_run_command.json"),
		`"error": ""`,
		`"error": "SECRET-ERROR-MARKER"`,
		1,
	)
	if !strings.Contains(raw, "SECRET-ERROR-MARKER") {
		t.Fatal("fixture error field substitution failed")
	}
	ev := parse(t, "PostToolUse", raw)
	if ev.Payload["phase"] != "end" || ev.Payload["status"] != "error" {
		t.Errorf("outcome = %+v", ev.Payload)
	}
	// A single failing tool is warn-level, matching the other adapters; it
	// must not flip the whole session's error overlay.
	if ev.Severity != event.SeverityWarn {
		t.Errorf("severity = %q, want warn", ev.Severity)
	}
	if strings.Contains(safeDetails(t, ev), "SECRET-ERROR-MARKER") {
		t.Errorf("error text leaked into safe details: %s", safeDetails(t, ev))
	}
	if !strings.Contains(ev.Raw, "SECRET-ERROR-MARKER") {
		t.Error("raw must retain the original payload for full mode")
	}
}

func TestInvocationEventsAreMetaWithCounts(t *testing.T) {
	pre := parse(t, "PreInvocation", fixture(t, "pre_invocation.json"))
	post := parse(t, "PostInvocation", fixture(t, "post_invocation.json"))
	for _, tt := range []struct {
		ev      event.Event
		name    string
		summary string
	}{
		{pre, "PreInvocation", "model invocation 1 started"},
		{post, "PostInvocation", "model invocation 1 completed"},
	} {
		if tt.ev.Category != event.CategoryMeta {
			t.Errorf("%s category = %q, want meta", tt.name, tt.ev.Category)
		}
		if tt.ev.Name != tt.name {
			t.Errorf("name = %q, want %q", tt.ev.Name, tt.name)
		}
		if tt.ev.Summary != tt.summary {
			t.Errorf("summary = %q, want %q", tt.ev.Summary, tt.summary)
		}
		if got, ok := tt.ev.Payload["invocation_num"].(int64); !ok || got != 1 {
			t.Errorf("%s invocation_num = %v", tt.name, tt.ev.Payload["invocation_num"])
		}
		if got, ok := tt.ev.Payload["initial_num_steps"].(int64); !ok || got != 5 {
			t.Errorf("%s initial_num_steps = %v", tt.name, tt.ev.Payload["initial_num_steps"])
		}
	}
}

func TestStopIsSessionNoticeWithTerminationMetadata(t *testing.T) {
	ev := parse(t, "Stop", fixture(t, "stop.json"))
	if ev.Category != event.CategorySession {
		t.Errorf("category = %q, want session", ev.Category)
	}
	if ev.Severity != event.SeverityNotice {
		t.Errorf("severity = %q, want notice", ev.Severity)
	}
	if ev.Name != "Stop" {
		t.Errorf("name = %q", ev.Name)
	}
	if ev.Payload["termination_reason"] != "NO_TOOL_CALL" {
		t.Errorf("termination_reason = %v", ev.Payload["termination_reason"])
	}
	if ev.Payload["fully_idle"] != true {
		t.Errorf("fully_idle = %v", ev.Payload["fully_idle"])
	}
}

func TestStopWithErrorBecomesErrorEventWithoutLeakingText(t *testing.T) {
	// Same value-only substitution note as the PostToolUse error test: an
	// error-populated Stop remains uncaptured in the wild (testdata README).
	raw := strings.Replace(
		fixture(t, "stop.json"),
		`"error": ""`,
		`"error": "SECRET-ERROR-MARKER"`,
		1,
	)
	if !strings.Contains(raw, "SECRET-ERROR-MARKER") {
		t.Fatal("fixture error field substitution failed")
	}
	ev := parse(t, "Stop", raw)
	if ev.Category != event.CategoryError {
		t.Errorf("category = %q, want error", ev.Category)
	}
	if ev.Severity != event.SeverityError {
		t.Errorf("severity = %q, want error", ev.Severity)
	}
	if strings.Contains(safeDetails(t, ev), "SECRET-ERROR-MARKER") {
		t.Errorf("error text leaked into safe details: %s", safeDetails(t, ev))
	}
	if !strings.Contains(ev.Raw, "SECRET-ERROR-MARKER") {
		t.Error("raw must retain the original payload for full mode")
	}
}

func TestSingleWorkspacePathBecomesCWDAndMultipleAreNeverJoined(t *testing.T) {
	// The fixtures were captured with an empty workspacePaths array; these
	// cases substitute values into that documented, existing field only.
	base := fixture(t, "pre_invocation.json")
	single := strings.Replace(base, `"workspacePaths": []`,
		`"workspacePaths": ["/tmp/agent-firehose-agy-fixture/work"]`, 1)
	multiple := strings.Replace(base, `"workspacePaths": []`,
		`"workspacePaths": ["/tmp/agent-firehose-agy-fixture/work", "/tmp/agent-firehose-agy-fixture/other"]`, 1)
	if single == base || multiple == base {
		t.Fatal("workspacePaths substitution failed")
	}
	if ev := parse(t, "PreInvocation", single); ev.CWD != "/tmp/agent-firehose-agy-fixture/work" {
		t.Errorf("single workspace path cwd = %q", ev.CWD)
	}
	if ev := parse(t, "PreInvocation", multiple); ev.CWD != "" {
		t.Errorf("multiple workspace paths must leave cwd empty, got %q", ev.CWD)
	}
}

func TestUnknownEventNameProducesBoundedDriftWarning(t *testing.T) {
	ev := parse(t, "Compress", fixture(t, "stop.json"))
	if ev.Name != "adapter.unknown_event" {
		t.Errorf("name = %q", ev.Name)
	}
	if ev.Category != event.CategoryMeta || ev.Severity != event.SeverityWarn {
		t.Errorf("unexpected drift envelope: %+v", ev)
	}
	if ev.Payload["native_event_name"] != "Compress" {
		t.Errorf("native_event_name = %v", ev.Payload["native_event_name"])
	}
	if ev.Payload["source"] != "antigravity" || ev.Payload["transport"] != "hook" {
		t.Errorf("drift identity = %+v", ev.Payload)
	}
	if ev.SessionID != fixtureConversationID {
		t.Errorf("drift warning lost session correlation: %q", ev.SessionID)
	}
}

func TestEmptyEventNameIsAnError(t *testing.T) {
	if _, err := Parse("", []byte(fixture(t, "stop.json"))); err == nil {
		t.Fatal("Parse with no event name must fail: payloads carry no event-name field")
	}
}

func TestMalformedPayloadIsAnError(t *testing.T) {
	if _, err := Parse("PostToolUse", []byte("not json")); err == nil {
		t.Fatal("Parse must reject malformed JSON")
	}
}

// TestNoFixtureLeaksSecretsOrInternalStorePaths is the privacy-negative
// gate: sanitized secret markers and the artifactDirectoryPath /
// transcriptPath pointers into Antigravity's internal brain/ store must
// never reach Summary or Payload, while Raw retains the original payload for
// the full-mode contract.
func TestNoFixtureLeaksSecretsOrInternalStorePaths(t *testing.T) {
	for fixtureName, eventName := range fixtureEvents {
		t.Run(fixtureName, func(t *testing.T) {
			raw := fixture(t, fixtureName)
			ev := parse(t, eventName, raw)
			safe := safeDetails(t, ev)
			if strings.Contains(safe, "SECRET-") {
				t.Errorf("safe details leaked a sanitized secret: %s", safe)
			}
			if strings.Contains(safe, fixtureBrainDir) {
				t.Errorf("safe details leaked an internal-store path: %s", safe)
			}
			if strings.Contains(safe, "transcript_full.jsonl") {
				t.Errorf("safe details leaked the transcript path: %s", safe)
			}
			if strings.Contains(ev.Summary, fixtureConversationID) {
				t.Errorf("summary leaked the conversation id: %q", ev.Summary)
			}
			if !strings.Contains(ev.Raw, fixtureBrainDir) || !strings.Contains(ev.Raw, "transcript_full.jsonl") {
				t.Errorf("raw must retain the internal-store pointers for full mode: %q", ev.Raw)
			}
		})
	}
}

// A file tool whose allowlisted path arg is missing or not a string must not
// emit an empty file_path (which would pollute the artifacts/files view) or a
// summary naming "." from filepath.Base("").
func TestFileToolWithoutPathArgFallsBackToPlainToolShape(t *testing.T) {
	ev := parse(t, "PreToolUse", `{"conversationId":"aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb","toolCall":{"name":"view_file","args":{}},"stepIdx":1,"workspacePaths":[]}`)
	if _, ok := ev.Payload["file_path"]; ok {
		t.Errorf("empty path must not enter payload: %+v", ev.Payload)
	}
	if strings.Contains(ev.Summary, " on .") {
		t.Errorf("summary names filepath.Base of empty path: %q", ev.Summary)
	}
	if ev.Category != event.CategoryFile {
		t.Errorf("category = %q, want file (tool identity is still known)", ev.Category)
	}
}
