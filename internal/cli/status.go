package cli

import (
	"fmt"
	"io"

	"agentfirehose/internal/client"
)

// Status probes the configured daemon, writes a one-line report, and returns
// whether it is running.
func Status(cfg Config, w io.Writer) bool {
	addr := cfg.DaemonAddr
	if addr == "" {
		addr = DefaultDaemonAddr
	}
	h, err := client.New("http://" + addr).Health()
	if err != nil {
		fmt.Fprintf(w, "firehose daemon not running at %s (%v)\n", addr, err)
		return false
	}
	fmt.Fprintf(w, "firehose daemon running at %s — version %s, schema v%d\n",
		addr, h.Version, h.SchemaVersion)
	return true
}
