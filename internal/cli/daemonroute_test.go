// External test package: these tests stand up a real daemon, and the daemon
// package imports cli, so they cannot live in package cli.
package cli_test

import (
	"bytes"
	"context"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/client"
	"agentfirehose/internal/daemon"
	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

// startDaemon serves a daemon over its own spool dir and returns the
// host:port it listens on plus that spool dir.
func startDaemon(t *testing.T) (addr, spoolDir string) {
	t.Helper()
	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "daemon-spool"),
		PrivacyMode: "balanced",
	}
	ts := httptest.NewServer(daemon.New(cfg, t.TempDir(), "test").Handler())
	t.Cleanup(ts.Close)
	return strings.TrimPrefix(ts.URL, "http://"), cfg.SpoolDir
}

func TestEmitRoutesThroughDaemonWhenReachable(t *testing.T) {
	daemonAddr, daemonSpool := startDaemon(t)
	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "local-spool"),
		PrivacyMode: "balanced",
		DaemonAddr:  daemonAddr,
	}
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"through daemon"}`
	if err := cli.Emit(cfg, "generic", strings.NewReader(line)); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	// The daemon owns the write: its spool has the event, the local one doesn't.
	dEvs, _ := spool.ReadLastN(daemonSpool, 10)
	if len(dEvs) != 1 || dEvs[0].Summary != "through daemon" {
		t.Fatalf("daemon spool = %+v, want the emitted event", dEvs)
	}
	lEvs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(lEvs) != 0 {
		t.Fatalf("local spool must stay empty when daemon handled the emit: %+v", lEvs)
	}
}

func TestEmitFallsBackToLocalSpoolWhenDaemonDown(t *testing.T) {
	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "local-spool"),
		PrivacyMode: "balanced",
		DaemonAddr:  "127.0.0.1:1", // nothing listens here
	}
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"fallback"}`
	if err := cli.Emit(cfg, "generic", strings.NewReader(line)); err != nil {
		t.Fatalf("Emit must fall back, got: %v", err)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 || evs[0].Summary != "fallback" {
		t.Fatalf("local spool = %+v, want the emitted event", evs)
	}
}

func TestEmitBadPayloadIsNotSwallowedByFallback(t *testing.T) {
	daemonAddr, daemonSpool := startDaemon(t)
	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "local-spool"),
		PrivacyMode: "balanced",
		DaemonAddr:  daemonAddr,
	}
	if err := cli.Emit(cfg, "generic", strings.NewReader("not json")); err == nil {
		t.Fatal("bad payload must surface an error, not fall back silently")
	}
	if evs, _ := spool.ReadLastN(daemonSpool, 10); len(evs) != 0 {
		t.Fatalf("bad payload spooled: %+v", evs)
	}
	if evs, _ := spool.ReadLastN(cfg.SpoolDir, 10); len(evs) != 0 {
		t.Fatalf("bad payload spooled locally: %+v", evs)
	}
}

func TestStatusReportsRunningDaemon(t *testing.T) {
	daemonAddr, _ := startDaemon(t)
	cfg := cli.Config{DaemonAddr: daemonAddr}
	var out bytes.Buffer
	if running := cli.Status(cfg, &out); !running {
		t.Fatalf("Status = false with daemon up; output: %s", out.String())
	}
	if !strings.Contains(out.String(), "test") || !strings.Contains(out.String(), daemonAddr) {
		t.Errorf("status output missing version/addr: %q", out.String())
	}
}

func TestStatusReportsDownDaemon(t *testing.T) {
	cfg := cli.Config{DaemonAddr: "127.0.0.1:1"}
	var out bytes.Buffer
	if running := cli.Status(cfg, &out); running {
		t.Fatal("Status = true with no daemon")
	}
	if !strings.Contains(out.String(), "not running") {
		t.Errorf("status output = %q, want mention of not running", out.String())
	}
}

func TestEmitLocalWritesDirectly(t *testing.T) {
	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "spool"),
		PrivacyMode: "balanced",
	}
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"direct"}`
	if err := cli.EmitLocal(cfg, "generic", []byte(line)); err != nil {
		t.Fatalf("EmitLocal: %v", err)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 || evs[0].Category != event.CategoryShell {
		t.Fatalf("spool = %+v", evs)
	}
}

// A daemon whose own config points at its own address (the normal case in
// production) must write emits locally, not proxy them back to itself.
func TestDaemonEmitDoesNotProxyToItself(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	addr := l.Addr().String()
	l.Close()

	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "spool"),
		PrivacyMode: "balanced",
		DaemonAddr:  addr, // the daemon's own address
	}
	s := daemon.New(cfg, t.TempDir(), "test")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if _, _, err := s.Serve(ctx, addr); err != nil {
		t.Fatalf("Serve: %v", err)
	}

	errCh := make(chan error, 1)
	go func() {
		line := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"once"}`
		errCh <- cli.Emit(cfg, "generic", strings.NewReader(line))
	}()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("Emit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Emit hung — daemon is proxying to itself")
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 {
		t.Fatalf("spool has %d events, want exactly 1: %+v", len(evs), evs)
	}
}

func TestServeAndShutdown(t *testing.T) {
	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "spool"),
		PrivacyMode: "balanced",
	}
	s := daemon.New(cfg, t.TempDir(), "test")
	ctx, cancel := context.WithCancel(context.Background())
	addr, done, err := s.Serve(ctx, "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	var out bytes.Buffer
	if running := cli.Status(cli.Config{DaemonAddr: addr}, &out); !running {
		t.Fatalf("daemon not reachable at %s: %s", addr, out.String())
	}
	// An open live stream must not wedge shutdown. Its own context stays
	// live, so only the daemon closing the response can end the channel.
	streamCh, err := client.New("http://" + addr).Stream(context.Background())
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	cancel()
	select {
	case <-streamCh:
	case <-time.After(3 * time.Second):
		t.Fatal("stream not closed on daemon shutdown")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve exited with error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Serve did not shut down after cancel")
	}
}
