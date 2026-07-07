package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"agentfirehose/internal/adapters/codex"
	"agentfirehose/internal/adapters/procwatch"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
)

// hub fans live events out to stream subscribers. Broadcast never blocks:
// a subscriber that falls behind its buffer drops events rather than stalling
// the capture pipeline.
type hub struct {
	mu   sync.Mutex
	subs map[chan event.Event]struct{}
}

func newHub() *hub { return &hub{subs: map[chan event.Event]struct{}{}} }

func (h *hub) subscribe() chan event.Event {
	ch := make(chan event.Event, 256)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[ch] = struct{}{}
	return ch
}

func (h *hub) unsubscribe(ch chan event.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
}

// closeAll ends every subscription; used at server shutdown so open streams
// don't hold the daemon alive.
func (h *hub) closeAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		delete(h.subs, ch)
		close(ch)
	}
}

func (h *hub) broadcast(ev event.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// Start launches the capture engine: the spool tailer, the codex session
// watcher (when a sessions directory exists), and the agent process watcher
// all feed the live hub. Codex events are read straight from its files, so
// they are redacted here; spooled events were redacted at append time.
func (s *Server) Start(ctx context.Context) {
	mode, err := privacy.ParseMode(s.cfg.PrivacyMode)
	if err != nil {
		mode = privacy.ModeBalanced
	}
	raw := make(chan event.Event, 1024)
	go spool.NewTailer(s.cfg.SpoolDir, s.TailInterval).Run(ctx, raw)
	if s.cfg.CodexDir != "" {
		if _, err := os.Stat(s.cfg.CodexDir); err == nil {
			go codex.NewWatcher(s.cfg.CodexDir, s.WatchInterval).Run(ctx, raw)
		}
	}
	go procwatch.NewWatcher(procwatch.PSLister{}, 2*time.Second).Run(ctx, raw)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-raw:
				if ev.Source == codex.Source {
					ev = privacy.Redact(ev, mode)
				}
				s.hub.broadcast(ev)
			}
		}
	}()
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	fl.Flush()

	ch := s.hub.subscribe()
	defer s.hub.unsubscribe(ch)
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return // hub closed the subscription (daemon shutting down)
			}
			data, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			fl.Flush()
		}
	}
}
