// Package cli implements the firehose subcommands (emit, ingest, export,
// install, doctor) as testable functions; cmd/firehose only parses flags.
package cli

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"time"

	"agentfirehose/internal/adapters/codexhook"
	"agentfirehose/internal/adapters/generic"
	"agentfirehose/internal/adapters/push"
	"agentfirehose/internal/capture"
	"agentfirehose/internal/client"
	"agentfirehose/internal/config"
	"agentfirehose/internal/event"
)

// Emit reads one raw payload from r and hands it to the running daemon so the
// engine owns all spool writes. When no daemon is reachable it falls back to
// appending locally, so capture never depends on the daemon being up.
func Emit(cfg config.Config, source string, r io.Reader) error {
	return EmitNamed(cfg, source, "", r)
}

// EmitNamed is Emit carrying an explicit native event name for sources whose
// payloads do not name their own event (Antigravity hook payloads carry no
// event-name field). Other sources ignore eventName.
func EmitNamed(cfg config.Config, source, eventName string, r io.Reader) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if daemonRouteAllowed(cfg.DaemonAddr) {
		err := client.New("http://"+cfg.DaemonAddr).EmitNamed(context.Background(), source, eventName, bytes.NewReader(raw))
		var transport *url.Error
		var response *client.HTTPError
		if err == nil {
			return nil
		}
		if !errors.As(err, &transport) && !(errors.As(err, &response) && response.StatusCode >= 500) {
			return err // daemon parse/validation rejections never trigger a second write
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
func EmitLocal(cfg config.Config, source string, raw []byte) error {
	return EmitLocalNamed(cfg, source, "", raw)
}

// EmitLocalNamed is EmitLocal with the explicit native event name required by
// sources whose payloads carry none (see EmitNamed).
func EmitLocalNamed(cfg config.Config, source, eventName string, raw []byte) error {
	ev, err := push.Parse(source, eventName, raw)
	if err != nil {
		return err
	}
	if ev == nil {
		return nil
	}
	_, err = capture.AdmitOnce(context.Background(), capture.OneShotOptions{
		SpoolDir: cfg.SpoolDir,
		Policy:   cfg.Mode(),
	}, *ev)
	return err
}

// HookForward captures a hook observation without ever influencing the agent
// session. It always writes the neutral hook response and returns success,
// even when parsing, daemon delivery, or fallback persistence fails.
// eventName is required for sources whose payloads carry no event-name field
// (antigravity) and ignored by every other source.
func HookForward(cfg config.Config, source, eventName string, r io.Reader, w io.Writer) error {
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
	cfg, configErr := config.Load(home)
	if configErr != nil {
		// A malformed config still returns safe path defaults. Avoid routing
		// through an address we could not successfully load and persist both
		// the warning and hook locally instead.
		cfg.DaemonAddr = ""
		reportHookCaptureError(cfg, *source, fmt.Errorf("load config: %w", configErr))
	}
	if flagErr != nil {
		// Do not normalize with the default --source (codex-hook): an unknown
		// flag left the source unset by the caller, so treating the payload as
		// Codex would invent the wrong adapter mapping. Record the warning and
		// return the neutral hook response without forwarding.
		reportHookCaptureError(cfg, *source, fmt.Errorf("hook flags: %w", flagErr))
		_, _ = io.WriteString(w, "{}\n")
		return
	}
	// A missing --event for antigravity fails inside Parse and is captured as
	// a safe hook_capture_error warning; the neutral "{}" is still written.
	_ = HookForward(cfg, *source, *eventName, r, w)
}

func reportHookCaptureError(cfg config.Config, source string, captureErr error) {
	ev := event.Event{
		ID:       event.NewID(),
		Time:     time.Now().UTC(),
		Source:   "firehose",
		Category: event.CategoryMeta,
		Name:     "hook_capture_error",
		Severity: event.SeverityWarn,
		Summary:  source + " adapter hook capture warning",
		Payload: map[string]any{
			"adapter_source": source,
			"status":         "error",
			"error":          captureErr.Error(),
		},
	}
	_, _ = capture.AdmitOnce(context.Background(), capture.OneShotOptions{
		SpoolDir: cfg.SpoolDir,
		Policy:   cfg.Mode(),
	}, ev)
}

// Ingest streams NDJSON lines from r into the spool, returning how many
// events were written. Unparseable lines are counted as parse-error events.
func Ingest(cfg config.Config, r io.Reader) (int, error) {
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
		if _, err := capture.AdmitOnce(context.Background(), capture.OneShotOptions{
			SpoolDir: cfg.SpoolDir,
			Policy:   cfg.Mode(),
		}, ev); err != nil {
			return n, err
		}
		n++
	}
	return n, sc.Err()
}

// Export writes all spooled events to w as NDJSON, returning the count.
func Export(cfg config.Config, w io.Writer) (int, error) {
	return capture.ExportOnce(cfg.SpoolDir, w)
}
