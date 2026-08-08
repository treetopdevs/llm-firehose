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
	mapped, err := json.Marshal(Manifest.Mapped)
	if err != nil {
		return nil, err
	}
	filtered, err := json.Marshal(Manifest.Filtered)
	if err != nil {
		return nil, err
	}
	return []byte(`// Agent Firehose forwarder — installed by ` + "`firehose install opencode`" + `.
// Forwards OpenCode bus events to the local Agent Firehose spool.
export const AgentFirehose = async ({ directory }) => {
  const mappedTypes = new Set(` + string(mapped) + `);
  const filteredTypes = new Set(` + string(filtered) + `);
  const warnedUnknownTypes = new Set();
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
      const type = event?.type ?? "";
      if (filteredTypes.has(type)) return;
      if (type === "message.part.updated") {
        const part = event?.properties?.part ?? {};
        if (part.type === "text" || part.type === "reasoning" || part.type === "step-start") return;
        if (part.type === "tool") {
          const status = part?.state?.status ?? "";
          if (status !== "completed" && status !== "error") return;
        }
      }
      if (!mappedTypes.has(type)) {
        if (warnedUnknownTypes.has(type)) return;
        warnedUnknownTypes.add(type);
      }
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
