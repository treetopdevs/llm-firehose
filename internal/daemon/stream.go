package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
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
	cfg := s.config()

	// Prime the tailer before building the index: everything before the
	// boundary is covered by the build, everything after by the tail, and
	// the index's per-id dedupe absorbs the overlap.
	tailer := spool.NewTailer(cfg.SpoolDir, s.TailInterval)
	tailer.Prime()
	s.ensureIndex()

	// Spooled events (already redacted at append time) update the derived
	// index and are broadcast by the tail loop. Watcher events (codex files,
	// procwatch) are redacted here — the engine boundary — and persisted to
	// the spool, the canonical source of truth; the tailer then indexes and
	// broadcasts them like any other event, so a rebuilt index sees them too.
	spooled := make(chan event.Event, 1024)
	watched := make(chan event.Event, 1024)
	go tailer.Run(ctx, spooled)
	if cfg.CodexDir != "" {
		if _, err := os.Stat(cfg.CodexDir); err == nil {
			cursorPath := filepath.Join(s.home, ".agentfirehose", "state", "codex-cursors.json")
			watcher := codex.NewDurableWatcher(
				cfg.CodexDir,
				cursorPath,
				s.WatchInterval,
				func(ev event.Event) error {
					// Append is synchronous: the watcher checkpoints the line
					// only after this returns success.
					ev = privacy.Redact(ev, s.privacyMode())
					return spool.NewWriter(s.config().SpoolDir).Append(ev)
				},
			)
			// Establish the legacy-file baseline before Start returns. A fresh
			// Codex task launched after /health is ready cannot race into the
			// initial baseline and disappear.
			_ = watcher.Initialize()
			go watcher.Run(ctx)
		}
	}
	go procwatch.NewWatcher(s.ProcLister, s.ProcInterval).Run(ctx, watched)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-spooled:
				if tr := s.ensureIndex().Apply(ev); tr != nil {
					s.hub.broadcast(*tr)
				}
				s.hub.broadcast(ev)
			case ev := <-watched:
				// Mode is re-read per event so POST /config privacy
				// changes apply live to this capture path too.
				ev = privacy.Redact(ev, s.privacyMode())
				if err := spool.NewWriter(s.config().SpoolDir).Append(ev); err != nil {
					// Capture must never go dark: an unwritable spool
					// degrades to the old broadcast-only behavior.
					s.hub.broadcast(ev)
				}
			}
		}
	}()

	// Idle ticker: promote quiet working sessions to idle and push
	// stream-only transitions so clients can animate without polling.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				for _, tr := range s.ensureIndex().AdvanceIdle(now) {
					if tr != nil {
						s.hub.broadcast(*tr)
					}
				}
			}
		}
	}()
}

// privacyMode is the effective redaction mode, falling back to balanced.
func (s *Server) privacyMode() privacy.Mode {
	mode, err := privacy.ParseMode(s.config().PrivacyMode)
	if err != nil {
		return privacy.ModeBalanced
	}
	return mode
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
