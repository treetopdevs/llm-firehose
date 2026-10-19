// Command firehose is Agent Firehose: a live, structured timeline of AI
// coding-agent activity on your machine.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/client"
	"agentfirehose/internal/event"
	"agentfirehose/internal/host"
	"agentfirehose/internal/livesubscription"
	"agentfirehose/internal/tui"
)

// version is overridden at release time via -ldflags "-X main.version=...".
var version = "0.4.0"

const usage = `Agent Firehose %s — a live timeline of AI coding-agent activity.

Usage:
  firehose [view]              open the live TUI (default; uses the daemon when running)
  firehose daemon [--addr A]   run the capture engine and its local API
  firehose status              report whether the daemon is running
  firehose privacy [MODE]      show or set the privacy mode (minimal | balanced | full)
  firehose emit --source S     normalize one payload from stdin (via daemon when running)
                               (--event NAME names the hook event for antigravity)
  firehose ingest              stream NDJSON events from stdin into the spool
  firehose export [-o FILE]    dump captured events as NDJSON (default stdout)
  firehose hook-forward        fail-silent adapter hook capture
  firehose install AGENT       wire an adapter (claude-code | claude-otel [--forward|--replace] | codex | opencode | antigravity)
  firehose uninstall claude-otel  remove the OTLP block (restores a forwarded collector)
  firehose doctor              validate adapter wiring
  firehose version             print version
`

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hook-forward" {
		home, _ := os.UserHomeDir()
		cli.RunHookForwardCommand(home, os.Args[2:], os.Stdin, os.Stdout)
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fatal(err)
	}
	cfg, err := cli.LoadConfig(home)
	if err != nil {
		fatal(err)
	}

	args := os.Args[1:]
	cmd := "view"
	if len(args) > 0 {
		cmd = args[0]
		args = args[1:]
	}

	switch cmd {
	case "view":
		fatalIf(runView(cfg, home))
	case "daemon":
		fs := flag.NewFlagSet("daemon", flag.ExitOnError)
		addr := fs.String("addr", cfg.DaemonAddr, "listen address for the local API")
		fs.Parse(args)
		fatalIf(runDaemon(cfg, home, *addr))
	case "privacy":
		fatalIf(cli.Privacy(cfg, home, args, os.Stdout))
	case "status":
		if !cli.Status(cfg, os.Stdout) {
			os.Exit(1)
		}
	case "emit":
		fs := flag.NewFlagSet("emit", flag.ExitOnError)
		source := fs.String("source", "generic", "source adapter (claude-code | codex-hook | opencode | antigravity | generic)")
		eventName := fs.String("event", "", "native hook event name (required for antigravity, ignored otherwise)")
		fs.Parse(args)
		fatalIf(cli.EmitNamed(cfg, *source, *eventName, os.Stdin))
	case "ingest":
		n, err := cli.Ingest(cfg, os.Stdin)
		fatalIf(err)
		fmt.Fprintf(os.Stderr, "ingested %d events\n", n)
	case "export":
		fs := flag.NewFlagSet("export", flag.ExitOnError)
		out := fs.String("o", "", "output file (default stdout)")
		fs.Parse(args)
		w := os.Stdout
		if *out != "" {
			f, err := os.Create(*out)
			fatalIf(err)
			defer f.Close()
			w = f
		}
		n, err := cli.Export(cfg, w)
		fatalIf(err)
		fmt.Fprintf(os.Stderr, "exported %d events\n", n)
	case "install":
		var replace, forward bool
		if len(args) == 2 && args[0] == "claude-otel" {
			replace, forward = args[1] == "--replace", args[1] == "--forward"
		}
		if len(args) != 1 && !replace && !forward {
			fatal(fmt.Errorf("usage: firehose install <claude-code|claude-otel [--forward|--replace]|codex|opencode|antigravity>"))
		}
		bin, err := os.Executable()
		if err != nil {
			bin = "firehose"
		}
		switch args[0] {
		case "claude-code":
			fatalIf(cli.InstallClaudeCode(home, bin))
			fmt.Println("✓ hooks merged into ~/.claude/settings.json (backup: settings.json.bak)")
			fmt.Println("  restart running Claude Code sessions to pick them up")
		case "claude-otel":
			addr := cfg.DaemonAddr
			if addr == "" {
				addr = cli.DefaultDaemonAddr
			}
			backup, err := cli.InstallClaudeOTelWith(home, addr, os.Environ(), cli.ClaudeOTelOptions{Replace: replace, Forward: forward})
			fatalIf(err)
			fmt.Println("✓ supplemental Claude OTLP/HTTP JSON enabled for the local daemon")
			if kept, err := cli.LoadOTelForward(home); forward && err == nil && (kept.Logs != "" || kept.Metrics != "") {
				fmt.Println("  your existing collector keeps receiving telemetry through Firehose (undo: firehose uninstall claude-otel)")
			}
			if backup != "" {
				fmt.Printf("  previous settings backed up to %s\n", backup)
			}
			fmt.Println("  restart running Claude Code sessions to pick it up")
		case "opencode":
			path, err := cli.InstallOpenCode(home, bin)
			fatalIf(err)
			fmt.Printf("✓ plugin written to %s\n", path)
			fmt.Println("  restart OpenCode to load it")
		case "codex":
			fatalIf(cli.InstallCodex(home, bin))
			fmt.Println("✓ Codex hooks configured in ~/.codex/hooks.json (backup: hooks.json.bak)")
			fmt.Println("  open /hooks in Codex to review and trust them, then start a fresh task")
		case "antigravity":
			fatalIf(cli.InstallAntigravity(home, bin))
			fmt.Println("✓ Antigravity hooks merged into ~/.gemini/config/hooks.json (backup: hooks.json.bak)")
			fmt.Println("  post-only events (PostToolUse, PostInvocation, Stop); start a fresh agy conversation")
		default:
			fatal(fmt.Errorf("unknown adapter %q (want claude-code, claude-otel, codex, opencode, or antigravity)", args[0]))
		}
	case "uninstall":
		if len(args) != 1 || args[0] != "claude-otel" {
			fatal(fmt.Errorf("usage: firehose uninstall claude-otel"))
		}
		addr := cfg.DaemonAddr
		if addr == "" {
			addr = cli.DefaultDaemonAddr
		}
		fatalIf(cli.UninstallClaudeOTel(home, addr))
		fmt.Println("✓ Firehose's Claude OTLP settings removed (any forwarded collector restored)")
		fmt.Println("  restart running Claude Code sessions to pick it up")
	case "doctor":
		bad := 0
		for _, c := range cli.Doctor(cfg, home) {
			mark := "✓"
			if !c.OK {
				mark = "✗"
				bad++
			}
			fmt.Printf("%s %-18s %s\n", mark, c.Name, c.Detail)
		}
		if bad > 0 {
			os.Exit(1)
		}
	case "version":
		fmt.Println("firehose " + version)
	case "help", "-h", "--help":
		fmt.Printf(usage, version)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		fmt.Fprintf(os.Stderr, usage, version)
		os.Exit(2)
	}
}

