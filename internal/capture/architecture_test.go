package capture_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestCaptureImplementationDependenciesStaySealed(t *testing.T) {
	repoRoot := filepath.Clean(filepath.Join("..", ".."))
	for _, removed := range []string{"internal/spool", "internal/index"} {
		if _, err := os.Stat(filepath.Join(repoRoot, removed)); !os.IsNotExist(err) {
			t.Errorf("superseded package still exists: %s", removed)
		}
	}

	for _, root := range []string{"cmd", "internal/daemon", "internal/cli", "internal/host", "internal/tui"} {
		err := filepath.WalkDir(filepath.Join(repoRoot, root), func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			for _, spec := range file.Decls {
				decl, ok := spec.(*ast.GenDecl)
				if !ok || decl.Tok != token.IMPORT {
					continue
				}
				for _, raw := range decl.Specs {
					importSpec := raw.(*ast.ImportSpec)
					pathValue, err := strconv.Unquote(importSpec.Path.Value)
					if err != nil {
						return err
					}
					if pathValue == "agentfirehose/internal/spool" ||
						pathValue == "agentfirehose/internal/index" ||
						strings.HasPrefix(pathValue, "agentfirehose/internal/capture/internal/") {
						t.Errorf("%s imports sealed capture implementation %q", path, pathValue)
					}
					if (root == "cmd" || root == "internal/tui") &&
						(pathValue == "agentfirehose/internal/privacy" ||
							pathValue == "agentfirehose/internal/workspace" ||
							pathValue == "agentfirehose/internal/adapters/codex" ||
							pathValue == "agentfirehose/internal/adapters/procwatch") {
						t.Errorf("%s reconstructs Capture Engine behavior through %q", path, pathValue)
					}
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
