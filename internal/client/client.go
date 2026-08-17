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

const feedSeenCapacity = 20000

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
	State       string    `json:"state"`
	StateSince  time.Time `json:"state_since"`
	StateReason string    `json:"state_reason,omitempty"`
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

// Feed loads durable history, consumes one live stream, and on interruption
// reloads durable history before opening a replacement stream. Exact stable
// ids already inside the bounded presentation window are suppressed.
func (c *Client) Feed(ctx context.Context, initialLimit, reconcileLimit int) (<-chan event.Event, []event.Event, error) {
	history, err := c.Recent(ctx, initialLimit)
	if err != nil {
		return nil, nil, err
	}
	seen := newBoundedIDs(feedSeenCapacity)
	history = deduplicate(history, seen)
	stream, err := c.Stream(ctx)
	if err != nil {
		return nil, nil, err
	}
	out := make(chan event.Event, 256)
	go func() {
		defer close(out)
		current := stream
		for {
			for ev := range current {
				if ev.ID != "" && !seen.add(ev.ID) {
					continue
				}
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			}
			if ctx.Err() != nil {
				return
			}

			for {
				recovered, historyErr := c.Recent(ctx, reconcileLimit)
				if historyErr == nil {
					for _, ev := range deduplicate(recovered, seen) {
						select {
						case out <- ev:
						case <-ctx.Done():
							return
						}
					}
					current, historyErr = c.Stream(ctx)
					if historyErr == nil {
						break
					}
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(250 * time.Millisecond):
				}
			}
		}
	}()
	return out, history, nil
}

type boundedIDs struct {
	capacity int
	set      map[string]bool
	order    []string
}

func newBoundedIDs(capacity int) *boundedIDs {
	return &boundedIDs{capacity: capacity, set: make(map[string]bool)}
}

func (s *boundedIDs) add(id string) bool {
	if s.set[id] {
		return false
	}
	s.set[id] = true
	s.order = append(s.order, id)
	if len(s.order) > s.capacity {
		delete(s.set, s.order[0])
		s.order = s.order[1:]
	}
	return true
}

func deduplicate(events []event.Event, seen *boundedIDs) []event.Event {
	out := make([]event.Event, 0, len(events))
	for _, ev := range events {
		if ev.ID != "" && !seen.add(ev.ID) {
			continue
		}
		out = append(out, ev)
	}
	return out
}
