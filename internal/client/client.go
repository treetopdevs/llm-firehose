// Package client is the Go client for the firehose daemon's local HTTP API.
// It deliberately imports only the event envelope: the JSON contract is the
// boundary, so clients and the daemon can evolve independently.
package client

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"agentfirehose/internal/event"
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

func (c *Client) getJSON(path string, v any) error {
	resp, err := c.http.Get(c.BaseURL + path)
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
func (c *Client) Health() (Health, error) {
	var h Health
	err := c.getJSON("/health", &h)
	return h, err
}

// Recent returns up to limit most recent events, oldest first.
func (c *Client) Recent(limit int) ([]event.Event, error) {
	var evs []event.Event
	err := c.getJSON("/events?limit="+fmt.Sprint(limit), &evs)
	return evs, err
}

// Emit sends one raw source payload for the daemon to normalize and spool.
func (c *Client) Emit(source string, r io.Reader) error {
	return c.EmitNamed(source, "", r)
}

// EmitNamed is Emit with an explicit native event name, carried in the
// additive `event` query parameter for sources whose payloads do not name
// their own event (antigravity). An empty eventName omits the parameter.
func (c *Client) EmitNamed(source, eventName string, r io.Reader) error {
	u := c.BaseURL + "/emit?source=" + url.QueryEscape(source)
	if eventName != "" {
		u += "&event=" + url.QueryEscape(eventName)
	}
	resp, err := c.http.Post(u, "application/json", r)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("client: POST /emit: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

// Stream subscribes to the daemon's live event feed. The returned channel
// closes when ctx is canceled or the connection drops.
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
