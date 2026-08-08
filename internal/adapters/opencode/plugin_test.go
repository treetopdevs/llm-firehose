package opencode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWritePlugin(t *testing.T) {
	dir := t.TempDir()
	path, err := WritePlugin(dir, "/Applications/Agent Firehose/firehosed")
	if err != nil {
		t.Fatalf("WritePlugin: %v", err)
	}
	if filepath.Dir(path) != dir {
		t.Errorf("plugin written outside dir: %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read plugin: %v", err)
	}
	js := string(data)
	if !strings.Contains(js, `["/Applications/Agent Firehose/firehosed","hook-forward","--source","opencode"]`) {
		t.Errorf("plugin should use the configured fail-silent executable:\n%s", js)
	}
	for _, want := range []string{
		`const mappedTypes = new Set(`,
		`const filteredTypes = new Set(`,
		`const warnedUnknownTypes = new Set()`,
		`part.type === "text"`,
		`part.type === "reasoning"`,
		`part.type === "step-start"`,
		`status !== "completed" && status !== "error"`,
		`"message.part.delta"`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("plugin missing manifest-driven filter %q:\n%s", want, js)
		}
	}
	// The mapped set must carry every manifest family exactly once so the
	// plugin filter and parser manifest cannot drift independently.
	for _, mapped := range Manifest.Mapped {
		want := 1
		if mapped == "message.part.updated" {
			want = 2 // once in the mapped set, once in the part-type filter
		}
		if strings.Count(js, `"`+mapped+`"`) != want {
			t.Errorf("mapped type %q drifted or was duplicated:\n%s", mapped, js)
		}
	}
}
