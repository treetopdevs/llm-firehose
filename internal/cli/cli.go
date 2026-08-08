// Package cli implements the firehose subcommands (emit, ingest, export,
// install, doctor) as testable functions; cmd/firehose only parses flags.
package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"agentfirehose/internal/adapters/antigravity"
	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/adapters/codexhook"
	"agentfirehose/internal/adapters/generic"
	"agentfirehose/internal/adapters/opencode"
	"agentfirehose/internal/client"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
)

// DefaultDaemonAddr is where the local daemon listens unless configured.
const DefaultDaemonAddr = "127.0.0.1:4517"

// Config is the on-disk configuration (~/.agentfirehose/config.json).
type Config struct {
	SpoolDir    string `json:"spool_dir,omitempty"`
	PrivacyMode string `json:"privacy_mode,omitempty"`
	CodexDir    string `json:"codex_sessions_dir,omitempty"`
	DaemonAddr  string `json:"daemon_addr,omitempty"`
}

// LoadConfig reads config.json under home, filling defaults.
func LoadConfig(home string) (Config, error) {
	cfg := Config{
		SpoolDir:    filepath.Join(home, ".agentfirehose", "spool"),
		PrivacyMode: string(privacy.ModeBalanced),
		CodexDir:    filepath.Join(home, ".codex", "sessions"),
		DaemonAddr:  DefaultDaemonAddr,
	}
	data, err := os.ReadFile(filepath.Join(home, ".agentfirehose", "config.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	var file Config
	if err := json.Unmarshal(data, &file); err != nil {
		return cfg, fmt.Errorf("config.json: %w", err)
	}
	if file.SpoolDir != "" {
		cfg.SpoolDir = file.SpoolDir
	}
	if file.PrivacyMode != "" {
		cfg.PrivacyMode = file.PrivacyMode
	}
	if file.CodexDir != "" {
		cfg.CodexDir = file.CodexDir
	}
	if file.DaemonAddr != "" {
		cfg.DaemonAddr = file.DaemonAddr
	}
	return cfg, nil
}

// SaveConfig validates cfg and writes it to config.json under home.
func SaveConfig(home string, cfg Config) error {
	if _, err := privacy.ParseMode(cfg.PrivacyMode); err != nil {
		return err
	}
	dir := filepath.Join(home, ".agentfirehose")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "config.json"), append(data, '\n'), 0o600)
}

func (c Config) mode() privacy.Mode {
	m, err := privacy.ParseMode(c.PrivacyMode)
	if err != nil {
		return privacy.ModeBalanced
	}
	return m
}

// Emit reads one raw payload from r and hands it to the running daemon so the
// engine owns all spool writes. When no daemon is reachable it falls back to
// appending locally, so capture never depends on the daemon being up.
func Emit(cfg Config, source string, r io.Reader) error {
	return EmitNamed(cfg, source, "", r)
}

// EmitNamed is Emit carrying an explicit native event name for sources whose
// payloads do not name their own event (Antigravity hook payloads carry no
// event-name field). Other sources ignore eventName.
func EmitNamed(cfg Config, source, eventName string, r io.Reader) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if daemonRouteAllowed(cfg.DaemonAddr) {
		err := client.New("http://"+cfg.DaemonAddr).EmitNamed(source, eventName, bytes.NewReader(raw))
		var transport *url.Error
		if !errors.As(err, &transport) {
			return err // nil on success; daemon rejections surface as-is
		}
	}
	return EmitLocalNamed(cfg, source, eventName, raw)
}

