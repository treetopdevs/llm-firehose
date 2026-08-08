package opencode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

const fixtureDir = "/tmp/agent-firehose-opencode-fixture/work"

func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return data
}

func parse(t *testing.T, raw string) *event.Event {
	t.Helper()
	ev, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if ev != nil {
		if ev.CaptureTime == nil || !ev.Time.Equal(*ev.CaptureTime) {
			t.Errorf("capture_time = %v, want the locally assigned event time %v", ev.CaptureTime, ev.Time)
		}
	}
	return ev
}

func parseFixture(t *testing.T, name string) *event.Event {
	t.Helper()
	return parse(t, string(loadFixture(t, name)))
}

// TestRealFixtureMapping drives every mapped family through the sanitized
// real OpenCode 1.18.10 bus captures in testdata (see its README for
// provenance). Payloads are compared exactly so accidental additions fail.
func TestRealFixtureMapping(t *testing.T) {
	cases := []struct {
		fixture   string
		category  event.Category
		name      string
		severity  event.Severity
		summary   string
		sessionID string
		messageID string
		parentID  string
		callID    string
		upstream  string
		sourceMS  int64 // 0 means no source timestamp observable
		version   string
		payload   map[string]any
	}{
		{
			fixture:   "session_created.json",
			category:  event.CategorySession,
			name:      "session.created",
			severity:  event.SeverityNotice,
			summary:   "session started",
			sessionID: "ses_fixture01",
			upstream:  "evt_fixture17",
			sourceMS:  1786151809107,
			version:   "1.18.10",
			payload: map[string]any{
				"agent":    "build",
				"model":    "mistralai/mistral-medium-3-5",
				"provider": "openrouter",
			},
		},
		{
			fixture:   "session_updated.json",
			category:  event.CategorySession,
			name:      "session.updated",
			severity:  event.SeverityInfo,
			summary:   "session updated",
			sessionID: "ses_fixture01",
			upstream:  "evt_fixture22",
			sourceMS:  1786152210807,
			version:   "1.18.10",
			payload: map[string]any{
				"agent":    "build",
				"model":    "mistralai/mistral-medium-3-5",
				"provider": "openrouter",
				"cost":     0.0728085,
				"tokens": map[string]any{
					"input": 30839.0, "output": 2445.0, "reasoning": 1095.0,
					"cache_read": 553984.0, "cache_write": 0.0,
				},
			},
		},
		{
			fixture:   "session_status_busy.json",
			category:  event.CategorySession,
			name:      "session.status",
			severity:  event.SeverityInfo,
			summary:   "session busy",
			sessionID: "ses_fixture01",
			upstream:  "evt_fixture20",
			payload:   map[string]any{"status": "busy"},
		},
		{
			fixture:   "session_status_idle.json",
			category:  event.CategorySession,
			name:      "session.status",
			severity:  event.SeverityInfo,
			summary:   "session idle",
			sessionID: "ses_fixture01",
			upstream:  "evt_fixture21",
			payload:   map[string]any{"status": "idle"},
		},
		{
			fixture:   "session_idle.json",
			category:  event.CategorySession,
			name:      "session.idle",
			severity:  event.SeverityInfo,
			summary:   "session idle",
			sessionID: "ses_fixture01",
			upstream:  "evt_fixture19",
			payload:   map[string]any{},
		},
		{
			fixture:   "session_diff.json",
			category:  event.CategorySession,
			name:      "session.diff",
			severity:  event.SeverityInfo,
			summary:   "session diff",
			sessionID: "ses_fixture01",
			upstream:  "evt_fixture18",
			payload:   map[string]any{"changed_files": 0},
		},
		{
			fixture:   "message_updated_user.json",
			category:  event.CategoryPrompt,
			name:      "message.updated",
			severity:  event.SeverityInfo,
			summary:   "user prompt",
			sessionID: "ses_fixture01",
			messageID: "msg_fixture04",
			upstream:  "evt_fixture08",
			sourceMS:  1786151809122,
			payload: map[string]any{
				"role":     "user",
				"agent":    "build",
				"model":    "mistralai/mistral-medium-3-5",
				"provider": "openrouter",
			},
		},
		{
			fixture:   "message_updated_assistant_started.json",
			category:  event.CategoryMessage,
			name:      "message.updated",
			severity:  event.SeverityInfo,
			summary:   "assistant message",
			sessionID: "ses_fixture01",
			messageID: "msg_fixture01",
			parentID:  "msg_fixture04",
			upstream:  "evt_fixture07",
			sourceMS:  1786151809141,
			payload: map[string]any{
				"role":     "assistant",
				"agent":    "build",
				"mode":     "build",
				"model":    "mistralai/mistral-medium-3-5",
				"provider": "openrouter",
			},
		},
		{
			fixture:   "message_updated_assistant_completed.json",
			category:  event.CategoryMessage,
			name:      "message.updated",
			severity:  event.SeverityInfo,
			summary:   "assistant message",
			sessionID: "ses_fixture01",
			messageID: "msg_fixture02",
			parentID:  "msg_fixture03",
			upstream:  "evt_fixture06",
			sourceMS:  1786152210801,
			payload: map[string]any{
				"role":     "assistant",
				"agent":    "build",
				"mode":     "build",
				"model":    "mistralai/mistral-medium-3-5",
				"provider": "openrouter",
				"finish":   "stop",
				"cost":     0.0004215,
				"tokens": map[string]any{
					"input": 126.0, "output": 31.0, "reasoning": 0.0,
					"cache_read": 29568.0, "cache_write": 0.0,
				},
			},
		},
		{
			fixture:   "part_step_finish.json",
			category:  event.CategoryMessage,
			name:      "step-finish",
			severity:  event.SeverityInfo,
			summary:   "assistant step finished",
			sessionID: "ses_fixture01",
			messageID: "msg_fixture01",
			upstream:  "evt_fixture11",
			sourceMS:  1786151819314,
			payload: map[string]any{
				"reason":   "tool-calls",
				"snapshot": "f1x70000000000000000000000000000000000ce",
				"cost":     0.0255645,
				"tokens": map[string]any{
					"input": 16338.0, "output": 53.0, "reasoning": 88.0,
					"cache_read": 0.0, "cache_write": 0.0,
				},
			},
		},
		{
			fixture:   "part_patch.json",
			category:  event.CategoryFile,
			name:      "patch",
			severity:  event.SeverityInfo,
			summary:   "patch applied",
			sessionID: "ses_fixture01",
			messageID: "msg_fixture05",
			upstream:  "evt_fixture09",
			sourceMS:  1786152025582,
			payload: map[string]any{
				"file_count": 1,
				"snapshot":   "f1x70000000000000000000000000000000000ce",
			},
		},
		{
			fixture:   "tool_completed_bash.json",
			category:  event.CategoryShell,
			name:      "tool:bash",
			severity:  event.SeverityInfo,
			summary:   "ran shell tool",
			sessionID: "ses_fixture01",
			messageID: "msg_fixture06",
			callID:    "call_fixture01",
			upstream:  "evt_fixture23",
			sourceMS:  1786152209026,
			payload: map[string]any{
				"tool_name":   "bash",
				"status":      "completed",
				"duration_ms": int64(2),
				"exit_code":   0,
			},
		},
		{
			fixture:   "tool_completed_edit.json",
			category:  event.CategoryFile,
			name:      "tool:edit",
			severity:  event.SeverityInfo,
			summary:   "edit SECRET-FILEPATH-MARKER",
			sessionID: "ses_fixture01",
			messageID: "msg_fixture05",
			callID:    "call_fixture02",
			upstream:  "evt_fixture24",
			sourceMS:  1786152025373,
			payload: map[string]any{
				"tool_name":   "edit",
				"status":      "completed",
				"duration_ms": int64(4),
				"file_path":   "SECRET-FILEPATH-MARKER",
			},
		},
		{
			fixture:   "tool_completed_glob.json",
			category:  event.CategoryTool,
			name:      "tool:glob",
			severity:  event.SeverityInfo,
			summary:   "tool: glob",
			sessionID: "ses_fixture01",
			messageID: "msg_fixture01",
			callID:    "call_fixture03",
			upstream:  "evt_fixture25",
			sourceMS:  1786151815563,
			payload: map[string]any{
				"tool_name":   "glob",
				"status":      "completed",
				"duration_ms": int64(66),
			},
		},
		{
			fixture:  "file_edited.json",
			category: event.CategoryFile,
			name:     "file.edited",
			severity: event.SeverityInfo,
			summary:  "edited SECRET-FILE-MARKER",
			upstream: "evt_fixture02",
			payload:  map[string]any{"file_path": "SECRET-FILE-MARKER"},
		},
		{
			fixture:  "file_watcher_updated.json",
			category: event.CategoryFile,
			name:     "file.watcher.updated",
			severity: event.SeverityInfo,
			summary:  "file change: SECRET-FILE-MARKER",
			upstream: "evt_fixture03",
			payload: map[string]any{
				"file_path":   "SECRET-FILE-MARKER",
				"change_type": "change",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			ev := parseFixture(t, tc.fixture)
			if ev == nil {
				t.Fatalf("fixture %s parsed to nil", tc.fixture)
			}
			if ev.Source != "opencode" || ev.Agent != "opencode" || ev.Transport != "plugin" {
				t.Errorf("identity wrong: source=%q agent=%q transport=%q", ev.Source, ev.Agent, ev.Transport)
			}
			if ev.CWD != fixtureDir {
				t.Errorf("cwd = %q, want plugin-injected directory %q", ev.CWD, fixtureDir)
			}
			if ev.Category != tc.category {
				t.Errorf("category = %q, want %q", ev.Category, tc.category)
			}
			if ev.Name != tc.name {
				t.Errorf("name = %q, want %q", ev.Name, tc.name)
			}
			if ev.Severity != tc.severity {
				t.Errorf("severity = %q, want %q", ev.Severity, tc.severity)
			}
			if ev.Summary != tc.summary {
				t.Errorf("summary = %q, want %q", ev.Summary, tc.summary)
			}
			if ev.SessionID != tc.sessionID {
				t.Errorf("session_id = %q, want %q", ev.SessionID, tc.sessionID)
			}
			if ev.MessageID != tc.messageID {
				t.Errorf("message_id = %q, want %q", ev.MessageID, tc.messageID)
			}
			if ev.ParentID != tc.parentID {
				t.Errorf("parent_id = %q, want %q", ev.ParentID, tc.parentID)
			}
			if ev.CallID != tc.callID {
				t.Errorf("call_id = %q, want %q", ev.CallID, tc.callID)
			}
			if ev.UpstreamEventID != tc.upstream {
				t.Errorf("upstream_event_id = %q, want %q", ev.UpstreamEventID, tc.upstream)
			}
			if ev.SourceVersion != tc.version {
				t.Errorf("source_version = %q, want %q", ev.SourceVersion, tc.version)
			}
			if tc.sourceMS == 0 {
				if ev.SourceTime != nil {
					t.Errorf("source_time = %v, want absent (payload carries no timestamp)", ev.SourceTime)
				}
			} else {
				want := time.UnixMilli(tc.sourceMS).UTC()
				if ev.SourceTime == nil || !ev.SourceTime.Equal(want) {
					t.Errorf("source_time = %v, want %v", ev.SourceTime, want)
				}
			}
			if !reflect.DeepEqual(ev.Payload, tc.payload) {
				t.Errorf("payload = %#v, want %#v", ev.Payload, tc.payload)
			}
			if !strings.Contains(ev.Raw, `"type"`) {
				t.Errorf("full-mode raw no longer retains source payload: %q", ev.Raw)
			}
		})
	}
}

