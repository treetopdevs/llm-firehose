// Package shellverbs recognises lifecycle verbs (git worktree add|remove, git
// commit, git push, gh pr create|merge) in shell commands and in the summary
// phrases the claude-code adapter derives from them. It is a stdlib-only leaf.
package shellverbs

import (
	"encoding/json"
	"path"
	"slices"
	"strings"
)

// Lifecycle mark kinds parsed out of Bash commands.
const (
	KindWorktreeAdd    = "worktree_add"
	KindWorktreeRemove = "worktree_remove"
	KindCommit         = "commit"
	KindPush           = "push"
	KindPRCreate       = "pr_create"
	KindPRMerge        = "pr_merge"
)

// Summary grammar of the claude-code adapter's Bash summary suffix:
// SummaryPrefixRan followed by the Phrases of the kinds joined by SummarySep.
const (
	SummaryPrefixRan = "ran shell tool: "
	SummarySep       = ", "
	maxPhrases       = 6
)

var kindPhrases = []struct{ kind, phrase string }{
	{KindWorktreeAdd, "git worktree add"},
	{KindWorktreeRemove, "git worktree remove"},
	{KindCommit, "git commit"},
	{KindPush, "git push"},
	{KindPRCreate, "gh pr create"},
	{KindPRMerge, "gh pr merge"},
}

// Phrases renders kinds as fixed command phrases joined by SummarySep. Unknown
// kinds are skipped, duplicates removed, and at most six are emitted.
func Phrases(kinds []string) string {
	var out []string
	seen := map[string]bool{}
	for _, k := range kinds {
		for _, kp := range kindPhrases {
			if kp.kind == k && !seen[k] {
				seen[k] = true
				out = append(out, kp.phrase)
			}
		}
		if len(out) == maxPhrases {
			break
		}
	}
	return strings.Join(out, SummarySep)
}

// KindsFromSummary reads the kinds back out of a Bash summary of the form
// SummaryPrefixRan + Phrases. Anything else, including any unknown phrase, is
// rejected whole: nil. At most six phrases are read.
func KindsFromSummary(summary string) []string {
	rest, ok := strings.CutPrefix(summary, SummaryPrefixRan)
	if !ok || rest == "" {
		return nil
	}
	parts := strings.Split(rest, SummarySep)
	if len(parts) > maxPhrases {
		parts = parts[:maxPhrases]
	}
	var kinds []string
	seen := map[string]bool{}
	for _, p := range parts {
		kind := ""
		for _, kp := range kindPhrases {
			if kp.phrase == p {
				kind = kp.kind
			}
		}
		if kind == "" {
			return nil
		}
		if !seen[kind] {
			seen[kind] = true
			kinds = append(kinds, kind)
		}
	}
	return kinds
}

// Kinds returns the distinct lifecycle kinds a claude-code Bash hook
// payload runs, in command order. See Lifecycle.
func Kinds(raw string) []string {
	kinds, _ := Lifecycle(raw)
	return kinds
}

