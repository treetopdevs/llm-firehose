package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveConfigRoundTrip(t *testing.T) {
	home := t.TempDir()
	cfg, _ := Load(home)
	cfg.PrivacyMode = "minimal"
	if err := Save(home, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load(home)
	if err != nil {
		t.Fatalf("Load after save: %v", err)
	}
	if got.PrivacyMode != "minimal" {
		t.Errorf("privacy = %q, want minimal", got.PrivacyMode)
	}
	if got.SpoolDir != cfg.SpoolDir {
		t.Errorf("spool dir changed across save: %q vs %q", got.SpoolDir, cfg.SpoolDir)
	}
}

func TestSaveConfigRejectsBadMode(t *testing.T) {
	home := t.TempDir()
	cfg, _ := Load(home)
	cfg.PrivacyMode = "everything"
	if err := Save(home, cfg); err == nil {
		t.Fatal("want error for invalid privacy mode")
	}
	if _, err := os.Stat(filepath.Join(home, ".agentfirehose", "config.json")); !os.IsNotExist(err) {
		t.Error("invalid config must not be written")
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	home := t.TempDir()
	cfg, err := Load(home)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PrivacyMode != "balanced" {
		t.Errorf("default privacy = %q, want balanced", cfg.PrivacyMode)
	}
	if cfg.SpoolDir != filepath.Join(home, ".agentfirehose", "spool") {
		t.Errorf("default spool = %q", cfg.SpoolDir)
	}
	if cfg.DaemonAddr != "127.0.0.1:4517" {
		t.Errorf("default daemon addr = %q, want 127.0.0.1:4517", cfg.DaemonAddr)
	}
	// explicit config file overrides
	os.MkdirAll(filepath.Join(home, ".agentfirehose"), 0o755)
	os.WriteFile(filepath.Join(home, ".agentfirehose", "config.json"), []byte(`{"privacy_mode":"minimal"}`), 0o644)
	cfg, err = Load(home)
	if err != nil {
		t.Fatalf("Load with file: %v", err)
	}
	if cfg.PrivacyMode != "minimal" {
		t.Errorf("privacy = %q, want minimal", cfg.PrivacyMode)
	}
}
