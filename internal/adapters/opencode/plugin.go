package opencode

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// PluginFileName is the file `firehose install opencode` writes into
// ~/.config/opencode/plugin/.
const PluginFileName = "agent-firehose.js"

// pluginJS forwards every OpenCode bus event through the configured
// fail-silent executable. Plugins run under Bun inside the OpenCode server
// process.
func pluginJS(binPath string) ([]byte, error) {
	command, err := json.Marshal([]string{binPath, "hook-forward", "--source", Source})
	if err != nil {
		return nil, err
	}
	return []byte(`// Agent Firehose forwarder — installed by ` + "`firehose install opencode`" + `.
// Forwards OpenCode bus events to the local Agent Firehose spool.
export const AgentFirehose = async ({ directory }) => {
  const forward = (payload) => {
    try {
      const proc = Bun.spawn(` + string(command) + `, {
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
`), nil
}

// WritePlugin writes the forwarder plugin into dir and returns its path.
func WritePlugin(dir, binPath string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	content, err := pluginJS(binPath)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, PluginFileName)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return "", err
	}
	return path, nil
}
