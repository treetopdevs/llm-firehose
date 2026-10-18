package daemon

import (
	"agentfirehose/internal/event"
	"agentfirehose/internal/testsupport/capturehistory"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHistoryHandlersUseRequestContext(t *testing.T) {
	cfg := testConfig(t)
	data, err := os.ReadFile("../capture/testdata/fixture.session.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture []event.Event
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	var real event.Event
	for _, ev := range fixture {
		if ev.SessionID != "" {
			real = ev
			break
		}
	}
	if real.ID == "" {
		t.Fatal("captured session fixture missing")
	}
	// Normalized contract mutations for shared Session/Trace handler coverage.
	real.SessionID = "history-context-session"
	real.TraceID = "history-context-trace"
	if _, err = capturehistory.NewAdmitter(cfg.SpoolDir).Append(real); err != nil {
		t.Fatal(err)
	}
	handler := New(testEngine(t, cfg), cfg, t.TempDir(), "test").Handler()
	for _, path := range []string{"/sessions/history-context-session", "/sessions/history-context-session?view=full", "/sessions/history-context-session?view=timeline", "/traces/history-context-trace"} {
		t.Run(path, func(t *testing.T) {
			canceled, cancel := context.WithCancel(context.Background())
			cancel()
			deadline, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
			defer stop()
			for _, ctx := range []context.Context{canceled, deadline} {
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
				handler.ServeHTTP(rec, req)
				if rec.Code == http.StatusInternalServerError || rec.Code == http.StatusNotFound || rec.Body.Len() != 0 {
					t.Fatalf("canceled request returned %d %s", rec.Code, rec.Body.String())
				}
			}
			healthy := httptest.NewRecorder()
			handler.ServeHTTP(healthy, httptest.NewRequest(http.MethodGet, path, nil))
			var rows []event.Event
			if healthy.Code != http.StatusOK || json.Unmarshal(healthy.Body.Bytes(), &rows) != nil || len(rows) != 1 || rows[0].ID != real.ID {
				t.Fatalf("healthy response changed: %d %s", healthy.Code, healthy.Body.String())
			}
		})
	}

	// A live client still receives500 for an actual unreadable day file.
	dayPath := filepath.Join(cfg.SpoolDir, real.Time.UTC().Format("2006-01-02")+".ndjson")
	if err := os.Remove(dayPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dayPath, 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/sessions/history-context-session", "/traces/history-context-trace"} {
		failed := httptest.NewRecorder()
		handler.ServeHTTP(failed, httptest.NewRequest(http.MethodGet, path, nil))
		if failed.Code != http.StatusInternalServerError {
			t.Fatalf("live scanner failure changed: %d", failed.Code)
		}
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, path := range []string{"/sessions/absent", "/traces/absent"} {
		abandoned := httptest.NewRecorder()
		handler.ServeHTTP(abandoned, httptest.NewRequest(http.MethodGet, path, nil).WithContext(canceled))
		if abandoned.Code == http.StatusNotFound || abandoned.Code == http.StatusInternalServerError || abandoned.Body.Len() != 0 {
			t.Fatalf("abandoned unknown query wrote a response: %d %s", abandoned.Code, abandoned.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sessions/history-context-session?view=invalid", nil).WithContext(canceled))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid view precedence changed: %d", rec.Code)
	}
}
