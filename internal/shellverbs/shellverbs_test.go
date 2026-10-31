package shellverbs

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestLifecycleKindsTable(t *testing.T) {
	bash := func(cmd string) string {
		b, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": cmd}})
		return string(b)
	}
	cases := []struct {
		name, raw string
		want      []string
	}{
		{"commit-tree", bash("git commit-tree abc"), nil},
		{"global -c", bash("git -c user.name=x commit -m m"), []string{"commit"}},
		{"env prefix", bash("FOO=1 git push"), []string{"push"}},
		{"abs path git", bash("/usr/bin/git commit --amend"), []string{"commit"}},
		{"quoted &&", bash("git commit -m 'a && git push'"), []string{"commit"}},
		{"chain", bash("git add . && git commit -m x && git push origin HEAD"), []string{"commit", "push"}},
		{"dup kinds", bash("git commit -m a; git commit -m b"), []string{"commit"}},
		{"quoted heredoc msg", bash("git commit -F - <<'EOF'\nfix\ngit push\nEOF"), []string{"commit"}},
		{"unquoted heredoc", bash("cat <<EOF\ngit push\nEOF"), nil},
		{"heredoc then command", bash("cat <<EOF > f\ngit push\nEOF\ngit commit -m x"), []string{"commit"}},
		{"gh pr create heredoc", bash("gh pr create --title t --body \"$(cat <<'EOF'\ngit commit\nEOF\n)\""), []string{"pr_create"}},
		{"gh pr create body-file heredoc", bash("gh pr create --body-file - <<'EOF'\ngit commit\nEOF"), []string{"pr_create"}},
		{"pipeline", bash("git push 2>&1 | tail"), []string{"push"}},
		{"gh -R merge", bash("gh -R o/r pr merge 3"), []string{"pr_merge"}},
		{"gh pr view", bash("gh pr view 3"), nil},
		{"worktree list", bash("git worktree list"), nil},
		{"worktree add", bash("git worktree add x"), []string{"worktree_add"}},
		{"worktree remove", bash("git worktree remove --force x"), []string{"worktree_remove"}},
		{"git -C worktree remove", bash("git -C /a worktree remove /b"), []string{"worktree_remove"}},
		{"comment", bash("ls # git push"), nil},
		{"escaped quote", bash(`echo \"; git push`), []string{"push"}},
		{"commit or true", bash("git commit -m x || true"), nil},
		{"push or echo", bash("git push || echo failed"), nil},
		{"or then and", bash("git commit -m x || true && git push"), []string{"push"}},
		{"push dry-run", bash("git push --dry-run"), nil},
		{"push -n", bash("git push -n origin HEAD"), nil},
		{"commit dry-run", bash("git commit --dry-run"), nil},
		{"commit -n is no-verify", bash("git commit -n -m x"), []string{"commit"}},
		{"pr merge help", bash("gh pr merge --help"), nil},
		{"pr merge squash", bash("gh pr merge 3 --squash --delete-branch"), []string{"pr_merge"}},
		{"Shell tool", `{"tool_name":"Shell","tool_input":{"command":"git push"}}`, []string{"push"}},
		{"Read tool", `{"tool_name":"Read","tool_input":{"command":"git push"}}`, nil},
		{"empty", "", nil},
		{"invalid json with git", "git {", nil},
		{"non-string command", `{"tool_name":"Bash","tool_input":{"command":["git","push"]}}`, nil},
		{"no tool_input", `{"tool_name":"Bash","git":1}`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Kinds(c.raw); !reflect.DeepEqual(got, c.want) {
				t.Errorf("Kinds=%v, want %v", got, c.want)
			}
		})
	}
}

func hugeRaw(big string, tail string) string {
	return `{"tool_response":{"stdout":"` + big + `"},"tool_name":"Bash","tool_input":{"command":"git commit -m x"}` + tail + `}`
}

