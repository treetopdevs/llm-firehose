// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { diffCommand } from "./model";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const root = mkdtempSync(join(tmpdir(), "fh-diffcmd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" } as NodeJS.ProcessEnv;
const ident = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"];
function git(cwd: string, ...a: string[]) {
  return execFileSync("git", [...ident, ...a], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function script(name: string, marker: string, body = "cat"): string {
  const p = join(root, name);
  writeFileSync(p, `#!/bin/sh\necho ran >> '${marker}'\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe.skipIf(!hasGit || process.platform === "win32")("diffCommand neutralizes repo-configured executables", () => {
  test("no pager, external diff, textconv or submodule textconv runs", () => {
    const markers = { pager: join(root, "m-pager"), ext: join(root, "m-ext"), tc: join(root, "m-tc"), subtc: join(root, "m-subtc") };

    // submodule source repo with a textconv driver
    const sub = join(root, "sub");
    mkdirSync(sub);
    git(sub, "init", "-q", "-b", "main");
    writeFileSync(join(sub, ".gitattributes"), "*.txt diff=evil\n");
    writeFileSync(join(sub, "s.txt"), "one\n");
    git(sub, "add", "-A");
    git(sub, "commit", "-q", "-m", "s1");

    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, ".gitattributes"), "*.txt diff=evil\n");
    writeFileSync(join(repo, "f.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "submodule", "add", "-q", sub, "sm");
    git(repo, "commit", "-q", "-m", "add sm");
    git(repo, "checkout", "-q", "-b", "feat");
    writeFileSync(join(repo, "f.txt"), "b\n");
    writeFileSync(join(sub, "s.txt"), "two\n");
    git(sub, "commit", "-q", "-am", "s2");
    git(join(repo, "sm"), "pull", "-q", "origin", "main");
    git(join(repo, "sm"), "config", "diff.evil.textconv", script("subtc.sh", markers.subtc));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "change");

    // hostile config, set after history exists
    git(repo, "config", "core.pager", script("pager.sh", markers.pager));
    git(repo, "config", "pager.diff", script("pager2.sh", markers.pager));
    git(repo, "config", "diff.external", script("ext.sh", markers.ext));
    git(repo, "config", "diff.evil.textconv", script("tc.sh", markers.tc));
    git(repo, "config", "diff.submodule", "diff");

    const cmd = diffCommand(repo, "main");
    expect(cmd).toBeDefined();
    const r = spawnSync("sh", ["-c", cmd!], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("f.txt");
    expect(r.stdout).toContain("Subproject commit");
    for (const m of Object.values(markers)) expect(existsSync(m)).toBe(false);

    // sanity: the same repo WITHOUT hardening does execute the hostile config
    const naive = spawnSync("sh", ["-c", `git -C '${repo}' --no-pager diff main...HEAD`], { env, encoding: "utf8" });
    expect(naive.status).toBe(0);
    expect(existsSync(markers.tc) || existsSync(markers.ext)).toBe(true);
  }, 60_000); // correctness, not perf: many real git spawns are slow under load
});
