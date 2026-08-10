// Package claudeotel maps Claude Code's opt-in OTLP/HTTP JSON logs and
// metrics into privacy-bounded Firehose events. Raw OTLP is never retained:
// Claude includes identity attributes and may emit content-shaped fields even
// when content telemetry settings are not enabled.
package claudeotel

import (
	"encoding/json"
	"strconv"
	"time"

	"agentfirehose/internal/capturemeta"
	"agentfirehose/internal/event"
)

const (
	Source                 = "claude-code"
	Transport              = "otel-http"
	maxAttributesPerRecord = 64
	maxStringValue         = 512
	maxRecordsPerBatch     = 256
)

// Manifest contains only native names proven by the sanitized capture
// records checked into testdata (see testdata/README.md). Further names
// observed in genuine Claude Code 2.1.218 batches (assistant_response, the
// hook/mcp/plugin lifecycle events, tool_decision, and the active_time/
// session.count metrics) had their captured evidence discarded during
// sanitization and stay out of the manifest until a sanitized record lands;
// until then they surface as bounded unknown-event drift warnings.
var Manifest = capturemeta.Manifest{
	Source:    Source,
	Transport: Transport,
	Fidelity:  capturemeta.SupportedPassiveStream,
	Mapped: []string{
		"api_request",
		"tool_result",
		"user_prompt",
		"claude_code.cost.usage",
		"claude_code.token.usage",
	},
	SourceSchema: "claude-code-otel@2.1.218",
}

type scope struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type anyValue struct {
	StringValue string   `json:"stringValue"`
	BoolValue   *bool    `json:"boolValue"`
	IntValue    *int64   `json:"intValue"`
	DoubleValue *float64 `json:"doubleValue"`
}

type attribute struct {
	Key   string   `json:"key"`
	Value anyValue `json:"value"`
}

type logRecord struct {
	TimeUnixNano string      `json:"timeUnixNano"`
	Attributes   []attribute `json:"attributes"`
}

type logsBatch struct {
	ResourceLogs []struct {
		ScopeLogs []struct {
			Scope      scope             `json:"scope"`
			LogRecords []json.RawMessage `json:"logRecords"`
		} `json:"scopeLogs"`
	} `json:"resourceLogs"`
}

type metricPoint struct {
	TimeUnixNano string      `json:"timeUnixNano"`
	Attributes   []attribute `json:"attributes"`
	AsDouble     *float64    `json:"asDouble"`
	AsInt        *int64      `json:"asInt"`
}

type metric struct {
	Name string `json:"name"`
	Unit string `json:"unit"`
	Sum  struct {
		DataPoints []json.RawMessage `json:"dataPoints"`
	} `json:"sum"`
	Gauge struct {
		DataPoints []json.RawMessage `json:"dataPoints"`
	} `json:"gauge"`
}

type metricsBatch struct {
	ResourceMetrics []struct {
		ScopeMetrics []struct {
			Scope   scope    `json:"scope"`
			Metrics []metric `json:"metrics"`
		} `json:"scopeMetrics"`
	} `json:"resourceMetrics"`
}

var logPayloadAllowlist = map[string]string{
	"client_request_id":      "client_request_id",
	"model":                  "model",
	"query_source":           "query_source",
	"error_code":             "error_code",
	"duration_ms":            "duration_ms",
	"total_duration_ms":      "total_duration_ms",
	"tool_name":              "tool_name",
	"tool_source":            "tool_source",
	"success":                "success",
	"status":                 "status",
	"decision":               "decision",
	"source":                 "decision_source",
	"tool_input_size_bytes":  "tool_input_size_bytes",
	"tool_result_size_bytes": "tool_result_size_bytes",
	"input_tokens":           "input_tokens",
	"output_tokens":          "output_tokens",
	"cache_read_tokens":      "cache_read_tokens",
	"cache_creation_tokens":  "cache_creation_tokens",
	"cost_usd":               "cost_usd",
	"cost_usd_micros":        "cost_usd_micros",
	"hook_event":             "hook_event",
	"hook_type":              "hook_type",
	"num_hooks":              "num_hooks",
	"num_success":            "num_success",
	"num_non_blocking_error": "num_non_blocking_error",
	"num_cancelled":          "num_cancelled",
	"num_blocking":           "num_blocking",
	"managed_only":           "managed_only",
	"safe_mode":              "safe_mode",
	"effort":                 "effort",
	"speed":                  "speed",
	"plugin.name":            "plugin_name",
	"plugin.scope":           "plugin_scope",
	"marketplace.name":       "marketplace_name",
	"has_hooks":              "has_hooks",
	"has_mcp":                "has_mcp",
	"host_owned_mcp":         "host_owned_mcp",
	"skill_path_count":       "skill_path_count",
	"command_path_count":     "command_path_count",
	"agent_path_count":       "agent_path_count",
	"server_scope":           "server_scope",
	"transport_type":         "transport_type",
	"is_plugin":              "is_plugin",
	"response_length":        "response_length",
}