func TestLifecycleParserIsBoundedOnHugeToolResponse(t *testing.T) {
	big := strings.Repeat("x", 5<<20)
	raw := hugeRaw(big, `,"tool_response2":{"stdout":"`+big+`"}`)
	if got := Kinds(raw); !reflect.DeepEqual(got, []string{"commit"}) {
		t.Fatalf("got %v", got)
	}
	// Streaming stops after tool_input: garbage after it is never read.
	if got := Kinds(hugeRaw("", `,garbage not json`)); !reflect.DeepEqual(got, []string{"commit"}) {
		t.Fatalf("decoder read past tool_input: %v", got)
	}
	// tool_name after tool_input is still found.
	late := `{"tool_input":{"command":"git push"},"tool_response":"` + big + `","tool_name":"Bash"}`
	if got := Kinds(late); !reflect.DeepEqual(got, []string{"push"}) {
		t.Fatalf("late tool_name: %v", got)
	}
	// No git/gh substring: no decoding, so invalid JSON is simply none.
	if got := Kinds(`{{{ not json ` + strings.Repeat("a", 1<<20)); got != nil {
		t.Fatalf("prefilter: %v", got)
	}
}

func BenchmarkLifecycleKinds(b *testing.B) {
	raw := hugeRaw(strings.Repeat("x", 5<<20), "")
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if len(Kinds(raw)) != 1 {
			b.Fatal("no commit")
		}
	}
}

// Skipped branches and uncalled function bodies run nothing, so they leave no
// mark; commands that did run still do.
func TestLifecycleSkipsUnestablishedExecution(t *testing.T) {
	bash := func(cmd string) string {
		b, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": cmd}})
		return string(b)
	}
	cases := []struct {
		name, cmd string
		want      []string
	}{
		{"if false then merge", "if false; then gh pr merge 3; fi", nil},
		{"else branch", "if true; then :; else git push; fi", nil},
		{"elif branch", "if true; then :; elif x; then git commit -m x; fi", nil},
		{"if condition runs", "if git commit -m x; then echo ok; fi", []string{"commit"}},
		{"for body", "for f in a; do git commit -m $f; done", nil},
		{"while body", "while false; do git push; done", nil},
		{"case arm", "case x in y) git commit -m x;; esac", nil},
		{"function body not called", "f() { git commit -m x; }; echo hi", nil},
		{"function body one line", "f() { git push; }", nil},
		{"function keyword", "function f { git push; }\ntrue", nil},
		{"function keyword parens", "function f() {\n git push\n}\ngit commit -m x", []string{"commit"}},
		{"after function", "f() { git push; }; git commit -m x", []string{"commit"}},
		{"brace group runs", "{ git commit -m x; }", []string{"commit"}},
		{"subshell runs", "(cd x && git commit -m x)", []string{"commit"}},
		{"and in earlier list", "false && git commit -m x; true", nil},
		{"and in final list", "git add . && git commit -m x", []string{"commit"}},
		{"or fallback", "false || git commit -m x", nil},
		{"or in earlier list", "a || b; git push", []string{"push"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Kinds(bash(c.cmd)); !reflect.DeepEqual(got, c.want) {
				t.Errorf("Kinds(%q)=%v, want %v", c.cmd, got, c.want)
			}
		})
	}
}

// Only a plain `gh pr merge` that targets the current branch, as the command's
// last step, is a verified self-merge.
func TestLifecycleSelfMerge(t *testing.T) {
	bash := func(cmd string) string {
		b, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": cmd}})
		return string(b)
	}
	cases := []struct {
		cmd  string
		want bool
	}{
		{"gh pr merge --squash --delete-branch", true},
		{"git push && gh pr merge --squash", true},
		{"gh pr merge -t 'a title' -d", true},
		{"gh -R o/r pr merge --squash", true},
		{"gh pr merge 123", false},
		{"gh pr merge https://github.com/o/r/pull/9", false},
		{"gh pr merge some-branch --squash", false},
		{"gh pr merge --auto --squash", false},
		{"gh pr merge --squash || true", false},
		{"gh pr merge --squash; echo done", false},
		{"gh pr merge --squash &", false},
		{"! gh pr merge --squash", false},
		{"if false; then gh pr merge --squash; fi", false},
		{"gh pr merge --dry-run", false},
		{"git commit -m x", false},
	}
	for _, c := range cases {
		if _, got := Lifecycle(bash(c.cmd)); got != c.want {
			t.Errorf("selfMerge(%q)=%v, want %v", c.cmd, got, c.want)
		}
	}
}