// Lifecycle returns the distinct lifecycle kinds a claude-code Bash hook
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
func Lifecycle(raw string) (kinds []string, selfMerge bool) {
	// Prefilter on the raw text, tolerant of JSON escapes: a command encoded as
	// g\u0069t only shows its verbs once decoded, so any backslash passes.
	if !strings.Contains(raw, "git") && !strings.Contains(raw, "gh") && !strings.Contains(raw, `\`) {
		return nil, false
	}
	tool, command, ok := hookToolCommand(raw)
	if !ok || (tool != "Bash" && tool != "Shell") {
		return nil, false
	}
	return CommandKinds(command)
}

// CommandKinds is Lifecycle for an already decoded shell command string.
func CommandKinds(command string) (kinds []string, selfMerge bool) {
	if !strings.Contains(command, "git") && !strings.Contains(command, "gh") {
		return nil, false
	}
	segs, ok := shellSegments(command)
	if !ok {
		return nil, false // an unterminated substitution: nothing is established
	}
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
		if k == KindPRMerge && i == len(segs)-1 && !seg.background && isSelfMerge(seg.words) {
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
	depth       int  // nesting of if/while/until/for/select ... fi/done
	// condPhase: at depth 1 of an if/while/until, before its then/do, where the
	// first condition list necessarily runs.
	condPhase bool
}

// flowSkip are words that may precede a compound-command keyword on the same
// segment (`then if x`).
var flowSkip = map[string]bool{"then": true, "do": true, "else": true, "elif": true, "{": true, "!": true}

// flowKeyword returns the first non-skipped word of a segment and its index.
func flowKeyword(w []string) string {
	for _, x := range w {
		if !flowSkip[x] {
			return x
		}
	}
	return ""
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
	kw := flowKeyword(w)
	if f.depth > 0 {
		if f.condPhase && f.depth == 1 {
			switch {
			case head == "then" || head == "do" || head == "else" || head == "elif":
				f.condPhase = false
			case slices.Contains([]string{"if", "while", "until", "for", "select", "fi", "done"}, kw):
				f.condPhase = false
			default:
				return true // a command of the initial condition list
			}
		}
		switch kw {
		case "if", "while", "until", "for", "select":
			f.depth++
		case "fi", "done":
			f.depth--
			if f.depth == 0 {
				f.condPhase = false
			}
		}
		return false // a body or later condition of an open construct
	}
	switch kw {
	case "if", "while", "until", "for", "select":
		if !flowSkip[head] {
			f.depth++ // the first condition runs; everything after is a body
			f.condPhase = kw != "for" && kw != "select"
			return true
		}
		f.depth++
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
func shellSegments(cmd string) ([]shellSegment, bool) {
	var (
		bad     bool // an unterminated $( ) or backtick inside double quotes
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
				if (cmd[i] == '$' && i+1 < n && cmd[i+1] == '(') || cmd[i] == '`' {
					start := i + 1
					if cmd[i] == '$' {
						start = i + 2
					}
					var j int
					if cmd[i] == '$' {
						j = skipSubst(cmd, start)
					} else {
						j = skipBacktick(cmd, start)
					}
					if j < 0 {
						bad, i = true, n
						break
					}
					cur.WriteString(cmd[i:j]) // opaque word text
					i = j
					continue
				}
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
		case c == '<' && strings.HasPrefix(cmd[i:], "<<<"):
			cur.WriteString("<<<") // a here-string, never a here-document
			inWord = true
			i += 3
		case c == '<' && strings.HasPrefix(cmd[i:], "<<"):
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
	return segs, !bad
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
		if k, rest := gitKind(w[i+1:]); k != "" && !noOpInvocation(k, rest) {
			return k
		}
	case "gh":
		if k, rest := ghKind(w[i+1:]); k != "" && !noOpInvocation(k, rest) {
			return k
		}
	}
	return ""
}

// optArity lists, for one command, the options that take a separate value
// argument. Short options may be bundled (`-am msg`); a bundle ends in a value
// option when its value is the next argument.
type optArity struct {
	short string          // single-letter options taking a separate value
	long  map[string]bool // --long options taking a separate value
}

func longSet(names ...string) map[string]bool {
	m := map[string]bool{}
	for _, n := range names {
		m[n] = true
	}
	return m
}

// arities are per command: -r is a reviewer value for gh pr create but a bare
// rebase switch for gh pr merge, so one shared table would misread help and
// dry-run flags as values.
var arities = map[string]optArity{
	KindCommit: {"mFCct", longSet("--message", "--file", "--reuse-message", "--reedit-message",
		"--author", "--date", "--template", "--cleanup", "--fixup", "--squash", "--trailer",
		"--pathspec-from-file")},
	KindPush:           {"o", longSet("--push-option", "--repo", "--receive-pack", "--exec")},
	KindWorktreeAdd:    {"bB", longSet("--reason")},
	KindWorktreeRemove: {"", nil},
	KindPRCreate: {"tbFBHalrpmTR", longSet("--title", "--body", "--body-file", "--base", "--head",
		"--assignee", "--label", "--reviewer", "--project", "--milestone", "--template", "--repo", "--recover")},
	KindPRMerge: {"tbFAR", longSet("--subject", "--body", "--body-file", "--author-email",
		"--match-head-commit", "--repo")},
}

