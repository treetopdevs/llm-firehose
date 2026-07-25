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
		`status !== "completed" && status !== "error"`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("plugin missing manifest-driven filter %q:\n%s", want, js)
		}
	}
	if strings.Count(js, `"session.created"`) != 1 {
		t.Errorf("mapped type list drifted or was duplicated:\n%s", js)
	}
}
