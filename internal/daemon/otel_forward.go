package daemon

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
)

const (
	// forwardQueueDepth bounds memory per signal; beyond it the oldest queued
	// batch is dropped so a stalled collector costs telemetry, never the agent.
	forwardQueueDepth = 64
	forwardTimeout    = 3 * time.Second
)

type forwardJob struct {
	url, contentType, contentEncoding string
	body                              []byte
}

// otelForwarder tees the OTLP/HTTP JSON batches the receiver accepts to the
// user's pre-existing loopback collector, as recorded by
// `firehose install claude-otel --forward`. It is best-effort and strictly
// off the request path: at-most-once, bounded, and silent to the exporter.
type otelForwarder struct {
	home    string
	ownAddr func() string
	client  *http.Client
	stop    <-chan struct{}
	warn    func(signal string, err error)

	dropped atomic.Int64

	mu      sync.Mutex
	cached  cli.OTelForwardTargets
	modTime time.Time
	size    int64
	loaded  bool
	queues  map[string]chan forwardJob
	failing map[string]bool
}

func newOTelForwarder(home string, ownAddr func() string, stop <-chan struct{}, warn func(string, error)) *otelForwarder {
	return &otelForwarder{
		home:    home,
		ownAddr: ownAddr,
		stop:    stop,
		warn:    warn,
		client: &http.Client{
			Timeout: forwardTimeout,
			// A relay must never follow a redirect off the validated target.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		queues:  map[string]chan forwardJob{},
		failing: map[string]bool{},
	}
}

// targets returns the validated forward destinations, re-reading the record
// when it changes so an install takes effect without a daemon restart.
func (f *otelForwarder) targets() cli.OTelForwardTargets {
	f.mu.Lock()
	defer f.mu.Unlock()
	info, err := os.Stat(cli.OTelForwardPath(f.home))
	if err != nil {
		f.cached, f.loaded = cli.OTelForwardTargets{}, false
		return f.cached
	}
	if f.loaded && info.ModTime().Equal(f.modTime) && info.Size() == f.size {
		return f.cached
	}
	targets, err := cli.LoadOTelForward(f.home)
	if err != nil {
		targets = cli.OTelForwardTargets{}
	}
	own := f.ownAddr()
	if cli.ValidateOTelForwardTarget(targets.Logs, own) != nil {
		targets.Logs = ""
	}
	if cli.ValidateOTelForwardTarget(targets.Metrics, own) != nil {
		targets.Metrics = ""
	}
	targets.OriginalEnv = nil
	f.cached, f.modTime, f.size, f.loaded = targets, info.ModTime(), info.Size(), true
	return f.cached
}

// forward queues raw (unmodified) for the signal's collector. It never blocks.
func (f *otelForwarder) forward(signal string, raw []byte, h http.Header) {
	targets := f.targets()
	target := targets.Logs
	if signal == "metrics" {
		target = targets.Metrics
	}
	if target == "" {
		return
	}
	job := forwardJob{url: target, body: raw, contentType: h.Get("Content-Type"), contentEncoding: h.Get("Content-Encoding")}
	f.mu.Lock()
	queue, ok := f.queues[signal]
	if !ok {
		queue = make(chan forwardJob, forwardQueueDepth)
		f.queues[signal] = queue
		go f.run(signal, queue)
	}
	f.mu.Unlock()
	for {
		select {
		case queue <- job:
			return
		default:
		}
		select {
		case <-queue: // drop the oldest to make room
			f.dropped.Add(1)
		default:
		}
	}
}

func (f *otelForwarder) run(signal string, queue <-chan forwardJob) {
	for {
		select {
		case <-f.stop:
			return
		case job := <-queue:
			err := f.send(job)
			f.mu.Lock()
			was := f.failing[signal]
			f.failing[signal] = err != nil
			f.mu.Unlock()
			if err != nil && !was && f.warn != nil {
				f.warn(signal, err)
			}
		}
	}
}

func (f *otelForwarder) send(job forwardJob) error {
	ctx, cancel := context.WithTimeout(context.Background(), forwardTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, job.url, bytes.NewReader(job.body))
	if err != nil {
		return err
	}
	if job.contentType != "" {
		req.Header.Set("Content-Type", job.contentType)
	}
	if job.contentEncoding != "" {
		req.Header.Set("Content-Encoding", job.contentEncoding)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("collector answered %s", resp.Status)
	}
	return nil
}

// warnForwardFailure surfaces a failing relay in the timeline (once per
// outage per signal) instead of interrupting anything.
func (s *Server) warnForwardFailure(signal string, err error) {
	_, _ = s.engine.Admit(context.Background(), event.Event{
		Time:     time.Now().UTC(),
		Source:   "firehose",
		Category: event.CategoryMeta,
		Name:     "otel_forward_error",
		Severity: event.SeverityWarn,
		Summary:  "forwarding Claude " + signal + " telemetry to your existing collector failed",
		Payload: map[string]any{
			"signal": signal,
			"error":  err.Error(),
		},
	})
}