func bashJSON(cmd string) string {
	b, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": cmd}})
	return string(b)
}

func TestLifecycleEscapedJSONCommand(t *testing.T) {
	raw := `{"tool_name":"Bash","tool_input":{"command":"g\u0069t commit -m x"}}`
	got, _ := Lifecycle(raw)
	if !reflect.DeepEqual(got, []string{KindCommit}) {
		t.Fatalf("escaped: %v", got)
	}
	want, _ := CommandKinds("git commit -m x")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lifecycle %v != CommandKinds %v", got, want)
	}
	if k, _ := Lifecycle(`{"tool_name":"Bash","tool_input":{"command":"ls"},"x":"` + strings.Repeat("a", 1<<16) + `"}`); k != nil {
		t.Fatalf("no git/gh/escape must short-circuit: %v", k)
	}
}

func TestCommandKinds(t *testing.T) {
	k, sm := CommandKinds("git add -A && git commit -m x && git push")
	if !reflect.DeepEqual(k, []string{KindCommit, KindPush}) || sm {
		t.Fatalf("chain: %v %v", k, sm)
	}
	k, sm = CommandKinds("gh pr merge --squash")
	if !reflect.DeepEqual(k, []string{KindPRMerge}) || !sm {
		t.Fatalf("merge: %v %v", k, sm)
	}
	// Option values that look like no-op flags do not suppress the mark.
	for c, want := range map[string]string{
		`git commit -m "--dry-run"`:        KindCommit,
		`git commit -m -h`:                 KindCommit,
		`git push -o --help origin`:        KindPush,
		`gh pr create --title --dry-run`:   KindPRCreate,
		`git commit -m x --dry-run`:        "",
		`git commit -m "--dry-run" --help`: "",
	} {
		k, _ := CommandKinds(c)
		if want == "" && k != nil || want != "" && !reflect.DeepEqual(k, []string{want}) {
			t.Errorf("%q: %v, want %q", c, k, want)
		}
	}
	for _, c := range []string{"git status", "git commit --dry-run", ""} {
		if k, sm := CommandKinds(c); k != nil || sm {
			t.Errorf("%q: %v %v", c, k, sm)
		}
	}
}

func TestCommandKindsAgreesWithLifecycle(t *testing.T) {
	for _, c := range []string{"git commit -m x", "git add . && git commit -m x && git push origin HEAD", "gh pr merge 3 --squash", "gh pr merge --squash",
		"git commit -m x || true", "if false; then gh pr merge 3; fi", "f() { git push; }", "git worktree add x", "ls # git push", "git -C /a worktree remove /b"} {
		k1, s1 := CommandKinds(c)
		k2, s2 := Lifecycle(bashJSON(c))
		if !reflect.DeepEqual(k1, k2) || s1 != s2 {
			t.Errorf("%q: %v,%v vs %v,%v", c, k1, s1, k2, s2)
		}
	}
}

func TestPhrases(t *testing.T) {
	if got := Phrases([]string{KindWorktreeAdd, KindCommit, KindPush}); got != "git worktree add, git commit, git push" {
		t.Errorf("got %q", got)
	}
	if Phrases(nil) != "" {
		t.Error("nil")
	}
	all := []string{KindWorktreeAdd, KindWorktreeRemove, KindCommit, KindPush, KindPRCreate, KindPRMerge}
	if got := Phrases(all); got != "git worktree add, git worktree remove, git commit, git push, gh pr create, gh pr merge" {
		t.Errorf("all: %q", got)
	}
	if got := Phrases([]string{"bogus", KindPush, KindPush}); got != "git push" {
		t.Errorf("unknown/dupes: %q", got)
	}
	if got := Phrases(append(all, all...)); strings.Count(got, ",") != 5 {
		t.Errorf("max 6: %q", got)
	}
}

