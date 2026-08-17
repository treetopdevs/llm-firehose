// Package host composes the Capture Engine with local user-facing adapters.
package host

import (
	"context"
	"path/filepath"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/daemon"
	"agentfirehose/internal/privacy"
)

// NewEngine constructs the shared local Capture Engine used by both hosts.
func NewEngine(cfg cli.Config, home string) (*capture.Engine, error) {
	policy, err := privacy.ParseMode(cfg.PrivacyMode)
	if err != nil {
		policy = privacy.ModeBalanced
	}
	sources := capture.LocalSources(capture.LocalSourceOptions{
		CodexDir:       cfg.CodexDir,
		CodexStatePath: filepath.Join(home, ".agentfirehose", "state", "codex-cursors.json"),
	})
	return capture.New(capture.Options{SpoolDir: cfg.SpoolDir, Policy: policy, Sources: sources})
}

// RunDaemon runs one Capture Engine and its local HTTP adapter until
// cancellation. Neither binary reconstructs lifecycle ordering itself.
func RunDaemon(ctx context.Context, cfg cli.Config, home, version, addr string, onReady func(string)) error {
	engine, err := NewEngine(cfg, home)
	if err != nil {
		return err
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	engineDone := make(chan error, 1)
	go func() { engineDone <- engine.Run(runCtx) }()

	server := daemon.New(engine, cfg, home, version)
	bound, serveDone, err := server.Serve(runCtx, addr)
	if err != nil {
		cancel()
		<-engineDone
		return err
	}
	if onReady != nil {
		onReady(bound)
	}
	select {
	case err := <-serveDone:
		cancel()
		<-engineDone
		return err
	case err := <-engineDone:
		cancel()
		<-serveDone
		return err
	}
}
