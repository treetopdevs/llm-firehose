package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestErrorSessionsEndpoint(t *testing.T) {
	cfg := testConfig(t)
	seedErrorFixture(t, cfg.SpoolDir)
	ts := testServer(t, cfg)
	key := "codex|shell|PostToolUse|failed: mix test"
	resp, err := http.Get(ts.URL + "/errors/sessions?key=" + url.QueryEscape(key) + "&limit=1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	var page struct {
		Key                  string `json:"key"`
		Total, Offset, Limit int
		Sessions             []struct {
			SessionID     string `json:"session_id"`
			Source        string
			Count         int
			SampleEventID string `json:"sample_event_id"`
			FirstTime     string `json:"first_time"`
			LastTime      string `json:"last_time"`
		}
	}
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if page.Key != key || page.Total != 2 || page.Limit != 1 || page.Offset != 0 || len(page.Sessions) != 1 {
		t.Fatalf("page=%+v", page)
	}
	row := page.Sessions[0]
	if row.Source != "codex" || row.Count < 1 || row.SampleEventID == "" || row.FirstTime == "" || row.LastTime == "" {
		t.Fatalf("row=%+v", row)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("missing no-store")
	}
	for _, query := range []string{"&offset=2", "&offset=9223372036854775807"} {
		r, err := http.Get(ts.URL + "/errors/sessions?key=" + url.QueryEscape(key) + query)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != 200 || !strings.Contains(string(b), `"sessions":[]`) {
			t.Fatalf("empty page status=%d body=%s", r.StatusCode, b)
		}
	}
	for _, tc := range []struct {
		q      string
		status int
	}{
		{"", 400}, {"?key=", 400}, {"?key=missing", 404}, {"?key=missing&offset=-1", 400}, {"?key=missing&offset=abc", 400}, {"?key=missing&offset=", 400}, {"?key=missing&offset=9223372036854775808", 400}, {"?key=missing&limit=0", 400}, {"?key=missing&limit=101", 400}, {"?key=missing&limit=1.5", 400}, {"?key=missing&limit=", 400},
	} {
		r, err := http.Get(ts.URL + "/errors/sessions" + tc.q)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != tc.status {
			t.Errorf("%s status=%d want=%d", tc.q, r.StatusCode, tc.status)
		}
	}
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/errors/sessions?key="+url.QueryEscape(key), nil)
	req.Header.Set("Origin", "https://evil.example")
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin status=%d", r.StatusCode)
	}
}

func TestErrorSessionsRejectsMalformedAndAmbiguousQuery(t *testing.T) {
	cfg := testConfig(t)
	seedErrorFixture(t, cfg.SpoolDir)
	ts := testServer(t, cfg)
	key := url.QueryEscape("codex|shell|PostToolUse|failed: mix test")
	for _, suffix := range []string{"&offset=%zz", "&offset=1;limit=5", "&limit=%zz", "&offset=%2B5", "&offset=-0", "&limit=%2B5", "&offset=0&offset=1", "&limit=1&limit=2", "&key=other"} {
		t.Run(suffix, func(t *testing.T) {
			r, err := http.Get(ts.URL + "/errors/sessions?key=" + key + suffix)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Body.Close()
			if r.StatusCode != 400 {
				t.Fatalf("status=%d want=400", r.StatusCode)
			}
		})
	}
	r, err := http.Get(ts.URL + "/errors/sessions?key=secret-not-found")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 404 || string(body) != "error signature not found\n" {
		t.Fatalf("status=%d body=%q", r.StatusCode, body)
	}
}