var metricAttributeAllowlist = map[string]string{
	"model":        "model",
	"query_source": "query_source",
	"effort":       "effort",
	"type":         "type",
	"start_type":   "start_type",
}

// ParseLogs maps each well-formed record independently and emits bounded
// warnings for malformed or over-limit records.
func ParseLogs(raw []byte, captured time.Time) []event.Event {
	var batch logsBatch
	if err := json.Unmarshal(raw, &batch); err != nil {
		return []event.Event{parseWarning("logs", captured)}
	}
	var out []event.Event
	seen := 0
	for _, resource := range batch.ResourceLogs {
		for _, scoped := range resource.ScopeLogs {
			for _, encoded := range scoped.LogRecords {
				if seen >= maxRecordsPerBatch {
					out = append(out, parseWarning("logs", captured))
					return out
				}
				seen++
				var record logRecord
				if err := json.Unmarshal(encoded, &record); err != nil {
					out = append(out, parseWarning("logs", captured))
					continue
				}
				attrs, ok := attributes(record.Attributes)
				if !ok {
					out = append(out, parseWarning("logs", captured))
					continue
				}
				out = append(out, mapLog(attrs, record.TimeUnixNano, scoped.Scope, captured))
			}
		}
	}
	return out
}

// ParseMetrics maps each OTLP sum/gauge data point independently.
func ParseMetrics(raw []byte, captured time.Time) []event.Event {
	var batch metricsBatch
	if err := json.Unmarshal(raw, &batch); err != nil {
		return []event.Event{parseWarning("metrics", captured)}
	}
	var out []event.Event
	seen := 0
	for _, resource := range batch.ResourceMetrics {
		for _, scoped := range resource.ScopeMetrics {
			for _, native := range scoped.Metrics {
				points := append(append([]json.RawMessage{}, native.Sum.DataPoints...), native.Gauge.DataPoints...)
				for _, encoded := range points {
					if seen >= maxRecordsPerBatch {
						out = append(out, parseWarning("metrics", captured))
						return out
					}
					seen++
					var point metricPoint
					if err := json.Unmarshal(encoded, &point); err != nil {
						out = append(out, parseWarning("metrics", captured))
						continue
					}
					attrs, ok := attributes(point.Attributes)
					if !ok {
						out = append(out, parseWarning("metrics", captured))
						continue
					}
					out = append(out, mapMetric(native, point, attrs, scoped.Scope, captured))
				}
			}
		}
	}
	return out
}

func mapLog(attrs map[string]any, sourceNano string, nativeScope scope, captured time.Time) event.Event {
	name := stringAttribute(attrs, "event.name")
	if !manifestContains(name) {
		warning := capturemeta.UnknownEvent(
			Source,
			Transport,
			name,
			bounded(nativeScope.Version),
			"native OTel event is not present in the Claude OTel manifest",
			captured,
		)
		warning.Agent = "claude"
		warning.SessionID = stringAttribute(attrs, "session.id")
		return warning
	}
	ev := baseEvent(name, sourceNano, nativeScope, captured)
	ev.SessionID = stringAttribute(attrs, "session.id")
	ev.PromptID = stringAttribute(attrs, "prompt.id")
	ev.MessageID = stringAttribute(attrs, "message.uuid")
	ev.CallID = stringAttribute(attrs, "tool_use_id")
	ev.RequestID = stringAttribute(attrs, "request_id")
	if sequence, ok := attrs["event.sequence"].(int64); ok {
		ev.Sequence = &sequence
	}
	for source, destination := range logPayloadAllowlist {
		if value, ok := attrs[source]; ok {
			ev.Payload[destination] = value
		}
	}
	switch name {
	case "user_prompt":
		ev.Category = event.CategoryPrompt
	case "assistant_response":
		ev.Category = event.CategoryMessage
	case "tool_decision", "tool_result":
		ev.Category = event.CategoryTool
	case "api_request", "hook_execution_start", "hook_execution_complete",
		"hook_registered", "mcp_server_connection", "plugin_loaded":
		ev.Category = event.CategoryMeta
	default:
		ev.Category = event.CategoryMeta
	}
	if name == "tool_result" && isFalse(attrs["success"]) {
		ev.Severity = event.SeverityWarn
	}
	return ev
}