// TestRealFixtureSkips proves streaming-frequency parts and the delta stream
// are deliberate skips (nil, nil), matching the plugin-side filter.
func TestRealFixtureSkips(t *testing.T) {
	skips := []string{
		"message_part_delta.json", // Manifest.Filtered streaming delta
		"part_text.json",          // streaming text part
		"part_reasoning.json",     // streaming reasoning part
		"part_step_start.json",    // per-step start marker; snapshot arrives on step-finish
		"tool_pending.json",       // non-terminal tool state
		"tool_running.json",       // non-terminal tool state
	}
	for _, fixture := range skips {
		t.Run(fixture, func(t *testing.T) {
			if ev := parseFixture(t, fixture); ev != nil {
				t.Fatalf("fixture %s should be a deliberate skip, got %+v", fixture, ev)
			}
		})
	}
}

// TestRealFixtureDriftWarnings proves the five unmapped bus families observed
// in the 1.18.10 capture parse into the bounded drift warning.
func TestRealFixtureDriftWarnings(t *testing.T) {
	drift := map[string]string{
		"plugin_added.json":                "plugin.added",
		"catalog_updated.json":             "catalog.updated",
		"integration_updated.json":         "integration.updated",
		"reference_updated.json":           "reference.updated",
		"project_directories_updated.json": "project.directories.updated",
	}
	for fixture, nativeType := range drift {
		t.Run(fixture, func(t *testing.T) {
			ev := parseFixture(t, fixture)
			if ev == nil || ev.Category != event.CategoryMeta || ev.Severity != event.SeverityWarn {
				t.Fatalf("unmapped type => %+v, want meta/warn", ev)
			}
			if ev.Name != "adapter.unknown_event" || ev.Transport != "plugin" {
				t.Errorf("drift warning shape wrong: %+v", ev)
			}
			if ev.Raw != "" {
				t.Errorf("drift warning must be content-free, raw = %q", ev.Raw)
			}
			if ev.Payload["native_event_name"] != nativeType {
				t.Errorf("native_event_name = %v, want %q", ev.Payload["native_event_name"], nativeType)
			}
			if ev.CWD != fixtureDir {
				t.Errorf("cwd = %q, want %q", ev.CWD, fixtureDir)
			}
		})
	}
}