// runDaemon runs the capture engine and its local API until interrupted.
func runDaemon(cfg cfgType, home, addr string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return host.RunDaemon(ctx, cfg, home, version, addr, func(bound string) {
		fmt.Fprintf(os.Stderr, "firehose daemon listening on %s (spool: %s)\n", bound, cfg.SpoolDir)
	})
}

// runView opens the TUI. When a daemon is running it is the single source of
// events; otherwise the viewer falls back to capturing directly.
func runView(cfg cfgType, home string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	events, history, sessions, err := viewFeed(ctx, cfg, home)
	if err != nil {
		return err
	}

	model := tui.NewModel(events)
	model = model.Preload(history)
	model = model.PreloadSessions(sessions)
	model.ExportFn = func(evs []event.Event) (string, error) {
		name := fmt.Sprintf("firehose-export-%s.ndjson", time.Now().Format("20060102-150405"))
		f, err := os.Create(name)
		if err != nil {
			return "", err
		}
		defer f.Close()
		for _, ev := range evs {
			data, err := jsonLine(ev)
			if err != nil {
				return "", err
			}
			if _, err := f.Write(data); err != nil {
				return "", err
			}
		}
		return name, nil
	}

	_, err = tea.NewProgram(model, tea.WithAltScreen()).Run()
	return err
}

// viewFeed prefers the daemon API; without one it opens the same host-composed
// Capture Engine locally. Both paths preload durable history and Projection
// state, then reconcile bounded live-stream interruptions.
func viewFeed(ctx context.Context, cfg cfgType, home string) (<-chan event.Event, []event.Event, []tui.SessionAttention, error) {
	if cfg.DaemonAddr != "" {
		c := client.New("http://" + cfg.DaemonAddr)
		if h, err := c.Health(ctx); err == nil {
			schema := h.SchemaVersion
			if schema == 0 {
				schema = 1
			}
			if schema != event.CurrentSchemaVersion {
				return nil, nil, nil, fmt.Errorf(
					"daemon schema version %d is incompatible with client schema version %d",
					schema, event.CurrentSchemaVersion,
				)
			}
			stream, history, sessions, err := c.Feed(ctx, 500, 10000)
			if err != nil {
				return nil, nil, nil, err
			}
			return stream, history, sessionAttention(sessions), nil
		}
	}

	feed, err := host.OpenLocalFeed(ctx, cfg, home)
	if err != nil {
		return nil, nil, nil, err
	}
	return feed.Events, feed.History, sessionAttention(feed.Sessions), nil
}

func sessionAttention(sessions []livesubscription.Session) []tui.SessionAttention {
	attention := make([]tui.SessionAttention, 0, len(sessions))
	for _, session := range sessions {
		attention = append(attention, tui.SessionAttention{
			ID: session.ID, Source: session.Source, Agent: session.Agent,
			Repo: session.Repo, CWD: session.CWD,
			State: session.State, Since: session.StateSince, Reason: session.StateReason,
			Last: session.LastTime, HasError: session.HasError,
		})
	}
	return attention
}

type cfgType = cli.Config

func jsonLine(ev event.Event) ([]byte, error) {
	data, err := json.Marshal(ev)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "firehose:", err)
	os.Exit(1)
}

func fatalIf(err error) {
	if err != nil {
		fatal(err)
	}
}
