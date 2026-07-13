import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spinner } from "./ui.js";

/*
 * Guards the spinner against the "infinite scroll" regression: a status line
 * wider than the terminal must NOT wrap — once it wraps, `\r` can't return to the
 * logical line start and the spinner scrolls the whole terminal (the exact bug a
 * live `glassray setup` hit). Each redraw must stay on one row, start at column 0,
 * and never emit a newline while animating.
 */
describe("spinner in-place rendering", () => {
  const COLS = 40;
  let writes: string[];
  let restore: () => void;

  beforeEach(() => {
    writes = [];
    const s = process.stderr;
    const origIsTTY = Object.getOwnPropertyDescriptor(s, "isTTY");
    const origColumns = Object.getOwnPropertyDescriptor(s, "columns");
    const origWrite = s.write.bind(s);
    Object.defineProperty(s, "isTTY", { value: true, configurable: true });
    Object.defineProperty(s, "columns", { value: COLS, configurable: true });
    s.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof s.write;
    restore = () => {
      s.write = origWrite;
      if (origIsTTY) Object.defineProperty(s, "isTTY", origIsTTY);
      if (origColumns) Object.defineProperty(s, "columns", origColumns);
    };
  });
  afterEach(() => restore());

  /** Visible text of a spinner write: drop the CR, the clear-line / SGR escapes, and OSC-8 links. */
  const visible = (w: string): string =>
    w
      .replace(/\r/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

  const LONG =
    "Finishing in the browser…  GitHub ·  Slack ·  Sources skipped, plus a lot more text";

  it("never emits a newline while animating (a newline is what scrolls the terminal)", () => {
    const spin = spinner("starting");
    spin.update(LONG);
    spin.stop();
    expect(writes.join("")).not.toContain("\n");
  });

  it("caps every rendered frame to one terminal row", () => {
    const spin = spinner("starting");
    spin.update(LONG);
    spin.stop();
    for (const w of writes) {
      expect(visible(w).length).toBeLessThan(COLS);
    }
  });

  it("returns the cursor to column 0 on every redraw", () => {
    const spin = spinner("starting");
    spin.update(LONG);
    spin.stop();
    for (const w of writes) {
      if (w.length > 0) expect(w.startsWith("\r")).toBe(true);
    }
  });
});