// secretMarkers finds the sanitization markers embedded in a fixture.
// SECRET-FILE-MARKER and SECRET-FILEPATH-MARKER stand in for file paths,
// which are deliberately allowlisted payload/summary content for file events
// (the timeline shows "edited main.go"); every other marker replaces user or
// model content and must never leave full-mode raw.
var markerPattern = regexp.MustCompile(`SECRET-[A-Z]+-MARKER`)

var allowedPathMarkers = map[string]bool{
	"SECRET-FILE-MARKER":     true,
	"SECRET-FILEPATH-MARKER": true,
}

func TestNoFixtureSecretMarkerLeaksIntoSummaryOrPayload(t *testing.T) {
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		t.Run(entry.Name(), func(t *testing.T) {
			raw := loadFixture(t, entry.Name())
			markers := markerPattern.FindAllString(string(raw), -1)
			if len(markers) == 0 {
				t.Skip("fixture carries no secret markers")
			}
			ev := parse(t, string(raw))
			if ev == nil {
				return // deliberate skip: nothing persisted at all
			}
			payload, err := json.Marshal(ev.Payload)
			if err != nil {
				t.Fatal(err)
			}
			visible := ev.Summary + " " + string(payload)
			for _, marker := range markers {
				if allowedPathMarkers[marker] {
					continue
				}
				if strings.Contains(visible, marker) {
					t.Errorf("marker %s leaked into summary/payload: %s", marker, visible)
				}
			}
		})
	}
}

