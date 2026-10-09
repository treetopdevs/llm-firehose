#!/usr/bin/env python3
"""Create a disposable local Git graph for manual UI/performance verification.

Run: python3 scripts/workspace-graph-fixture.py --workspaces 50 --revisions 2000
     python3 scripts/workspace-graph-fixture.py --shape mockup --check

Shapes:
  linear (default)  one long trunk with a few merges and --workspaces worktrees
                    anchored along it, built on an empty tree. This is the
                    documented 50 x 2000 performance fixture and is unchanged.
  mockup            25 worktrees on a real branching history (see build_history):
                    real blobs and trees, so diffs have line counts; branches
                    fanning off a 13-commit trunk, two merge commits, a detached
                    checkout, revisions hosting several worktrees and seven
                    dirty worktrees. --revisions is ignored (105 commits).

--check verifies the generated repository against the shape's expectations
(read back from git itself) and exits non-zero with the reasons on stderr.

Prints its temporary root on stdout (diagnostics go to stderr) and writes
fixture.json there. No existing repository or user configuration is changed.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

MOCKUP_WORKSPACES = 25
EPOCH = 1767225600  # 2026-01-01T00:00:00Z; the mockup history is fully deterministic


def make_git(repo, env):
    def git(*command, cwd=None, stdin=None):
        return subprocess.check_output(["git", "-c", "core.hooksPath=" + os.devnull,
                                        "-c", "commit.gpgsign=false", *command],
                                       cwd=cwd or repo, env=env, input=stdin, stderr=subprocess.PIPE).decode().strip()
    return git


def build_linear(args, root, repo, git, env):
    git("init", "-b", "main")
    tree = git("mktree", stdin=b"")
    revisions = []
    for index in range(args.revisions):
        # A trunk, seven tips sharing an early anchor, a stacked branch, and
        # explicit merge parents. Timestamps intentionally disagree with ancestry.
        parents = [] if not revisions else [revisions[-1]]
        if 20 <= index < 27:
            parents = [revisions[10]]
        elif index == 27:
            parents = [revisions[19], revisions[20]]
        elif index == 28:
            parents = [revisions[27], revisions[23]]
        date = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(seconds=(index * 17) % 2000)
        env["GIT_AUTHOR_DATE"] = date.isoformat()
        env["GIT_COMMITTER_DATE"] = date.isoformat()
        parent_args = [arg for parent in parents for arg in ("-p", parent)]
        revisions.append(git("commit-tree", tree, *parent_args, "-m", f"Fixture revision {index:04d}"))
    git("update-ref", "refs/heads/main", revisions[-1])
    git("reset", "--hard", "main")
    workspaces = [str(repo)]
    for index in range(1, args.workspaces):
        path = root / f"wt-{index:02d}"
        anchor = 10 if index <= 7 else (20 + (index - 8) % 9 if index <= 16 else (index * 31) % len(revisions))
        if index == args.workspaces - 1:
            git("worktree", "add", "--detach", str(path), revisions[anchor])
        else:
            git("worktree", "add", "-b", f"fixture/work-{index:02d}", str(path), revisions[anchor])
        if index % 4 == 0:
            (path / "uncommitted.txt").write_text("Uncommitted fixture content\n")
        workspaces.append(str(path))
    return {"repository": str(repo), "workspaces": workspaces, "revisions": len(revisions), "shape": "linear",
            "expected": {"workspaces": args.workspaces, "revisions": len(revisions)}}


# ---------------------------------------------------------------------------
# mockup shape
# ---------------------------------------------------------------------------

FILES = ["session.go", "graph.go", "graph_test.go", "README.md"]
VERBS = ["tighten", "extend", "rework", "document", "trim", "cover", "split", "harden"]


def initial_lines(name):
    if name == "README.md":
        return (["# Agent Firehose graph fixture", "", "A disposable repository for the workspace graph view.", ""]
                + [f"- note {i:02d}: fixture bullet" for i in range(1, 25)])
    package = name[:-3].replace("_test", "")
    lines = [f"package {package}", ""]
    if name.endswith("_test.go"):
        lines += ['import "testing"', ""]
        for i in range(1, 15):
            lines += [f"func TestCase{i:02d}(t *testing.T) {{", f"\tif got := compute{i:02d}(); got != {i} {{",
                      f'\t\tt.Fatalf("case {i:02d}: %d", got)', "\t}", "}", ""]
    else:
        for i in range(1, 15):
            lines += [f"// step{i:02d} advances {package} state {i:02d}.", f"func (s *State) step{i:02d}() error {{",
                      f'\ts.touch("step{i:02d}")', "\treturn nil", "}", ""]
    return lines


def digest(*parts):
    return int(hashlib.sha256(":".join(str(p) for p in parts).encode()).hexdigest(), 16)


def mutate(lines, name, seq):
    """Deterministically edit a file: replace one or two lines, append one to three."""
    comment = "- " if name.endswith(".md") else "// "
    out = list(lines)
    h = digest(name, seq)
    for k in range(1 + h % 2):
        out[(h >> (8 + 12 * k)) % len(out)] = f"{comment}edit r{seq:04d}.{k} in {name}"
    for k in range(1 + (h >> 40) % 3):
        out.append(f"{comment}r{seq:04d}.{k} appended to {name}")
    return out


def text(lines):
    return ("\n".join(lines) + "\n").encode()


class History:
    """Builds a commit DAG as a git fast-import stream (real blobs and trees)."""

    def __init__(self):
        self.commits = {}   # name -> {"mark", "files", "ref", "parents"}; insertion order is topological
        self.stream = bytearray()

    def add(self, name, ref, parents, theme):
        seq = len(self.commits)
        mark = seq + 1
        base = self.commits[parents[0]]["files"] if parents else None
        files = {k: list(v) for k, v in base.items()} if base else {n: initial_lines(n) for n in FILES}
        if not parents:
            changed, message = list(FILES), "core: initial import"
        else:
            h = digest("pick", seq)
            if len(parents) > 1:
                changed = ["README.md"]
                message = f"Merge {parents[1]} into {parents[0]}"
            else:
                changed = [FILES[h % len(FILES)]]
                if (h >> 4) % 3 == 0:
                    changed.append(FILES[(h >> 8) % len(FILES)])
                changed = sorted(set(changed))
                message = f"{theme}: {VERBS[(h >> 12) % len(VERBS)]} {changed[0]}"
            for n in changed:
                files[n] = mutate(files[n], n, seq)
        when = EPOCH + seq * 5400
        ident = f"Graph Fixture <fixture@example.invalid> {when} +0000"
        body = message.encode()
        s = self.stream
        s += f"commit {ref}\nmark :{mark}\nauthor {ident}\ncommitter {ident}\ndata {len(body)}\n".encode() + body + b"\n"
        if parents:
            s += f"from :{self.commits[parents[0]]['mark']}\n".encode()
            for extra in parents[1:]:
                s += f"merge :{self.commits[extra]['mark']}\n".encode()
        for n in changed:
            blob = text(files[n])
            s += f"M 100644 inline {n}\ndata {len(blob)}\n".encode() + blob + b"\n"
        s += b"\n"
        self.commits[name] = {"mark": mark, "files": files, "ref": ref, "parents": parents}

    def lane(self, name, parent, length, theme, merges=None):
        """Commits name.1 .. name.length on refs/fixture/<name>; merges maps a lane
        index to the extra (second) parent, a commit name, of that commit."""
        previous = parent
        for i in range(1, length + 1):
            parents = [previous] + ([merges[i]] if merges and i in merges else [])
            self.add(f"{name}.{i}", f"refs/fixture/{name}", parents, theme)
            previous = f"{name}.{i}"


# (directory, branch or None for detached, commit). The primary checkout is <root>/main.
WORKTREES = [
    ("main", "main", "M12"),
    # anchor A = alpha.1 (child of M9): two worktrees on it, one interior (alpha.2), the lane tip,
    # and three branches forking further along the lane (alpha.4, alpha.6, alpha.7)
    ("wt-05", "agent/refactor-a", "alpha.1"),
    ("wt-06", "agent/refactor-b", "alpha.1"),
    ("wt-04", "agent/spike", "alpha.2"),
    ("wt-07", "agent/cache", "alpha.8"),
    ("wt-07-fix", "agent/cache-fix", "fix.2"),
    ("wt-07-alt", "agent/cache-alt", "alt.1"),
    ("wt-07-tests", "agent/cache-tests", "tests.3"),
    # two worktrees on one trunk revision
    ("wt-10", "feat/shared-a", "M5"),
    ("wt-11", "feat/shared-b", "M5"),
    ("wt-01", "agent/docs-sweep", "b1.8"),
    ("wt-21", "feat/docs-wip", "b1.4"),
    ("wt-02", "agent/rename-pass", "b2.3"),
    ("wt-08", "feat/reports", "b3.14"),
    ("wt-20", "feat/reports-wip", "b3.7"),
    ("wt-09", "feat/export", "b4.2"),
    ("wt-12", "feat/merge-lane", "b5.5"),
    ("wt-17", "feat/hooks", "b6.4"),
    ("wt-18", "feat/sync-main", "b7.11"),
    ("wt-19", "feat/perf", "b8.7"),
    # deep lane with three short forks and a detached checkout at an interior commit
    ("wt-03", "agent/long-haul", "deep.18"),
    ("wt-13", "agent/deep-a", "deepa.2"),
    ("wt-14", "agent/deep-b", "deepb.2"),
    ("wt-15", "agent/deep-c", "deepc.2"),
    ("wt-16", None, "deep.10"),
]

SELECTED_DEMO = {"workspace": "wt-07-fix", "branch": "agent/cache-fix",
                 "changes": [{"path": "session.go", "additions": 42, "deletions": 11},
                             {"path": "graph.go", "additions": 18, "deletions": 6},
                             {"path": "graph_test.go", "additions": 120, "deletions": 4}]}
# modified with counts, staged rename, untracked, staged binary, deleted, modified, staged add
DIRTY = ["wt-07-fix", "wt-02", "wt-03", "wt-14", "wt-12", "wt-17", "wt-18"]


def build_history():
    h = History()
    for i in range(13):                       # trunk M0..M12, main tip at M12
        h.add(f"M{i}", "refs/heads/main", [f"M{i - 1}"] if i else [], "core")
    h.lane("alpha", "M9", 8, "cache")         # alpha.1 is the anchor A
    h.lane("fix", "alpha.4", 2, "cache")      # forks at L3 (A = L0)
    h.lane("alt", "alpha.6", 1, "cache")      # forks at L5
    h.lane("tests", "alpha.7", 3, "cache")    # forks at L6
    h.lane("deep", "M8", 18, "history")       # deepest lane: depth 8 + 18 = 26
    h.lane("deepa", "deep.4", 2, "history")
    h.lane("deepb", "deep.9", 2, "history")
    h.lane("deepc", "deep.14", 2, "history")
    h.lane("b1", "M2", 8, "docs")
    h.lane("b2", "M3", 3, "rename")
    h.lane("b3", "M5", 14, "reports")
    h.lane("b4", "M6", 2, "export")
    h.lane("b5", "M10", 5, "merge", merges={3: "b3.14"})   # merges another branch's lane
    h.lane("b6", "M11", 4, "hooks")
    h.lane("b7", "M4", 11, "sync", merges={5: "M10"})      # merges main into a feature branch
    h.lane("b8", "M7", 7, "perf")
    return h


def edit_counts(path, deletions, additions, tag):
    """Rewrite a file so `git diff --numstat` against its HEAD content is exactly
    +additions -deletions: delete evenly spaced lines, insert unique new ones."""
    lines = path.read_text().split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    step = max(1, len(lines) // (deletions + 1))
    for k in reversed(range(deletions)):
        del lines[step * (k + 1)]
    lines[2:2] = [f"// {tag}: working copy line {i:03d}" for i in range(additions)]
    path.write_text("\n".join(lines) + "\n")


def build_mockup(args, root, repo, git, env):
    history = build_history()
    git("init", "-b", "main")
    marks = root / "marks.tmp"
    git("fast-import", "--quiet", f"--export-marks={marks}", stdin=bytes(history.stream))
    by_mark = {}
    for line in marks.read_text().splitlines():
        mark, value = line.split()
        by_mark[int(mark[1:])] = value
    marks.unlink()
    shas = {name: by_mark[c["mark"]] for name, c in history.commits.items()}
    git("reset", "--hard", "main")

    paths = {}
    for directory, branch, commit in WORKTREES:
        path = repo if directory == "main" else root / directory
        paths[directory] = path
        if directory == "main":
            assert shas[commit] == git("rev-parse", "main"), "main checkout must sit on the trunk tip"
        elif branch is None:
            git("worktree", "add", "--detach", str(path), shas[commit])
        else:
            git("worktree", "add", "-b", branch, str(path), shas[commit])
    for ref in git("for-each-ref", "--format=%(refname)", "refs/fixture").splitlines():
        git("update-ref", "-d", ref)  # scratch refs; every commit stays reachable from a worktree HEAD

    # dirty worktrees: modified (with exact counts), deleted, staged add, staged rename, staged binary, untracked
    for item in SELECTED_DEMO["changes"]:
        edit_counts(paths["wt-07-fix"] / item["path"], item["deletions"], item["additions"], "wt-07-fix")
    git("mv", "graph_test.go", "graph_cache_test.go", cwd=paths["wt-02"])
    (paths["wt-03"] / "scratch.log").write_text("untracked scratch output\n")
    (paths["wt-14"] / "diagram.bin").write_bytes(bytes(range(256)) * 2)
    git("add", "diagram.bin", cwd=paths["wt-14"])
    (paths["wt-12"] / "README.md").unlink()
    edit_counts(paths["wt-17"] / "README.md", 1, 3, "wt-17")
    (paths["wt-18"] / "cache_notes.md").write_text("".join(f"note {i}\n" for i in range(1, 6)))
    git("add", "cache_notes.md", cwd=paths["wt-18"])

    merges = sum(1 for c in history.commits.values() if len(c["parents"]) > 1)
    depth = {}
    for name, c in history.commits.items():
        depth[name] = 1 + max((depth[p] for p in c["parents"]), default=-1)
    return {"repository": str(repo), "workspaces": [str(paths[d]) for d, _, _ in WORKTREES],
            "revisions": len(history.commits), "shape": "mockup",
            "expected": {"workspaces": len(WORKTREES), "revisions": len(history.commits), "merge_commits": merges,
                         "detached": sum(1 for _, b, _ in WORKTREES if b is None), "dirty": len(DIRTY),
                         "max_depth": max(depth.values()), "dirty_workspaces": DIRTY,
                         "names": [d for d, _, _ in WORKTREES]},
            "selected_demo": SELECTED_DEMO}


# ---------------------------------------------------------------------------
# --check
# ---------------------------------------------------------------------------

def worktree_entries(git):
    entries, current = [], None
    for line in git("worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            current = {"path": line[len("worktree "):], "head": "", "branch": None, "detached": False}
            entries.append(current)
        elif current is not None and line.startswith("HEAD "):
            current["head"] = line[len("HEAD "):]
        elif current is not None and line.startswith("branch "):
            current["branch"] = line[len("branch "):]
        elif current is not None and line == "detached":
            current["detached"] = True
    return entries


def graph_facts(git, tips):
    """(commit count, merge count, max depth) over everything reachable from tips."""
    parents = {}
    for line in git("rev-list", "--parents", "--topo-order", *tips).splitlines():
        fields = line.split()
        parents[fields[0]] = fields[1:]
    depth = {}
    for commit in reversed(list(parents)):  # topo order lists children first
        depth[commit] = 1 + max((depth[p] for p in parents[commit] if p in depth), default=-1)
    merges = sum(1 for p in parents.values() if len(p) >= 2)
    return len(parents), merges, max(depth.values())


def run_check(manifest, git):
    problems = []
    expected = manifest["expected"]
    entries = worktree_entries(git)
    if len(entries) != expected["workspaces"]:
        problems.append(f"{len(entries)} worktrees, expected {expected['workspaces']}")
    count, merges, max_depth = graph_facts(git, sorted({e["head"] for e in entries}))
    if manifest["shape"] == "linear":
        if merges < 2:
            problems.append(f"only {merges} merge commits reachable")
        if count < 20:
            problems.append(f"only {count} commits reachable")
        return problems
    if count != expected["revisions"] or count < 100:
        problems.append(f"{count} commits reachable from worktrees, expected {expected['revisions']} (>= 100)")
    if merges != expected["merge_commits"] or merges < 2:
        problems.append(f"{merges} merge commits, expected {expected['merge_commits']} (>= 2)")
    if max_depth != expected["max_depth"] or max_depth < 25:
        problems.append(f"depth {max_depth}, expected {expected['max_depth']} (>= 25)")
    detached = [e for e in entries if e["detached"]]
    if len(detached) != 1:
        problems.append(f"{len(detached)} detached worktrees, expected 1")
    hosts = {}
    for e in entries:
        hosts[e["head"]] = hosts.get(e["head"], 0) + 1
    if max(hosts.values()) < 2:
        problems.append("no revision hosts two worktrees")
    dirty = sorted(os.path.basename(e["path"]) for e in entries if git("status", "--porcelain=v1", cwd=e["path"]))
    if len(dirty) != expected["dirty"] or len(dirty) < 6:
        problems.append(f"{len(dirty)} dirty worktrees {dirty}, expected {expected['dirty']} (>= 6)")
    demo = manifest["selected_demo"]
    entry = next((e for e in entries if os.path.basename(e["path"]) == demo["workspace"]), None)
    if entry is None:
        problems.append(f"{demo['workspace']} missing")
        return problems
    changed = git("status", "--porcelain=v1", cwd=entry["path"]).splitlines()
    names = git("diff", "--name-status", "HEAD", cwd=entry["path"]).splitlines()
    if len(changed) != len(demo["changes"]) or len(names) != len(changed) or any(not n.startswith("M\t") for n in names):
        problems.append(f"{demo['workspace']} should have exactly {len(demo['changes'])} modified files: {changed}")
    stats = {}
    for line in git("diff", "--numstat", "HEAD", cwd=entry["path"]).splitlines():
        added, deleted, path = line.split("\t")
        stats[path] = (int(added), int(deleted))
    for item in demo["changes"]:
        if stats.get(item["path"]) != (item["additions"], item["deletions"]):
            problems.append(f"{demo['workspace']} {item['path']} counts {stats.get(item['path'])}")
    if entry["branch"] != "refs/heads/" + demo["branch"]:
        problems.append(f"{demo['workspace']} is on {entry['branch']}, expected {demo['branch']}")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shape", choices=["linear", "mockup"], default="linear")
    parser.add_argument("--workspaces", type=int, default=25)
    parser.add_argument("--revisions", type=int, default=80)
    parser.add_argument("--check", action="store_true", help="verify the generated repository's shape")
    args = parser.parse_args()
    if args.shape == "mockup":
        if args.workspaces != MOCKUP_WORKSPACES:
            parser.error(f"the mockup shape has exactly {MOCKUP_WORKSPACES} workspaces")
    elif args.workspaces < 12 or args.revisions < 30:
        parser.error("use at least 12 workspaces and 30 revisions")
    root = Path(tempfile.mkdtemp(prefix="firehose-graph-fixture-"))
    repo = root / "main"
    repo.mkdir()
    env = dict(os.environ, GIT_AUTHOR_NAME="Graph Fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
               GIT_COMMITTER_NAME="Graph Fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid",
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    git = make_git(repo, env)
    manifest = (build_mockup if args.shape == "mockup" else build_linear)(args, root, repo, git, env)
    (root / "fixture.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.check:
        problems = run_check(manifest, git)
        if problems:
            for problem in problems:
                print("check failed: " + problem, file=sys.stderr)
            print(f"fixture left at {root}", file=sys.stderr)
            sys.exit(1)
        print(f"check ok: {args.shape} fixture", file=sys.stderr)
    print(root)


if __name__ == "__main__":
    main()
