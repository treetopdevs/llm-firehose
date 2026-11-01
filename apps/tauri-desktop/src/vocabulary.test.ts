// @vitest-environment node
// One vocabulary guard. Walks every non-test source file with the TypeScript
// compiler API and inspects only visible-copy positions (el()/svg() children,
// aria-label/title/placeholder/alt/label attributes, textContent, setAttribute of
// those, and object props text/label/title/message/hint). Identifiers, classes,
// ids, roles, data-*, imports, comparisons, case labels and URL paths are not copy.
//
// Audit 5.1 terms -> replacement:
//   needs attention / needs input / needs_input -> needs you
//   attention (noun)                            -> needs you (inbox is "Needs you")
//   fork(s) / forked                            -> branch / branches of work (sidebar: unchanged id, copy changed)
//   workspace(s)                                -> worktree(s)
//   checkout(s)                                 -> worktree(s)
//   repository / repositories / repo id         -> project
//   cell(s)                                     -> unchanged id; copy says session/worktree
// Obsolete uppercase NEEDS YOU / NEEDS INPUT is banned case-sensitively; "Needs you"/"needs you" is required.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const SRC = __dirname;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) && !/\.fixtures\.ts$/.test(n)) out.push(p);
  }
  return out;
}

const COPY_ATTRS = new Set(["aria-label", "title", "placeholder", "alt", "label"]);
// Local helpers whose first argument is visible copy (a label or button text).
const HELPERS = new Set(["button", "field", "add", "select"]);
const COPY_PROPS = new Set(["text", "label", "title", "message", "hint"]);

function propName(n: ts.PropertyName): string {
  return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : "";
}

/** Literal text pieces of an expression (string, template head/spans, concatenations, ternaries). */
function literals(n: ts.Node, out: ts.Node[] = []): ts.Node[] {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n);
  else if (ts.isTemplateExpression(n)) {
    out.push(n.head);
    for (const s of n.templateSpans) {
      literals(s.expression, out);
      out.push(s.literal);
    }
  } else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.PlusToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    literals(n.left, out);
    literals(n.right, out);
  } else if (ts.isConditionalExpression(n)) {
    literals(n.whenTrue, out);
    literals(n.whenFalse, out);
  } else if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) literals(n.expression, out);
  else if (ts.isArrayLiteralExpression(n)) for (const e of n.elements) literals(e, out);
  return out;
}

export interface Copy {
  file: string;
  text: string;
  line: number;
}

export function copyOf(file: string, source: string): Copy[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Copy[] = [];
  const take = (n: ts.Node) => {
    for (const l of literals(n)) {
      const text = (l as ts.LiteralLikeNode).text;
      if (text) found.push({ file, text, line: sf.getLineAndCharacterOfPosition(l.getStart(sf)).line + 1 });
    }
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
      if (callee === "el" || callee === "svg") {
        n.arguments.forEach((a, i) => {
          if (i >= 2) take(a);
          else if (i === 1 && ts.isObjectLiteralExpression(a)) {
            for (const p of a.properties) if (ts.isPropertyAssignment(p) && COPY_ATTRS.has(propName(p.name))) take(p.initializer);
          }
        });
      } else if (callee === "setAttribute" && n.arguments.length >= 2) {
        const k = n.arguments[0];
        if (ts.isStringLiteral(k) && COPY_ATTRS.has(k.text)) take(n.arguments[1]);
      } else if (callee === "setAttr" && n.arguments.length >= 3) {
        const k = n.arguments[1];
        if (ts.isStringLiteral(k) && COPY_ATTRS.has(k.text)) take(n.arguments[2]);
      } else if (ts.isIdentifier(n.expression) && HELPERS.has(callee) && n.arguments.length >= 1) {
        take(n.arguments[0]);
        if (callee === "select" && n.arguments[1]) take(n.arguments[1]);
      } else if (callee === "map" && ts.isPropertyAccessExpression(n.expression) && ts.isArrayLiteralExpression(n.expression.expression) && n.arguments[0] && /\bel\(/.test(n.arguments[0].getText(sf))) {
        take(n.expression.expression); // ["a", "b"].map((h) => el("th", {}, h)): the array is the copy
      } else if (callee === "setText" && n.arguments.length >= 2) take(n.arguments[1]);
    } else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.EqualsToken || n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) && ts.isPropertyAccessExpression(n.left)) {
      if (["textContent", "title", "ariaLabel", "placeholder"].includes(n.left.name.text)) take(n.right);
    } else if (ts.isPropertyAssignment(n) && COPY_PROPS.has(propName(n.name))) take(n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const NON_COPY_PROPS = /^(class|className|id|role|style|type|kind|name|key|data-.*|href|src|for|rel|scope|tabindex|selector|cssText)$/;
const NON_COPY_CALLS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "getAttribute", "addEventListener", "removeEventListener", "fetch", "add", "remove", "toggle", "contains", "setItem", "getItem", "removeItem", "createElement", "createElementNS", "RegExp", "test", "includes", "startsWith", "endsWith", "indexOf", "split", "replace", "replaceAll", "el", "svg", "data", "dispatchEvent", "setProperty", "getPropertyValue", "get", "set", "has", "delete", "on", "off", "emit"]);

/**
 * Second net: a sentence-like literal (it has whitespace, or starts with a capital)
 * in any position that is not plainly an identifier, selector, class or comparison.
 * Catches copy assembled in a variable and assigned later.
 */
