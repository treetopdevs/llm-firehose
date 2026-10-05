#!/usr/bin/env python3
"""Create a disposable local Git graph for manual UI/performance verification.

Run: python3 scripts/workspace-graph-fixture.py --workspaces 50 --revisions 2000
Prints its temporary root. No existing repository or user configuration is changed.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspaces", type=int, default=25)
    parser.add_argument("--revisions", type=int, default=80)
    args = parser.parse_args()
    if args.workspaces < 12 or args.revisions < 30:
        parser.error("use at least 12 workspaces and 30 revisions")
    root = Path(tempfile.mkdtemp(prefix="firehose-graph-fixture-"))
    repo = root / "main"
    repo.mkdir()
    env = dict(os.environ, GIT_AUTHOR_NAME="Graph Fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
               GIT_COMMITTER_NAME="Graph Fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid",
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)

    def git(*command, cwd=repo, stdin=None):
        return subprocess.check_output(["git", "-c", "core.hooksPath=" + os.devnull,
                                        "-c", "commit.gpgsign=false", *command],
                                       cwd=cwd, env=env, input=stdin, stderr=subprocess.PIPE).decode().strip()

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
    (root / "fixture.json").write_text(json.dumps({"repository": str(repo), "workspaces": workspaces,
                                                 "revisions": len(revisions)}, indent=2) + "\n")
    print(root)


if __name__ == "__main__":
    main()