func mapMetric(native metric, point metricPoint, attrs map[string]any, nativeScope scope, captured time.Time) event.Event {
	if !manifestContains(native.Name) {
		warning := capturemeta.UnknownEvent(
			Source,
			Transport,
			native.Name,
			bounded(nativeScope.Version),
			"native OTel metric is not present in the Claude OTel manifest",
			captured,
		)
		warning.Agent = "claude"
		warning.SessionID = stringAttribute(attrs, "session.id")
		return warning
	}
	ev := baseEvent(native.Name, point.TimeUnixNano, nativeScope, captured)
	ev.Category = event.CategoryMeta
	ev.SessionID = stringAttribute(attrs, "session.id")
	ev.Payload["unit"] = bounded(native.Unit)
	switch {
	case point.AsDouble != nil:
		ev.Payload["value"] = *point.AsDouble
	case point.AsInt != nil:
		ev.Payload["value"] = *point.AsInt
	default:
		ev.Payload["value"] = float64(0)
	}
	for source, destination := range metricAttributeAllowlist {
		if value, ok := attrs[source]; ok {
			ev.Payload[destination] = value
		}
	}
	return ev
}

func baseEvent(name, sourceNano string, nativeScope scope, captured time.Time) event.Event {
	ev := event.Event{
		ID:            event.NewID(),
		Time:          captured,
		CaptureTime:   timePointer(captured),
		Source:        Source,
		Agent:         "claude",
		Transport:     Transport,
		SourceVersion: bounded(nativeScope.Version),
		Name:          bounded(name),
		Severity:      event.SeverityInfo,
		Summary:       "Claude telemetry: " + bounded(name),
		Payload:       map[string]any{},
	}
	if parsed, ok := parseUnixNano(sourceNano); ok {
		ev.SourceTime = &parsed
	}
	return ev
}

func parseWarning(signal string, captured time.Time) event.Event {
	return event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: timePointer(captured),
		Source:      Source,
		Agent:       "claude",
		Transport:   Transport,
		Category:    event.CategoryMeta,
		Name:        "otel.parse_warning",
		Severity:    event.SeverityWarn,
		Summary:     "Claude OTel record skipped: malformed or over limit",
		Payload:     map[string]any{"signal": signal},
	}
}

func attributes(native []attribute) (map[string]any, bool) {
	if len(native) > maxAttributesPerRecord {
		return nil, false
	}
	out := make(map[string]any, len(native))
	for _, attr := range native {
		if attr.Key == "" || len(attr.Key) > 128 {
			continue
		}
		switch {
		case attr.Value.StringValue != "":
			out[attr.Key] = bounded(attr.Value.StringValue)
		case attr.Value.BoolValue != nil:
			out[attr.Key] = *attr.Value.BoolValue
		case attr.Value.IntValue != nil:
			out[attr.Key] = *attr.Value.IntValue
		case attr.Value.DoubleValue != nil:
			out[attr.Key] = *attr.Value.DoubleValue
		}
	}
	return out, true
}

func parseUnixNano(raw string) (time.Time, bool) {
	nanos, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(0, nanos).UTC(), true
}

func stringAttribute(attrs map[string]any, key string) string {
	value, _ := attrs[key].(string)
	return bounded(value)
}

func bounded(value string) string {
	runes := []rune(value)
	if len(runes) > maxStringValue {
		return string(runes[:maxStringValue])
	}
	return value
}

func manifestContains(name string) bool {
	for _, mapped := range Manifest.Mapped {
		if mapped == name {
			return true
		}
	}
	return false
}

func isFalse(value any) bool {
	switch typed := value.(type) {
	case bool:
		return !typed
	case string:
		parsed, err := strconv.ParseBool(typed)
		return err == nil && !parsed
	}
	return false
}

func timePointer(value time.Time) *time.Time {
	copy := value
	return &copy
}