func TestKindsFromSummary(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"ran shell tool: git commit, git push", []string{KindCommit, KindPush}},
		{"ran shell tool", nil},
		{"ran shell tool: ", nil},
		{"ran shell tool: git rebase", nil},
		{"ran shell tool: git commit, git rebase", nil},
		{"ran shell tool: git push, git push", []string{KindPush}},
		{"interrupted shell tool: git commit", nil},
		{"will run shell tool: git commit", nil},
		{"failed shell tool: git push", nil},
		{"ran shell tool: git commit -m secret", nil},
		{"ran Read on x: git push", nil},
		{"ran shell tool: git worktree add, git worktree remove, git commit, git push, gh pr create, gh pr merge, git push", []string{KindWorktreeAdd, KindWorktreeRemove, KindCommit, KindPush, KindPRCreate, KindPRMerge}},
		{"ran shell tool: git push, git push, git push, git push, git push, git push, git rebase", []string{KindPush}},
	}
	for _, c := range cases {
		if got := KindsFromSummary(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: got %v want %v", c.in, got, c.want)
		}
	}
}

func TestPhraseRoundTrip(t *testing.T) {
	for _, k := range []string{KindWorktreeAdd, KindWorktreeRemove, KindCommit, KindPush, KindPRCreate, KindPRMerge} {
		if got := KindsFromSummary(SummaryPrefixRan + Phrases([]string{k})); !reflect.DeepEqual(got, []string{k}) {
			t.Errorf("%s: %v", k, got)
		}
	}
}

func TestSummaryGrammarPinned(t *testing.T) {
	if SummaryPrefixRan != "ran shell tool: " || SummarySep != ", " {
		t.Fatalf("grammar changed: %q %q", SummaryPrefixRan, SummarySep)
	}
}

func TestLifecycleConditionalBodies(t *testing.T) {
	cases := []struct {
		name, cmd string
		want      []string
	}{
		{"if one-line", "if false; then :; git commit -m x; fi", nil},
		{"if/elif/else multiline", "if a\nthen\n  git commit -m x\nelif b\nthen\n  git push\nelse\n  git commit -m y\nfi", nil},
		{"for loop", "for f in a b; do echo $f; git push; done", nil},
		{"while loop", "while true; do git commit -m x; break; done", nil},
		{"nested", "if a; then for x in y; do git push; done; fi", nil},
		{"nested on one segment", "if a; then if b; then git push; fi; fi", nil},
		{"commands outside count", "git commit -m x; if a; then b; fi; git push", []string{"commit", "push"}},
		{"multiline outside", "git commit -m x\nif a; then b; fi", []string{"commit"}},
		{"after loop", "for x in a; do b; done\ngit push", []string{"push"}},
		{"stray closer floors at zero", "fi; git push", []string{"push"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got, _ := CommandKinds(c.cmd); !reflect.DeepEqual(got, c.want) {
				t.Errorf("CommandKinds(%q)=%v, want %v", c.cmd, got, c.want)
			}
		})
	}
}

