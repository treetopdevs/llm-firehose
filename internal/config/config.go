// Package config loads and saves Firehose's on-disk configuration.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"agentfirehose/internal/privacy"
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

// Load reads config.json under home, filling defaults.
func Load(home string) (Config, error) {
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

// Save validates cfg and writes it to config.json under home.
func Save(home string, cfg Config) error {
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

// Mode is the configured Capture Policy, balanced when unset or unknown.
func (c Config) Mode() privacy.Mode {
	return privacy.ModeOrDefault(c.PrivacyMode)
}
