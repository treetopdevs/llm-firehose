package projection

import (
	"encoding/json"
	"path"
	"slices"
	"strings"
)

// Lifecycle mark kinds parsed out of Bash commands.
const (
	kindWorktreeAdd    = "worktree_add"
	kindWorktreeRemove = "worktree_remove"
	kindCommit         = "commit"
	kindPush           = "push"
	kindPRCreate       = "pr_create"
	kindPRMerge        = "pr_merge"
)

// lifecycleKinds returns the distinct lifecycle kinds a claude-code Bash hook
// payload runs, in command order. See lifecycle.
func lifecycleKinds(raw string) []string {
	kinds, _ := lifecycle(raw)
	return kinds
}

// lifecycle returns the distinct lifecycle kinds a claude-code Bash hook
// payload ran, in command order, and whether it verifiably merged this
// worktree's own pull request. It never panics and returns nil for anything it
// cannot read. The raw payload can carry megabytes of tool_response, so it is
// token-streamed (tool_response is skipped, not buffered whole) and reading
// stops as soon as tool_name and tool_input.command are known.
//
// A command counts only when static analysis establishes that it ran: commands
// in a then/do/else branch, a case arm or a function body, commands joined to
// an earlier one by && or || in a list that is not the last, commands that
// directly follow || and commands directly followed by || produce nothing.
//
// selfMerge is stricter: the payload's last command is a plain `gh pr merge`
// without a PR selector (so gh merges the PR of the current branch, i.e. of the
// worktree that issued it) and without --auto, and the hook fired, which for
// PostToolUse means the whole command exited 0.
func lifecycle(raw string) (kinds []string, selfMerge bool) {
	if !strings.Contains(raw, "git") && !strings.Contains(raw, "gh") {
		return nil, false
	}
	tool, command, ok := hookToolCommand(raw)
	if !ok || (tool != "Bash" && tool != "Shell") {
		return nil, false
	}
	segs := shellSegments(command)
	finalList := -1
	if len(segs) > 0 {
		finalList = segs[len(segs)-1].list
	}
	var fl flow
	seen := map[string]bool{}
	for i, seg := range segs {
		if !fl.step(seg) {
			continue // a branch, case arm or function body: execution unestablished
		}
		if seg.orNext || seg.afterOr || seg.cond && seg.list != finalList {
			continue // `cmd || fallback` and conditional chains
		}
		k := segmentKind(seg.words)
		if k == "" {
			continue
		}
		if !seen[k] {
			seen[k] = true
			kinds = append(kinds, k)
		}
		if k == kindPRMerge && i == len(segs)-1 && !seg.background && isSelfMerge(seg.words) {
			selfMerge = true
		}
	}
	return kinds, selfMerge
}

// flow tracks shell constructs whose bodies are not known to execute.
type flow struct {
	funcPending bool // a function header was seen; its body comes next
	funcDepth   int  // inside a function body's braces
	inCase      bool // between `case` and `esac`
}

// step reports whether a segment is outside every unestablished construct.
func (f *flow) step(seg shellSegment) bool {
	w := seg.words
	head := w[0]
	if f.funcDepth > 0 {
		switch head {
		case "{":
			f.funcDepth++
		case "}":
			f.funcDepth--
		}
		return false
	}
	if f.inCase {
		if slices.Contains(w, "esac") {
			f.inCase = false
		}
		return false
	}
	if f.funcPending {
		f.funcPending = false
		if head == "{" {
			f.funcDepth = 1
		}
		return false
	}
	if seg.fnDef {
		f.funcPending = true
		return false
	}
	switch head {
	case "then", "do", "else", "elif":
		return false
	case "case":
		f.inCase = !slices.Contains(w[1:], "esac")
		return false
	case "function":
		if slices.Contains(w, "{") {
			f.funcDepth = 1
		} else {
			f.funcPending = true
		}
		return false
	}
	return true
}

// ghMergeValueFlags take a separate value argument.
var ghMergeValueFlags = map[string]bool{
	"-t": true, "--subject": true, "-b": true, "--body": true, "-F": true, "--body-file": true,
	"-A": true, "--author-email": true, "--match-head-commit": true, "-R": true, "--repo": true,
}

