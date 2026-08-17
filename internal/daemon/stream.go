package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// handleStream adapts one bounded Capture Engine subscription to the frozen
// SSE interface. Subscription termination closes the response; clients reload
// durable history before opening a replacement stream.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	subscription := s.engine.Subscribe(r.Context())
	for {
		select {
		case <-s.shutdown:
			return
		case <-r.Context().Done():
			return
		case <-subscription.Done:
			return
		case ev, ok := <-subscription.Events:
			if !ok {
				return
			}
			data, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}