export function looseCopyOf(file: string, source: string): Copy[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Copy[] = [];
  const isLit = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
  const visit = (n: ts.Node) => {
    if (isLit(n) && (/\s/.test(n.text) || /^[A-Z]/.test(n.text))) {
      let p: ts.Node = n.parent;
      while (ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isArrayLiteralExpression(p)) p = p.parent;
      let skip = ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isCaseClause(p) || ts.isLiteralTypeNode(p) || ts.isTypeNode(p) || ts.isElementAccessExpression(p) || ts.isTaggedTemplateExpression(p);
      if (ts.isBinaryExpression(p) && ![ts.SyntaxKind.PlusToken, ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) skip = true;
      if (ts.isPropertyAssignment(p) && NON_COPY_PROPS.test(propName(p.name))) skip = true;
      if (ts.isCallExpression(p)) {
        const c = ts.isIdentifier(p.expression) ? p.expression.text : ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : "";
        if (NON_COPY_CALLS.has(c)) skip = true;
      }
      if (!skip && n.text.trim()) found.push({ file, text: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const RETIRED: [string, RegExp][] = [
  ["needs attention", /\bneeds? attention\b/i],
  ["needs input", /\bneeds?[ _]input\b/i],
  ["attention", /\battention\b/i],
  ["fork", /\bfork(s|ed)?\b/i],
  ["workspace", /\bworkspaces?\b/i],
  ["checkout", /\bcheck-?outs?\b/i],
  ["repository", /\brepositor(y|ies)\b/i],
  ["repo id", /\brepo ids?\b/i],
  ["cell", /\bcells?\b/i],
];
const OBSOLETE_CASED = /NEEDS YOU|NEEDS INPUT/;

// Entries are non-copy text only, each with a why. Every entry must still match.
const ALLOW: { file: string; contains: string; why: string }[] = [
  { file: "ui/graph/toolbar.ts", contains: "Repository", why: "Audit 5.1: 'repository' survives only as the project picker's own label (select name and its visible caption)." },
  { file: "ui/project/index.ts", contains: "Repository", why: "Audit 5.1: 'repository' survives only as the project picker's own label (select name)." },
];

const allowed = (c: Copy) => ALLOW.some((a) => c.file.endsWith(a.file) && c.text.includes(a.contains));

const files = walk(SRC).map((f) => ({ file: relative(SRC, f).split(sep).join("/"), source: readFileSync(f, "utf8") }));
const all: Copy[] = files.flatMap((f) => [...copyOf(f.file, f.source), ...looseCopyOf(f.file, f.source)]);

describe("vocabulary guard", () => {
  test("scans a meaningful amount of copy", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(all.length).toBeGreaterThan(200);
  });

  test("no retired word appears in visible copy", () => {
    const hits = all
      .filter((c) => !allowed(c))
      .flatMap((c) => RETIRED.filter(([, re]) => re.test(c.text)).map(([w]) => `${c.file}:${c.line} [${w}] ${JSON.stringify(c.text)}`));
    expect(hits).toEqual([]);
  });

  test("obsolete uppercase NEEDS YOU / NEEDS INPUT is banned, case-sensitively", () => {
    const hits = all.filter((c) => OBSOLETE_CASED.test(c.text)).map((c) => `${c.file}:${c.line} ${JSON.stringify(c.text)}`);
    expect(hits).toEqual([]);
    expect(OBSOLETE_CASED.test("NEEDS YOU")).toBe(true);
    expect(OBSOLETE_CASED.test("NEEDS INPUT")).toBe(true);
    expect(OBSOLETE_CASED.test("Needs you")).toBe(false);
    expect(OBSOLETE_CASED.test("needs you")).toBe(false);
  });

  test("'Needs you' and 'needs you' are required vocabulary", () => {
    const text = all.map((c) => c.text).join("\n");
    expect(text).toMatch(/Needs you/);
    expect(text).toMatch(/needs you/);
  });

  test("the extractor sees copy and ignores non-copy positions", () => {
    const src = `el("div", { class: "attention", "aria-label": "workspace row" }, "forked here"); const x = a === "attention"; import q from "workspace"; fetch("/workspace-graph/x");`;
    const t = copyOf("x.ts", src).map((c) => c.text);
    expect(t).toContain("workspace row");
    expect(t).toContain("forked here");
    expect(t).not.toContain("attention");
    const more = copyOf("y.ts", `["repository", "open"].map((h) => el("th", {}, h)); status.textContent += " by attention projection";`).map((c) => c.text);
    expect(more).toContain("repository");
    expect(more).toContain(" by attention projection");
    expect(t).not.toContain("/workspace-graph/x");
  });

  test("every ALLOW entry has a why and still matches a literal", () => {
    for (const a of ALLOW) {
      expect(a.why.length).toBeGreaterThan(10);
      expect(all.some((c) => c.file.endsWith(a.file) && c.text.includes(a.contains))).toBe(true);
    }
  });

  test("API wire names are untouched", () => {
    const api = readFileSync(join(SRC, "api.ts"), "utf8");
    const gapi = readFileSync(join(SRC, "ui/graph/api.ts"), "utf8");
    expect(gapi).toContain("/workspace-graph");
    expect(api + gapi).toContain("repo_id");
    expect(api + gapi).toContain("cwd");
  });
});
