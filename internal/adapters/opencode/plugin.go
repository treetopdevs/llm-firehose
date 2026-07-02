package opencode

import (
	"os"
	"path/filepath"
)

// PluginFileName is the file `firehose install opencode` writes into
// ~/.config/opencode/plugin/.
const PluginFileName = "agent-firehose.js"

// pluginJS forwards every OpenCode bus event to `firehose emit`. Plugins run
// under Bun inside the OpenCode server process.
const pluginJS = `// Agent Firehose forwarder — installed by ` + "`firehose install opencode`" + `.
// Forwards OpenCode bus events to the local Agent Firehose spool.
export const AgentFirehose = async ({ directory }) => {
  const forward = (payload) => {
    try {
      const proc = Bun.spawn(["firehose", "emit", "--source", "opencode"], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch (_) {
      // never break the agent because the viewer is missing
    }
  };
  return {
    event: async ({ event }) => {
      forward({ ...event, directory });
    },
  };
};
`

// WritePlugin writes the forwarder plugin into dir and returns its path.
func WritePlugin(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, PluginFileName)
	if err := os.WriteFile(path, []byte(pluginJS), 0o644); err != nil {
		return "", err
	}
	return path, nil
}