// noOpInvocation reports flags that make the command change nothing:
// --dry-run (and -n for push), --help and -h. args are the arguments after the
// subcommand. A value option consumes the next argument (`-m --dry-run` is a
// message); arguments after a bare `--` are operands, not flags.
func noOpInvocation(kind string, args []string) bool {
	ar := arities[kind]
	skip := false
	for _, a := range args {
		if skip {
			skip = false
			continue
		}
		switch {
		case a == "--":
			return false
		case a == "--dry-run" || a == "--help" || a == "-h":
			return true
		case strings.HasPrefix(a, "--"):
			skip = ar.long[a]
		case len(a) > 1 && a[0] == '-':
			for k := 1; k < len(a); k++ {
				if kind == KindPush && a[k] == 'n' {
					return true
				}
				if strings.IndexByte(ar.short, a[k]) >= 0 {
					skip = k == len(a)-1 // otherwise the value is attached
					break
				}
			}
		}
	}
	return false
}

// gitKind returns the lifecycle kind of git arguments and the arguments after
// the subcommand.
func gitKind(w []string) (string, []string) {
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
		return "", nil
	}
	switch w[i] {
	case "commit":
		return KindCommit, w[i+1:]
	case "push":
		return KindPush, w[i+1:]
	case "worktree":
		if i+1 < len(w) {
			switch w[i+1] {
			case "add":
				return KindWorktreeAdd, w[i+2:]
			case "remove":
				return KindWorktreeRemove, w[i+2:]
			}
		}
	}
	return "", nil
}

func ghKind(w []string) (string, []string) {
	i := 0
	for i < len(w) && strings.HasPrefix(w[i], "-") {
		if w[i] == "-R" || w[i] == "--repo" {
			i += 2
		} else {
			i++
		}
	}
	if i+1 >= len(w) || w[i] != "pr" {
		return "", nil
	}
	switch w[i+1] {
	case "create":
		return KindPRCreate, w[i+2:]
	case "merge":
		return KindPRMerge, w[i+2:]
	}
	return "", nil
}

// skipSubst returns the index just past the `)` closing a `$(` whose body
// starts at i, or -1 when unterminated. Quotes, nested substitutions,
// backticks, comments and here-document bodies inside are opaque.
func skipSubst(cmd string, i int) int {
	depth := 1
	var pending []heredoc
	n := len(cmd)
	for i < n {
		c := cmd[i]
		switch {
		case c == '\\':
			i += 2
		case c == '\'':
			j := strings.IndexByte(cmd[i+1:], '\'')
			if j < 0 {
				return -1
			}
			i += j + 2
		case c == '"':
			if i = skipDQuote(cmd, i+1); i < 0 {
				return -1
			}
		case c == '`':
			if i = skipBacktick(cmd, i+1); i < 0 {
				return -1
			}
		case c == '(':
			depth++
			i++
		case c == ')':
			depth--
			i++
			if depth == 0 {
				return i
			}
		case c == '<' && strings.HasPrefix(cmd[i:], "<<<"):
			i += 3 // a here-string, never a here-document
		case c == '<' && strings.HasPrefix(cmd[i:], "<<"):
			var h heredoc
			h, i = parseHeredocStart(cmd, i)
			pending = append(pending, h)
		case c == '\n':
			i++
			for _, h := range pending {
				i = skipHeredoc(cmd, i, h)
			}
			pending = pending[:0]
		case c == '#' && (i == 0 || strings.IndexByte(" \t\n;&|(", cmd[i-1]) >= 0):
			for i < n && cmd[i] != '\n' {
				i++
			}
		default:
			i++
		}
	}
	return -1
}

// skipDQuote returns the index just past the `"` closing a double-quoted
// string whose body starts at i, or -1.
func skipDQuote(cmd string, i int) int {
	n := len(cmd)
	for i < n {
		switch {
		case cmd[i] == '\\':
			i += 2
		case cmd[i] == '"':
			return i + 1
		case cmd[i] == '$' && i+1 < n && cmd[i+1] == '(':
			if i = skipSubst(cmd, i+2); i < 0 {
				return -1
			}
		case cmd[i] == '`':
			if i = skipBacktick(cmd, i+1); i < 0 {
				return -1
			}
		default:
			i++
		}
	}
	return -1
}

// skipBacktick returns the index just past the closing backtick of a command
// substitution whose body starts at i, or -1.
func skipBacktick(cmd string, i int) int {
	n := len(cmd)
	for i < n {
		switch cmd[i] {
		case '\\':
			i += 2
		case '`':
			return i + 1
		case '\'':
			j := strings.IndexByte(cmd[i+1:], '\'')
			if j < 0 {
				return -1
			}
			i += j + 2
		case '"':
			if i = skipDQuote(cmd, i+1); i < 0 {
				return -1
			}
		default:
			i++
		}
	}
	return -1
}
