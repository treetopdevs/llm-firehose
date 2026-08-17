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

	"agentfirehose/internal/adapters/codex"
	"agentfirehose/internal/adapters/procwatch"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/client"
	"agentfirehose/internal/event"
	"agentfirehose/internal/host"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
	"agentfirehose/internal/tui"
)

const version = "0.1.0"

const usage = `Agent Firehose %s — a live timeline of AI coding-agent activity.

Usage:
  firehose [view]              open the live TUI (default; uses the daemon when running)
  firehose daemon [--addr A]   run the capture engine and its local API
  firehose status              report whether the daemon is running
  firehose emit --source S     normalize one payload from stdin (via daemon when running)
                               (--event NAME names the hook event for antigravity)
  firehose ingest              stream NDJSON events from stdin into the spool
  firehose export [-o FILE]    dump captured events as NDJSON (default stdout)
  firehose hook-forward        fail-silent adapter hook capture
  firehose install AGENT       wire an adapter (claude-code | claude-otel | codex | opencode | antigravity)
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
		fatalIf(runView(cfg))
	case "daemon":
		fs := flag.NewFlagSet("daemon", flag.ExitOnError)
		addr := fs.String("addr", cfg.DaemonAddr, "listen address for the local API")
		fs.Parse(args)
		fatalIf(runDaemon(cfg, home, *addr))
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
		if len(args) != 1 {
			fatal(fmt.Errorf("usage: firehose install <claude-code|claude-otel|codex|opencode|antigravity>"))
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
			fatalIf(cli.InstallClaudeOTel(home, addr, os.Environ()))
			fmt.Println("✓ supplemental Claude OTLP/HTTP JSON enabled for the local daemon")
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
func runView(cfg cfgType) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	events, history, err := viewFeed(ctx, cfg)
	if err != nil {
		return err
	}

	model := tui.NewModel(events)
	model = model.Preload(history)
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

// viewFeed prefers the daemon's stream; without one it merges the spool
// tailer, codex session watcher, and process watcher locally.
//
// Note (CodeRabbit): moving this local capture pipeline into internal/cli is
// deferred — too large for the review-fix pass; keep wiring here for now.
func viewFeed(ctx context.Context, cfg cfgType) (<-chan event.Event, []event.Event, error) {
	if cfg.DaemonAddr != "" {
		c := client.New("http://" + cfg.DaemonAddr)
		if h, err := c.Health(ctx); err == nil {
			schema := h.SchemaVersion
			if schema == 0 {
				schema = 1
			}
			if schema != event.CurrentSchemaVersion {
				return nil, nil, fmt.Errorf(
					"daemon schema version %d is incompatible with client schema version %d",
					schema, event.CurrentSchemaVersion,
				)
			}
			stream, history, err := c.Feed(ctx, 500, 10000)
			if err != nil {
				return nil, nil, err
			}
			return stream, history, nil
		}
	}

	mode, err := privacy.ParseMode(cfg.PrivacyMode)
	if err != nil {
		mode = privacy.ModeBalanced
	}
	raw := make(chan event.Event, 1024)
	go spool.NewTailer(cfg.SpoolDir, 100*time.Millisecond).Run(ctx, raw)
	if _, err := os.Stat(cfg.CodexDir); err == nil {
		go codex.NewWatcher(cfg.CodexDir, 250*time.Millisecond).Run(ctx, raw)
	}
	go procwatch.NewWatcher(procwatch.PSLister{}, 2*time.Second).Run(ctx, raw)

	// Codex events are read straight from its files, so redact here; spooled
	// events were already redacted at append time.
	events := make(chan event.Event, 1024)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-raw:
				if ev.Source == codex.Source {
					ev = privacy.Redact(ev, mode)
				}
				select {
				case events <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	history, _ := spool.ReadLastN(cfg.SpoolDir, 500)
	return events, history, nil
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
