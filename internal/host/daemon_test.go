package host

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"agentfirehose/internal/cli"
)

func TestRunDaemonComposesEngineAndHTTPUntilCancellation(t *testing.T) {
	home := t.TempDir()
	cfg := cli.Config{
		SpoolDir:    filepath.Join(home, ".agentfirehose", "spool"),
		PrivacyMode: "balanced",
		DaemonAddr:  "127.0.0.1:0",
	}
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- RunDaemon(ctx, cfg, home, "test-version", cfg.DaemonAddr, func(bound string) { ready <- bound })
	}()

	var bound string
	select {
	case bound = <-ready:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("daemon host never became ready")
	}
	resp, err := http.Get("http://" + bound + "/health")
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		cancel()
		t.Fatalf("health status = %d", resp.StatusCode)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RunDaemon: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon host did not stop")
	}
}