// daemonRouteAllowed reports whether the configured daemon address may
// receive raw pre-redaction payloads. Only loopback qualifies: the daemon
// speaks unauthenticated cleartext HTTP, so a remote daemon_addr — however it
// got into config.json — must never see hook payloads. Rejected addresses
// fall back to direct local spool writes, so capture is preserved.
func daemonRouteAllowed(addr string) bool {
	if addr == "" {
		return false
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// EmitLocal normalizes one raw payload for source, applies the configured
// privacy mode, and appends it directly to the spool. A payload the adapter
// deliberately skips is not an error. The daemon uses this path; everything
// else should call Emit.
func EmitLocal(cfg Config, source string, raw []byte) error {
	return EmitLocalNamed(cfg, source, "", raw)
}

// EmitLocalNamed is EmitLocal with the explicit native event name required by
// sources whose payloads carry none (see EmitNamed).
func EmitLocalNamed(cfg Config, source, eventName string, raw []byte) error {
	var ev *event.Event
	switch source {
	case antigravity.Source:
		parsed, err := antigravity.Parse(eventName, raw)
		if err != nil {
			return err
		}
		ev = parsed
	case claudecode.Source:
		parsed, err := claudecode.Parse(raw)
		if err != nil {
			return err
		}
		ev = parsed // nil = deliberately filtered
	case opencode.Source:
		parsed, err := opencode.Parse(raw)
		if err != nil {
			return err
		}
		ev = parsed // nil = skipped
	case codexhook.Source:
		parsed, err := codexhook.Parse(raw)
		if err != nil {
			return err
		}
		ev = &parsed
	default:
		parsed, err := generic.Parse(raw)
		if err != nil {
			return err
		}
		ev = &parsed
	}
	if ev == nil {
		return nil
	}
	redacted := privacy.Redact(*ev, cfg.mode())
	return spool.NewWriter(cfg.SpoolDir).Append(redacted)
}

// HookForward captures a hook observation without ever influencing the agent
// session. It always writes the neutral hook response and returns success,
// even when parsing, daemon delivery, or fallback persistence fails.
// eventName is required for sources whose payloads carry no event-name field
// (antigravity) and ignored by every other source.
func HookForward(cfg Config, source, eventName string, r io.Reader, w io.Writer) error {
	if err := EmitNamed(cfg, source, eventName, r); err != nil {
		reportHookCaptureError(cfg, source, err)
	}
	_, _ = io.WriteString(w, "{}\n")
	return nil
}

// RunHookForwardCommand parses the shared hook command and keeps every
// failure—including invalid flags, config errors, and malformed payloads—
// observational. Both distributed binaries use this exact entrypoint.
func RunHookForwardCommand(home string, args []string, r io.Reader, w io.Writer) {
	if home == "" {
		_, _ = io.WriteString(w, "{}\n")
		return
	}
	fs := flag.NewFlagSet("hook-forward", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	source := fs.String("source", codexhook.Source, "source adapter")
	eventName := fs.String("event", "", "native hook event name (required for --source antigravity, ignored otherwise)")
	flagErr := fs.Parse(args)
	cfg, configErr := LoadConfig(home)
	if flagErr != nil {
		reportHookCaptureError(cfg, *source, fmt.Errorf("hook flags: %w", flagErr))
	}
	if configErr != nil {
		// A malformed config still returns safe path defaults. Avoid routing
		// through an address we could not successfully load and persist both
		// the warning and hook locally instead.
		cfg.DaemonAddr = ""
		reportHookCaptureError(cfg, *source, fmt.Errorf("load config: %w", configErr))
	}
	// A missing --event for antigravity fails inside Parse and is captured as
	// a safe hook_capture_error warning; the neutral "{}" is still written.
	_ = HookForward(cfg, *source, *eventName, r, w)
}

func reportHookCaptureError(cfg Config, source string, captureErr error) {
	_ = spool.NewWriter(cfg.SpoolDir).Append(event.Event{
		ID:       event.NewID(),
		Time:     time.Now().UTC(),
		Source:   "firehose",
		Category: event.CategoryMeta,
		Name:     "hook_capture_error",
		Severity: event.SeverityWarn,
		Summary:  "Adapter hook capture warning: " + captureErr.Error(),
		Payload: map[string]any{
			"adapter_source": source,
			"status":         "error",
		},
	})
}

// Ingest streams NDJSON lines from r into the spool, returning how many
// events were written. Unparseable lines are counted as parse-error events.
func Ingest(cfg Config, r io.Reader) (int, error) {
	w := spool.NewWriter(cfg.SpoolDir)
	mode := cfg.mode()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	n := 0
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		ev, err := generic.Parse(line)
		if err != nil {
			continue
		}
		if err := w.Append(privacy.Redact(ev, mode)); err != nil {
			return n, err
		}
		n++
	}
	return n, sc.Err()
}

// ExportVersion identifies the export format: NDJSON of schema-versioned
// event envelopes, one per line, oldest first.
const ExportVersion = 1

// Export writes all spooled events to w as NDJSON, returning the count.
func Export(cfg Config, w io.Writer) (int, error) {
	evs, err := spool.ReadLastN(cfg.SpoolDir, 1<<31-1)
	if err != nil {
		return 0, err
	}
	enc := json.NewEncoder(w)
	for i, ev := range evs {
		if err := enc.Encode(ev); err != nil {
			return i, err
		}
	}
	return len(evs), nil
}
