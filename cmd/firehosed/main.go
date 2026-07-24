// Command firehosed is the Agent Firehose capture engine: adapters,
// normalization, privacy redaction, spool writes, and the local API. It is
// the long-running daemon the desktop shell bundles as a sidecar; the
// firehose CLI and TUI are clients of it.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/daemon"
)

const version = "0.1.0"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hook-forward" {
		home, _ := os.UserHomeDir()
		cfg, _ := cli.LoadConfig(home)
		_ = cli.HookForward(cfg, os.Stdin, os.Stdout)
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
	fs := flag.NewFlagSet("firehosed", flag.ExitOnError)
	addr := fs.String("addr", cfg.DaemonAddr, "listen address for the local API")
	showVersion := fs.Bool("version", false, "print version and exit")
	fs.Parse(os.Args[1:])
	if *showVersion {
		fmt.Println("firehosed " + version)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = daemon.Run(ctx, cfg, home, version, *addr, func(bound string) {
		fmt.Fprintf(os.Stderr, "firehosed listening on %s (spool: %s)\n", bound, cfg.SpoolDir)
	})
	if err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "firehosed:", err)
	os.Exit(1)
}
