/**
 * Interactive prompts — the ONE place the CLI asks the user a question, so the
 * `[Y/n]` / `[y/N]` styling and the empty-answer default are consistent
 * everywhere. Callers gate on `process.stdin.isTTY` before using these (a
 * non-interactive session must never block waiting on stdin).
 */
import readline from "node:readline/promises";

/**
 * Ask a yes/no question on stderr. `defaultYes` (default `true`) sets both the
 * `[Y/n]` vs `[y/N]` hint AND what an empty Enter means. Returns the boolean.
 */
export const confirm = async (question: string, defaultYes = true): Promise<boolean> => {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`  ${question} ${hint} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

/** Ask a free-text question on stderr; loops until the answer is non-empty. */
export const prompt = async (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    let value = "";
    while (value === "") value = (await rl.question(`  ${question} `)).trim();
    return value;
  } finally {
    rl.close();
  }
};