// isSelfMerge reports a `gh pr merge` that targets the current branch's pull
// request: no selector argument, no --auto (which only schedules the merge) and
// no construct that could invert or skip it.
func isSelfMerge(w []string) bool {
	i := 0
	for i < len(w) && (isAssignment(w[i]) || commandPrefixes[w[i]]) {
		switch w[i] {
		case "time", "command", "exec", "nohup", "env":
		default:
			if !isAssignment(w[i]) {
				return false // !, if, while, until, {
			}
		}
		i++
	}
	if i >= len(w) || path.Base(w[i]) != "gh" {
		return false
	}
	args := w[i+1:]
	j := 0
	for j < len(args) && strings.HasPrefix(args[j], "-") {
		if args[j] == "-R" || args[j] == "--repo" {
			j += 2
		} else {
			j++
		}
	}
	if j+1 >= len(args) || args[j] != "pr" || args[j+1] != "merge" {
		return false
	}
	rest := args[j+2:]
	for k := 0; k < len(rest); k++ {
		a := rest[k]
		switch {
		case a == "--auto" || a == "--disable-auto" || a == "--":
			return false
		case ghMergeValueFlags[a]:
			k++
		case strings.HasPrefix(a, "-"):
		default:
			return false // a PR number, URL or branch selector names another target
		}
	}
	return true
}

func hookToolCommand(raw string) (tool, command string, ok bool) {
	dec := json.NewDecoder(strings.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return "", "", false
	}
	haveTool, haveCmd := false, false
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return "", "", false
		}
		key, _ := kt.(string)
		switch key {
		case "tool_name":
			var v any
			if dec.Decode(&v) != nil {
				return "", "", false
			}
			tool, _ = v.(string)
			haveTool = true
		case "tool_input":
			var in map[string]any
			if err := dec.Decode(&in); err != nil {
				// Not an object (or unreadable): no command to find.
				return "", "", false
			}
			command, _ = in["command"].(string)
			haveCmd = command != ""
		default:
			if !skipValue(dec) {
				return "", "", false
			}
		}
		if haveTool && haveCmd {
			return tool, command, true
		}
	}
	return tool, command, haveTool && haveCmd
}

// skipValue consumes one JSON value token by token without holding it whole.
func skipValue(dec *json.Decoder) bool {
	t, err := dec.Token()
	if err != nil {
		return false
	}
	d, ok := t.(json.Delim)
	if !ok || (d != '{' && d != '[') {
		return true
	}
	for depth := 1; depth > 0; {
		t, err := dec.Token()
		if err != nil {
			return false
		}
		if d, ok := t.(json.Delim); ok {
			switch d {
			case '{', '[':
				depth++
			default:
				depth--
			}
		}
	}
	return true
}

