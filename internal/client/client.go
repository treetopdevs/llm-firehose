// Package client is the Go client for the firehose daemon's local HTTP API.
// It imports the event envelope and the Live Subscription module. The JSON
// contract is the seam with the daemon, so this client does not import the
// Capture Engine.
package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/livesubscription"
)

// Client talks to a firehose daemon at BaseURL (e.g. http://127.0.0.1:4517).
type Client struct {
	BaseURL string
	http    *http.Client // short-timeout client for request/response calls
	stream  *http.Client // no overall timeout; streams live on request context
}

func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 3 * time.Second},
		stream:  &http.Client{},
	}
}

// Health is the daemon's identity and compatibility report.
type Health struct {
	Status        string `json:"status"`
	Version       string `json:"version"`
	SchemaVersion int    `json:"schema_version"`
}

// Session is the local API projection needed by presentation clients.
type Session struct {
	ID          string    `json:"id"`
	Source      string    `json:"source"`
	Agent       string    `json:"agent,omitempty"`
	Repo        string    `json:"repo,omitempty"`
	CWD         string    `json:"cwd,omitempty"`
	State       string    `json:"state"`
	StateSince  time.Time `json:"state_since"`
	StateReason string    `json:"state_reason,omitempty"`
	LastTime    time.Time `json:"last_time"`
	HasError    bool      `json:"has_error,omitempty"`
}

// HTTPError reports a daemon response that reached the local HTTP adapter but
// did not satisfy the requested operation.
type HTTPError struct {
	Operation  string
	Status     string
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("client: %s: %s: %s", e.Operation, e.Status, e.Body)
}

func (c *Client) getJSON(ctx context.Context, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("client: GET %s: %s: %s", path, resp.Status, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// Health reports whether a daemon is reachable and what it is running.
func (c *Client) Health(ctx context.Context) (Health, error) {
	var h Health
	err := c.getJSON(ctx, "/health", &h)
	return h, err
}

// Recent returns up to limit most recent events, oldest first.
func (c *Client) Recent(ctx context.Context, limit int) ([]event.Event, error) {
	var evs []event.Event
	err := c.getJSON(ctx, "/events?limit="+fmt.Sprint(limit), &evs)
	return evs, err
}

// Sessions returns the daemon's projected session state.
func (c *Client) Sessions(ctx context.Context) ([]Session, error) {
	var sessions []Session
	err := c.getJSON(ctx, "/sessions", &sessions)
	return sessions, err
}

// Emit sends one raw source payload for the daemon to normalize and spool.
func (c *Client) Emit(ctx context.Context, source string, r io.Reader) error {
	return c.EmitNamed(ctx, source, "", r)
}

// EmitNamed is Emit with an explicit native event name, carried in the
// additive `event` query parameter for sources whose payloads do not name
// their own event (antigravity). An empty eventName omits the parameter.
func (c *Client) EmitNamed(ctx context.Context, source, eventName string, r io.Reader) error {
	u := c.BaseURL + "/emit?source=" + url.QueryEscape(source)
	if eventName != "" {
		u += "&event=" + url.QueryEscape(eventName)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, r)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return &HTTPError{
			Operation: "POST /emit", Status: resp.Status, StatusCode: resp.StatusCode,
			Body: strings.TrimSpace(string(body)),
		}
	}
	return nil
}

// SetPrivacyMode asks the daemon to apply and persist a privacy mode.
func (c *Client) SetPrivacyMode(ctx context.Context, mode string) error {
	body, err := json.Marshal(map[string]string{"privacy_mode": mode})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/config", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return &HTTPError{Operation: "POST /config", Status: resp.Status, StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(b))}
	}
	return nil
}

// Stream subscribes to the daemon's live event feed. When it returns, the
// daemon has registered the subscription, so every event admitted afterwards
// is delivered (until overflow ends the stream). The returned channel closes
// when ctx is canceled or the connection drops.
func (c *Client) Stream(ctx context.Context) (<-chan event.Event, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/events/stream", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.stream.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("client: GET /events/stream: %s", resp.Status)
	}
	ch := make(chan event.Event, 256)
	go func() {
		defer close(ch)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev event.Event
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev) != nil {
				continue
			}
			select {
			case ch <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// Feed opens a Live Subscription against this daemon. History, the event
// channel, and the session snapshot are returned together.
func (c *Client) Feed(ctx context.Context, initialLimit, reconcileLimit int) (<-chan event.Event, []event.Event, []livesubscription.Session, error) {
	sub, err := livesubscription.Open(ctx, httpSource{c}, initialLimit, reconcileLimit)
	if err != nil {
		return nil, nil, nil, err
	}
	return sub.Events, sub.History, sub.Sessions, nil
}

type httpSource struct{ client *Client }

func (s httpSource) Recent(ctx context.Context, limit int) ([]event.Event, error) {
	return s.client.Recent(ctx, limit)
}

func (s httpSource) Subscribe(ctx context.Context) (<-chan event.Event, error) {
	return s.client.Stream(ctx)
}

func (s httpSource) Sessions(ctx context.Context) ([]livesubscription.Session, error) {
	sessions, err := s.client.Sessions(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]livesubscription.Session, len(sessions))
	for i, session := range sessions {
		out[i] = livesubscription.Session{
			ID: session.ID, Source: session.Source, Agent: session.Agent,
			Repo: session.Repo, CWD: session.CWD, State: session.State,
			StateSince: session.StateSince, StateReason: session.StateReason,
			LastTime: session.LastTime, HasError: session.HasError,
		}
	}
	return out, nil
}
