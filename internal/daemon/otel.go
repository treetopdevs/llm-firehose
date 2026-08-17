package daemon

import (
	"context"
	"io"
	"mime"
	"net/http"
	"time"

	"agentfirehose/internal/adapters/claudeotel"
	"agentfirehose/internal/event"
)

const maxOTLPBodyBytes = 1 << 20

func (s *Server) handleOTLPLogs(w http.ResponseWriter, r *http.Request) {
	s.handleOTLP(w, r, claudeotel.ParseLogs)
}

func (s *Server) handleOTLPMetrics(w http.ResponseWriter, r *http.Request) {
	s.handleOTLP(w, r, claudeotel.ParseMetrics)
}

func (s *Server) handleOTLP(
	w http.ResponseWriter,
	r *http.Request,
	parse func([]byte, time.Time) []event.Event,
) {
	// Claude's exporter is a non-browser loopback client. Even an allowlisted
	// desktop webview must not be able to inject telemetry-shaped records.
	if r.Header.Get("Origin") != "" {
		http.Error(w, "browser origins are not accepted by the OTLP receiver", http.StatusForbidden)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "OTLP receiver requires application/json", http.StatusUnsupportedMediaType)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxOTLPBodyBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "OTLP request exceeds the local receiver limit", http.StatusRequestEntityTooLarge)
		return
	}

	captured := time.Now().UTC()
	admitCtx := context.WithoutCancel(r.Context())
	for _, native := range parse(raw, captured) {
		// Exporter-facing success never depends on the spool. Hooks remain the
		// canonical daemon-optional baseline if this supplemental append fails.
		_, _ = s.engine.Admit(admitCtx, native)
	}
	writeJSON(w, map[string]any{})
}