// shellSegments splits a command into simple commands, each a list of words
// with quoting removed. Separators are unquoted && || ; | & newline, plus
// unquoted parentheses and backticks. Single quotes, double quotes (without
// parsing $(...) inside them), backslashes, comments and here-document bodies
// are honored, so text that merely mentions git is not a command.
func shellSegments(cmd string) []shellSegment {
	var (
		segs    []shellSegment
		words   []string
		list    int  // index of the current ;-, newline- or &-delimited list
		cond    bool // an && or || already occurred in the current list
		afterOr bool // the next segment directly follows ||
		cur     strings.Builder
		inWord  bool
		pending []heredoc
		n       = len(cmd)
	)
	endWord := func() {
		if inWord {
			words = append(words, cur.String())
			cur.Reset()
			inWord = false
		}
	}
	endSeg := func() bool {
		endWord()
		if len(words) > 0 {
			segs = append(segs, shellSegment{words: words, list: list, cond: cond, afterOr: afterOr})
			words, afterOr = nil, false
			return true
		}
		return false
	}
	newList := func() {
		list++
		cond, afterOr = false, false
	}
	for i := 0; i < n; {
		c := cmd[i]
		switch {
		case c == ' ' || c == '\t' || c == '\r':
			endWord()
			i++
		case c == '\n':
			endSeg()
			newList()
			i++
			for _, h := range pending {
				i = skipHeredoc(cmd, i, h)
			}
			pending = pending[:0]
		case c == '\\':
			if i+1 < n {
				if cmd[i+1] != '\n' {
					cur.WriteByte(cmd[i+1])
					inWord = true
				}
				i += 2
			} else {
				i++
			}
		case c == '\'':
			inWord = true
			j := strings.IndexByte(cmd[i+1:], '\'')
			if j < 0 {
				cur.WriteString(cmd[i+1:])
				i = n
			} else {
				cur.WriteString(cmd[i+1 : i+1+j])
				i += j + 2
			}
		case c == '"':
			inWord = true
			i++
			for i < n && cmd[i] != '"' {
				if cmd[i] == '\\' && i+1 < n && strings.IndexByte("\"\\$`\n", cmd[i+1]) >= 0 {
					if cmd[i+1] != '\n' {
						cur.WriteByte(cmd[i+1])
					}
					i += 2
					continue
				}
				cur.WriteByte(cmd[i])
				i++
			}
			i++ // closing quote
		case c == '#' && !inWord:
			for i < n && cmd[i] != '\n' {
				i++
			}
		case c == '<' && strings.HasPrefix(cmd[i:], "<<") && !strings.HasPrefix(cmd[i:], "<<<"):
			h, next := parseHeredocStart(cmd, i)
			endWord()
			pending = append(pending, h)
			i = next
		case c == '&' || c == '|':
			// 2>&1, >&2, &>file and |& keep their meaning inside a word.
			if c == '&' && (strings.HasSuffix(cur.String(), ">") || strings.HasSuffix(cur.String(), "<") || i+1 < n && cmd[i+1] == '>') {
				cur.WriteByte(c)
				inWord = true
				i++
				break
			}
			endSeg()
			i++
			double := i < n && (cmd[i] == c || c == '|' && cmd[i] == '&')
			switch {
			case double && c == '|' && cmd[i] == '|':
				if len(segs) > 0 {
					segs[len(segs)-1].orNext = true
				}
				cond, afterOr = true, true
			case double && c == '&':
				cond = true
			case c == '&':
				if len(segs) > 0 {
					segs[len(segs)-1].background = true
				}
				newList() // a single & ends the list
			}
			if double {
				i++
			}
		case c == ';':
			endSeg()
			newList()
			i++
		case c == '(':
			// `name ( )` defines a function: its body is not run here.
			j := i + 1
			for j < n && (cmd[j] == ' ' || cmd[j] == '\t') {
				j++
			}
			single := len(words) == 1 && !inWord || len(words) == 0 && inWord
			isFn := single && j < n && cmd[j] == ')'
			if endSeg() && isFn {
				segs[len(segs)-1].fnDef = true
			}
			i++
		case c == ')' || c == '`':
			endSeg()
			i++
		default:
			cur.WriteByte(c)
			inWord = true
			i++
		}
	}
	endSeg()
	return segs
}

// shellSegment is one simple command. orNext reports that it is directly
// followed by `||`, so its success is not confirmed by the command finishing;
// afterOr that it only runs when the previous command failed.
type shellSegment struct {
	words   []string
	orNext  bool
	afterOr bool // directly follows ||
	cond    bool // an && or || precedes it within its list
	list    int  // list number: lists end at ; newline and a single &
	fnDef   bool // a function header `name()`
	// background: followed by a single &, so the command's exit status says
	// nothing about it.
	background bool
}

type heredoc struct {
	delim string
	strip bool // <<- ignores leading tabs
}