// --- Inherited mappings without a real capture (see testdata/README.md
// "Known gaps"). The inline payloads below are unproven inherited shapes
// awaiting a real capture; do not extend them.

func TestSessionError(t *testing.T) {
	// Unproven inherited shape awaiting real capture (session.error never
	// fired in the fixture session).
	ev := parse(t, `{"type":"session.error","properties":{"sessionID":"oc-1","error":{"name":"ProviderAuthError","data":{"message":"bad key"}}}}`)
	if ev == nil || ev.Category != event.CategoryError || ev.Severity != event.SeverityError {
		t.Fatalf("session.error => %+v, want error/error", ev)
	}
	if strings.Contains(ev.Summary, "bad key") {
		t.Fatalf("session error summary leaked provider body: %q", ev.Summary)
	}
}

func TestPermissionEvents(t *testing.T) {
	// Unproven inherited shapes awaiting real capture (the fixture session's
	// permission configuration auto-allowed all tools).
	ask := parse(t, `{"type":"permission.updated","properties":{"sessionID":"oc-1","title":"Run: rm -rf build","type":"bash"}}`)
	if ask == nil || ask.Category != event.CategoryPermission || ask.Severity != event.SeverityNotice {
		t.Fatalf("permission.updated => %+v", ask)
	}
	if strings.Contains(ask.Summary, "rm -rf") {
		t.Fatalf("permission summary leaked title: %q", ask.Summary)
	}
	reply := parse(t, `{"type":"permission.replied","properties":{"sessionID":"oc-1","response":"always"}}`)
	if reply == nil || reply.Category != event.CategoryPermission {
		t.Fatalf("permission.replied => %+v", reply)
	}
	if !strings.Contains(reply.Summary, "always") {
		t.Errorf("summary should include decision: %q", reply.Summary)
	}
}