func TestLifecycleNestedSubstitutionQuotes(t *testing.T) {
	cases := []struct {
		name, cmd string
		want      []string
	}{
		{"counterexample", `echo "$(printf "%s" "x; git commit -m x")"`, nil},
		{"backtick variant", "echo \"`printf \"%s\" \"x; git commit -m x\"`\"", nil},
		{"heredoc in substitution", "git commit -m \"$(cat <<'EOF'\nmsg; git push\nEOF\n)\"", []string{"commit"}},
		{"heredoc apostrophe", "git commit -m \"$(cat <<'EOF'\nit's; git push\nEOF\n)\"", []string{"commit"}},
		{"nested then chain", `git commit -m "a $(date "+%Y; x") b" && git push`, []string{"commit", "push"}},
		{"unterminated", `echo "$(git commit`, nil},
		{"unterminated backtick", "echo \"`git commit", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got, _ := CommandKinds(c.cmd); !reflect.DeepEqual(got, c.want) {
				t.Errorf("CommandKinds(%q)=%v, want %v", c.cmd, got, c.want)
			}
		})
	}
}

// Option arity is per command: bare switches never swallow --help/--dry-run.
func TestLifecycleOptionArityPerCommand(t *testing.T) {
	cases := []struct {
		name, cmd string
		want      []string
		selfMerge bool
	}{
		{"merge -r help", "gh pr merge -r --help", nil, false},
		{"merge -s dry", "gh pr merge -s --dry-run", nil, false},
		{"merge -d help", "gh pr merge -d -h", nil, false},
		{"merge -r real", "gh pr merge -r", []string{"pr_merge"}, true},
		{"merge body value", "gh pr merge -b --help", []string{"pr_merge"}, true},
		{"commit -a dry", "git commit -a --dry-run", nil, false},
		{"commit -am msg dry", "git commit -am msg --dry-run", nil, false},
		{"commit -am value is dry-run text", "git commit -am --dry-run", []string{"commit"}, false},
		{"commit -m value help", "git commit -m --help", []string{"commit"}, false},
		{"commit attached value", "git commit -mfoo --dry-run", nil, false},
		{"commit long value", "git commit --message --dry-run", []string{"commit"}, false},
		{"commit -a real", "git commit -a -m x", []string{"commit"}, false},
		{"push -n", "git push -n", nil, false},
		{"push -fn", "git push -fn origin", nil, false},
		{"push -o value", "git push -o -n", []string{"push"}, false},
		{"pr create -r value", "gh pr create -r --help", []string{"pr_create"}, false},
		{"pr create -d dry", "gh pr create -d --dry-run", nil, false},
		{"pr create -f help", "gh pr create -f --help", nil, false},
		{"worktree add -b value", "git worktree add -b --help x", []string{"worktree_add"}, false},
		{"worktree remove -f help", "git worktree remove -f --help x", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, sm := CommandKinds(c.cmd)
			if !reflect.DeepEqual(got, c.want) || sm != c.selfMerge {
				t.Errorf("CommandKinds(%q)=%v,%v want %v,%v", c.cmd, got, sm, c.want, c.selfMerge)
			}
		})
	}
}

func TestLifecycleHereStringAndMultilineCondition(t *testing.T) {
	cases := []struct {
		name, cmd string
		want      []string
	}{
		{"here-string in substitution", "git commit -m \"$(cat <<< 'message'\n)\"", []string{"commit"}},
		{"here-string then push", "git commit -F - <<< 'msg'\ngit push", []string{"commit", "push"}},
		{"here-string inline", "cat <<< 'x'; git push", []string{"push"}},
		{"multiline if condition", "if\n  git commit -m x\nthen\n  :\nfi", []string{"commit"}},
		{"multiline if body stays skipped", "if\n  true\nthen\n  git commit -m x\nfi", nil},
		{"multiline while condition", "while\n  git push\ndo\n  break\ndone", []string{"push"}},
		{"multiline elif skipped", "if\n  a\nthen\n  :\nelif\n  git push\nthen\n  :\nfi", nil},
		{"after multiline if", "if\n  a\nthen\n  b\nfi\ngit push", []string{"push"}},
		{"for header runs nothing", "for f in a\ndo\n  git push\ndone", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got, _ := CommandKinds(c.cmd); !reflect.DeepEqual(got, c.want) {
				t.Errorf("CommandKinds(%q)=%v, want %v", c.cmd, got, c.want)
			}
		})
	}
}