// parseHeredocStart reads `<<[-] WORD` at cmd[i:] and returns the delimiter
// and the index just past it.
func parseHeredocStart(cmd string, i int) (heredoc, int) {
	i += 2
	h := heredoc{}
	if i < len(cmd) && cmd[i] == '-' {
		h.strip = true
		i++
	}
	for i < len(cmd) && (cmd[i] == ' ' || cmd[i] == '\t') {
		i++
	}
	var b strings.Builder
	for i < len(cmd) {
		c := cmd[i]
		switch {
		case c == '\'' || c == '"':
			j := strings.IndexByte(cmd[i+1:], c)
			if j < 0 {
				b.WriteString(cmd[i+1:])
				i = len(cmd)
			} else {
				b.WriteString(cmd[i+1 : i+1+j])
				i += j + 2
			}
		case c == '\\' && i+1 < len(cmd):
			b.WriteByte(cmd[i+1])
			i += 2
		case strings.IndexByte(" \t\r\n;&|()<>", c) >= 0:
			h.delim = b.String()
			return h, i
		default:
			b.WriteByte(c)
			i++
		}
	}
	h.delim = b.String()
	return h, i
}

// skipHeredoc returns the index after the body that starts at i and ends at a
// line equal to the delimiter (or the end of the command).
func skipHeredoc(cmd string, i int, h heredoc) int {
	for i < len(cmd) {
		end := strings.IndexByte(cmd[i:], '\n')
		line := cmd[i:]
		next := len(cmd)
		if end >= 0 {
			line, next = cmd[i:i+end], i+end+1
		}
		line = strings.TrimSuffix(line, "\r")
		if h.strip {
			line = strings.TrimLeft(line, "\t")
		}
		i = next
		if line == h.delim {
			return i
		}
	}
	return i
}

func isAssignment(w string) bool {
	eq := strings.IndexByte(w, '=')
	if eq <= 0 {
		return false
	}
	for i := 0; i < eq; i++ {
		c := w[i]
		if !(c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || i > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// Words that may precede the command name without changing what runs.
var commandPrefixes = map[string]bool{
	"{": true, "!": true, "then": true, "do": true, "else": true, "elif": true,
	"if": true, "while": true, "until": true, "time": true, "command": true,
	"exec": true, "nohup": true, "env": true,
}

func segmentKind(w []string) string {
	i := 0
	for i < len(w) && (isAssignment(w[i]) || commandPrefixes[w[i]]) {
		i++
	}
	if i >= len(w) {
		return ""
	}
	switch path.Base(w[i]) {
	case "git":
		if k := gitKind(w[i+1:]); k != "" && !noOpInvocation(k, w[i+1:]) {
			return k
		}
	case "gh":
		if k := ghKind(w[i+1:]); k != "" && !noOpInvocation(k, w[i+1:]) {
			return k
		}
	}
	return ""
}

// noOpInvocation reports flags that make the command change nothing:
// --dry-run (and -n for push), --help and -h. Arguments after a bare `--` are
// operands, not flags.
func noOpInvocation(kind string, args []string) bool {
	for _, a := range args {
		switch {
		case a == "--":
			return false
		case a == "--dry-run" || a == "--help" || a == "-h":
			return true
		case a == "-n" && kind == kindPush:
			return true
		}
	}
	return false
}

func gitKind(w []string) string {
	i := 0
	for i < len(w) && strings.HasPrefix(w[i], "-") {
		switch w[i] {
		case "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env":
			i += 2 // option plus its separate argument
		default:
			i++ // -p, -P, --no-pager, --git-dir=x, ...
		}
	}
	if i >= len(w) {
		return ""
	}
	switch w[i] {
	case "commit":
		return kindCommit
	case "push":
		return kindPush
	case "worktree":
		if i+1 < len(w) {
			switch w[i+1] {
			case "add":
				return kindWorktreeAdd
			case "remove":
				return kindWorktreeRemove
			}
		}
	}
	return ""
}

func ghKind(w []string) string {
	i := 0
	for i < len(w) && strings.HasPrefix(w[i], "-") {
		if w[i] == "-R" || w[i] == "--repo" {
			i += 2
		} else {
			i++
		}
	}
	if i+1 >= len(w) || w[i] != "pr" {
		return ""
	}
	switch w[i+1] {
	case "create":
		return kindPRCreate
	case "merge":
		return kindPRMerge
	}
	return ""
}
