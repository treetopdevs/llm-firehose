// Package cli implements the firehose subcommands (emit, ingest, export,
// install, doctor) as testable functions; cmd/firehose only parses flags.
package cli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/adapters/generic"
	"agentfirehose/internal/adapters/opencode"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
)

// Config is the on-disk configuration (~/.agentfirehose/config.json).
type Config struct {
	SpoolDir    string `json:"spool_dir,omitempty"`
	PrivacyMode string `json:"privacy_mode,omitempty"`
	CodexDir    string `json:"codex_sessions_dir,omitempty"`
}

// LoadConfig reads config.json under home, filling defaults.
func LoadConfig(home string) (Config, error) {
	cfg := Config{
		SpoolDir:    filepath.Join(home, ".agentfirehose", "spool"),
		PrivacyMode: string(privacy.ModeBalanced),
		CodexDir:    filepath.Join(home, ".codex", "sessions"),
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
	return cfg, nil
}

func (c Config) mode() privacy.Mode {
	m, err := privacy.ParseMode(c.PrivacyMode)
	if err != nil {
		return privacy.ModeBalanced
	}
	return m
}

// Emit reads one raw payload from r, normalizes it for source, applies the
// configured privacy mode, and appends it to the spool. A payload the adapter
// deliberately skips is not an error.
func Emit(cfg Config, source string, r io.Reader) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	var ev *event.Event
	switch source {
	case claudecode.Source:
		parsed, err := claudecode.Parse(raw)
		if err != nil {
			return err
		}
		ev = &parsed
	case opencode.Source:
		parsed, err := opencode.Parse(raw)
		if err != nil {
			return err
		}
		ev = parsed // nil = skipped
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
