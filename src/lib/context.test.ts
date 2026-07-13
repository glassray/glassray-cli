import { describe, expect, it } from "vitest";
import { boolFlag, parseCommand, resolveTimeoutSec, strFlag } from "./context.js";
import { CliError } from "./errors.js";

describe("parseCommand", () => {
  it("merges the global flags and reads command flags + positionals", () => {
    const { values, positionals } = parseCommand(["--json", "otlp", "--name", "svc"], {
      name: { type: "string" },
    });
    expect(values.json).toBe(true);
    expect(strFlag(values, "name")).toBe("svc");
    expect(positionals).toEqual(["otlp"]);
  });

  it("throws a CliError on an unknown flag (not a raw parseArgs error)", () => {
    expect(() => parseCommand(["--definitely-not-a-flag"], {})).toThrow(CliError);
  });

  it("boolFlag is true only when the flag is explicitly set", () => {
    const { values } = parseCommand(["--run"], { run: { type: "boolean" } });
    expect(boolFlag(values, "run")).toBe(true);
    expect(boolFlag(values, "missing")).toBe(false);
  });
});

describe("resolveTimeoutSec", () => {
  it("uses the default when --timeout is absent", () => {
    expect(resolveTimeoutSec(parseCommand([], {}).values, 300)).toBe(300);
  });

  it("reads a valid --timeout", () => {
    const opts = { timeout: { type: "string" } } as const;
    expect(resolveTimeoutSec(parseCommand(["--timeout", "60"], opts).values, 300)).toBe(60);
  });

  it("throws on a non-numeric --timeout instead of a silent NaN deadline", () => {
    const opts = { timeout: { type: "string" } } as const;
    expect(() => resolveTimeoutSec(parseCommand(["--timeout", "3m"], opts).values, 300)).toThrow(
      CliError,
    );
  });
});
