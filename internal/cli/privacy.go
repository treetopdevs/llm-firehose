package cli

import (
	"context"
	"fmt"
	"io"

	"agentfirehose/internal/client"
	"agentfirehose/internal/privacy"
)

// Privacy shows the privacy mode, or sets it when given one. A running daemon
// is told directly (the mode applies live and the daemon persists it);
// otherwise config.json is written and applies when a daemon next starts.
func Privacy(cfg Config, home string, args []string, w io.Writer) error {
	if len(args) == 0 {
		fmt.Fprintf(w, "privacy mode: %s\n", cfg.PrivacyMode)
		fmt.Fprintln(w, "change it with: firehose privacy minimal | balanced | full")
		fmt.Fprintln(w, "  minimal   values stored as digests only")
		fmt.Fprintln(w, "  balanced  strings truncated, raw payloads dropped (default)")
		fmt.Fprintln(w, "  full      everything, including raw payloads and local repo paths")
		return nil
	}
	if len(args) > 1 {
		return fmt.Errorf("usage: firehose privacy [minimal|balanced|full]")
	}
	mode, err := privacy.ParseMode(args[0])
	if err != nil {
		return err
	}
	addr := cfg.DaemonAddr
	if addr == "" {
		addr = DefaultDaemonAddr
	}
	c := client.New("http://" + addr)
	if _, herr := c.Health(context.Background()); herr == nil {
		if err := c.SetPrivacyMode(context.Background(), string(mode)); err != nil {
			return err
		}
		fmt.Fprintf(w, "privacy mode is now %s (applied to the running daemon)\n", mode)
		return nil
	}
	cfg.PrivacyMode = string(mode)
	if err := SaveConfig(home, cfg); err != nil {
		return err
	}
	fmt.Fprintf(w, "privacy mode is now %s (saved; restart any running daemon to apply)\n", mode)
	return nil
}