func TestManifestFilteredBusTypesAreSkipped(t *testing.T) {
	for _, eventType := range Manifest.Filtered {
		t.Run(eventType, func(t *testing.T) {
			ev := parse(t, `{"type":"`+eventType+`","properties":{"secret":"SECRET-FILTERED"}}`)
			if ev != nil {
				t.Fatalf("filtered type produced event: %+v", ev)
			}
		})
	}
}

func TestManifestIsValid(t *testing.T) {
	if err := Manifest.Validate(); err != nil {
		t.Fatalf("manifest: %v", err)
	}
}

func TestEveryManifestMappedTypeHasAParserHandler(t *testing.T) {
	// Fixture-backed families load the sanitized real capture; the remaining
	// inline payloads are unproven inherited shapes awaiting real capture
	// (see testdata/README.md "Known gaps").
	fixtureFiles := map[string]string{
		"session.created":      "session_created.json",
		"session.updated":      "session_updated.json",
		"session.status":       "session_status_busy.json",
		"session.idle":         "session_idle.json",
		"session.diff":         "session_diff.json",
		"message.updated":      "message_updated_assistant_completed.json",
		"message.part.updated": "tool_completed_bash.json",
		"file.edited":          "file_edited.json",
		"file.watcher.updated": "file_watcher_updated.json",
	}
	inherited := map[string]string{
		"session.deleted":    `{"type":"session.deleted","properties":{"sessionID":"s1"}}`,
		"session.error":      `{"type":"session.error","properties":{"sessionID":"s1","error":{"name":"TestError"}}}`,
		"permission.updated": `{"type":"permission.updated","properties":{"sessionID":"s1"}}`,
		"permission.replied": `{"type":"permission.replied","properties":{"sessionID":"s1"}}`,
	}
	if len(fixtureFiles)+len(inherited) != len(Manifest.Mapped) {
		t.Fatalf("fixture count = %d, manifest mapped count = %d", len(fixtureFiles)+len(inherited), len(Manifest.Mapped))
	}
	for _, eventType := range Manifest.Mapped {
		t.Run(eventType, func(t *testing.T) {
			var raw string
			if file, ok := fixtureFiles[eventType]; ok {
				raw = string(loadFixture(t, file))
			} else if inline, ok := inherited[eventType]; ok {
				raw = inline
			} else {
				t.Fatalf("manifest type %q has no drift-guard fixture", eventType)
			}
			ev := parse(t, raw)
			if ev == nil || ev.Name == "adapter.unknown_event" {
				t.Fatalf("manifest type %q has no parser handler: %+v", eventType, ev)
			}
		})
	}
}
