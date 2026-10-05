package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPrivacyShowsCurrentModeAndHowToChangeIt(t *testing.T) {
	var out bytes.Buffer
	if err := Privacy(testConfig(t), t.TempDir(), nil, &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"balanced", "firehose privacy", "minimal", "full"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output missing %q: %s", want, out.String())
		}
	}
}

func TestPrivacySetWithoutDaemonWritesConfig(t *testing.T) {
	home := t.TempDir()
	cfg := testConfig(t)
	cfg.DaemonAddr = "127.0.0.1:1" // nothing listens
	var out bytes.Buffer
	if err := Privacy(cfg, home, []string{"full"}, &out); err != nil {
		t.Fatal(err)
	}
	got, err := LoadConfig(home)
	if err != nil || got.PrivacyMode != "full" {
		t.Fatalf("config %+v %v", got, err)
	}
	if !strings.Contains(out.String(), "restart") {
		t.Fatalf("should say a running daemon needs restart: %s", out.String())
	}
}

func TestPrivacySetAppliesLiveWhenDaemonRuns(t *testing.T) {
	var posted map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /health":
			w.Write([]byte(`{"status":"ok","version":"t","schema_version":1}`))
		case "POST /config":
			json.NewDecoder(r.Body).Decode(&posted)
			w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	home := t.TempDir()
	cfg := testConfig(t)
	cfg.DaemonAddr = strings.TrimPrefix(srv.URL, "http://")
	var out bytes.Buffer
	if err := Privacy(cfg, home, []string{"full"}, &out); err != nil {
		t.Fatal(err)
	}
	if posted["privacy_mode"] != "full" {
		t.Fatalf("daemon not told: %v", posted)
	}
	if strings.Contains(out.String(), "restart") {
		t.Fatalf("live apply must not ask for restart: %s", out.String())
	}
}

func TestPrivacyRejectsUnknownMode(t *testing.T) {
	if err := Privacy(testConfig(t), t.TempDir(), []string{"everything"}, &bytes.Buffer{}); err == nil {
		t.Fatal("accepted invalid mode")
	}
}
