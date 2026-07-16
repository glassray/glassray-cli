import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkProjectRoot, resolveProjectDir } from "./project-root.js";

describe("checkProjectRoot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "glr-root-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a directory holding a project manifest", () => {
    writeFileSync(path.join(dir, "package.json"), "{}");
    const r = checkProjectRoot(dir);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("package.json");
  });

  it("accepts a subdirectory inside a git working tree (no manifest of its own)", () => {
    mkdirSync(path.join(dir, ".git"));
    const sub = path.join(dir, "src");
    mkdirSync(sub);
    expect(checkProjectRoot(sub)).toEqual({ ok: true, reason: "git repository" });
  });

  it("rejects a bare directory with no manifest and no git", () => {
    expect(checkProjectRoot(dir).ok).toBe(false);
  });

  it("never treats the home directory as a project root", () => {
    // The exact 'ran from home' mistake — false regardless of what home contains.
    expect(checkProjectRoot(os.homedir()).ok).toBe(false);
  });
});

describe("resolveProjectDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "glr-resolve-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves an existing directory and carries its root check", () => {
    writeFileSync(path.join(dir, "package.json"), "{}");
    const res = resolveProjectDir(dir, os.tmpdir());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.dir).toBe(dir);
      expect(res.root.ok).toBe(true);
    }
  });

  it("errors on a non-existent path", () => {
    expect(resolveProjectDir(path.join(dir, "nope"))).toEqual({
      ok: false,
      error: expect.stringContaining("no such directory"),
    });
  });

  it("errors when the path is a file, not a directory", () => {
    const file = path.join(dir, "package.json");
    writeFileSync(file, "{}");
    expect(resolveProjectDir(file)).toEqual({
      ok: false,
      error: expect.stringContaining("not a directory"),
    });
  });

  it("rejects an empty answer", () => {
    expect(resolveProjectDir("   ")).toEqual({ ok: false, error: "enter a path" });
  });
});
