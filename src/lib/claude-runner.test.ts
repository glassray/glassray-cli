import { describe, expect, it } from "vitest";
import { createClaudeReducer } from "./claude-runner.js";

/** Build a stream-json `assistant` line carrying one `tool_use` block. */
const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });

/** Build a stream-json `user` line carrying one `tool_result` block. */
const toolResult = (id: string, isError = false): string =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } });

describe("createClaudeReducer", () => {
  it("summarizes only tools that succeeded, deduped and repo-relative", () => {
    const r = createClaudeReducer("/repo");
    const labels: (string | null)[] = [];
    const feed = [
      toolUse("t1", "Bash", { command: "pnpm add @glassray/tracing" }),
      toolResult("t1"),
      toolUse("t2", "Bash", { command: "npm view foo" }), // denied below → not recorded
      toolResult("t2", true),
      toolUse("t3", "Write", { file_path: "/repo/src/index.ts" }),
      toolResult("t3"),
      toolUse("t4", "Edit", { file_path: "/repo/src/index.ts" }), // same file → deduped
      toolResult("t4"),
      toolUse("t5", "Write", { file_path: "/repo/.env.local" }), // fails below → not recorded
      toolResult("t5", true),
      JSON.stringify({ type: "result", subtype: "success", result: "Done." }),
    ];
    for (const line of feed) labels.push(r.push(line));

    const summary = r.summary();
    expect(summary.installs).toEqual(["@glassray/tracing"]);
    expect(summary.edits).toEqual(["src/index.ts"]); // deduped, failed .env.local excluded
    expect(summary.finalText).toBe("Done.");
  });

  it("emits a human live label when a tool starts", () => {
    const r = createClaudeReducer("/repo");
    expect(r.push(toolUse("a", "Bash", { command: "pnpm add @glassray/tracing" }))).toBe(
      "installing @glassray/tracing",
    );
    expect(r.push(toolUse("b", "Write", { file_path: "/repo/src/app.ts" }))).toBe("editing src/app.ts");
    expect(r.push(toolResult("a"))).toBeNull(); // results carry no label
  });

  it("parses a piped/redirected install without dragging in shell operators", () => {
    const r = createClaudeReducer("/repo");
    expect(r.push(toolUse("p", "Bash", { command: "pnpm add @glassray/tracing 2>&1 | tail -20" }))).toBe(
      "installing @glassray/tracing",
    );
    r.push(toolResult("p"));
    expect(r.summary().installs).toEqual(["@glassray/tracing"]);
  });

  it("ignores non-JSON and blank lines", () => {
    const r = createClaudeReducer("/repo");
    expect(r.push("")).toBeNull();
    expect(r.push("not json at all")).toBeNull();
    expect(r.summary().edits).toEqual([]);
  });
});
