/**
 * Repo inspection for the setup wizard: package manager, framework, existing
 * tracing, and which provider credentials already live in the repo's env files.
 * Pure reads — never mutates anything. Feeds the setup "Detected: …" line and the
 * recommended ingestion path.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Detected JavaScript package manager (by lockfile). */
export type PackageManager = "pnpm" | "yarn" | "npm" | "bun" | "unknown";

/** Which pull-provider credentials are present in the repo's env files. */
export interface ProviderEnv {
  langsmith: boolean;
  langfuse: boolean;
  posthog: boolean;
  anthropic: boolean;
  openai: boolean;
}

/** A recommended ingestion path plus why it was chosen. */
export interface RecommendedPath {
  /** `otlp` = wire the SDK (first-class); the others = connect an existing pull source. */
  path: "otlp" | "langsmith" | "langfuse" | "posthog";
  reason: string;
  /** Pull providers whose credentials were detected (offered as alternatives). */
  alternatives: ("langsmith" | "langfuse" | "posthog")[];
}

/** The full detection report. */
export interface DetectReport {
  cwd: string;
  packageManager: PackageManager;
  language: "node" | "python" | "unknown";
  /** Framework label (e.g. "Next.js") or null. */
  framework: string | null;
  tracing: {
    /** `@glassray/tracing` already installed. */
    glassraySdk: boolean;
    /** Any `@opentelemetry/*` package installed. */
    openTelemetry: boolean;
  };
  providerEnv: ProviderEnv;
  recommended: RecommendedPath;
}

/** Detect the package manager from the lockfile present. */
const detectPackageManager = (cwd: string): PackageManager => {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "bun.lockb")) || existsSync(path.join(cwd, "bun.lock"))) return "bun";
  if (existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  return "unknown";
};

/** Safely read + parse a repo's package.json; null when absent/invalid. */
const readPackageJson = (cwd: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** All dependency names (deps + devDeps + peer) from a package.json. */
const allDeps = (pkg: Record<string, unknown> | null): Set<string> => {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = pkg?.[field];
    if (block && typeof block === "object") {
      for (const name of Object.keys(block as Record<string, unknown>)) names.add(name);
    }
  }
  return names;
};

/** JS framework label from installed deps. */
const detectJsFramework = (deps: Set<string>): string | null => {
  if (deps.has("next")) return "Next.js";
  if (deps.has("nuxt")) return "Nuxt";
  if ([...deps].some((d) => d.startsWith("@remix-run/"))) return "Remix";
  if (deps.has("express")) return "Express";
  if (deps.has("fastify")) return "Fastify";
  if (deps.has("@nestjs/core")) return "NestJS";
  if (deps.has("react")) return "React";
  return null;
};

/** Python framework label from requirements/pyproject text. */
const detectPythonFramework = (cwd: string): string | null => {
  const files = ["requirements.txt", "pyproject.toml", "Pipfile"];
  let blob = "";
  for (const f of files) {
    try {
      blob += readFileSync(path.join(cwd, f), "utf8").toLowerCase();
    } catch {
      // absent — skip
    }
  }
  if (blob.includes("fastapi")) return "FastAPI";
  if (blob.includes("django")) return "Django";
  if (blob.includes("flask")) return "Flask";
  return blob === "" ? null : "Python";
};

/** Collect the set of env var KEYS present across the repo's env files. */
const readEnvKeys = (cwd: string): Set<string> => {
  const keys = new Set<string>();
  for (const file of [".env", ".env.local"]) {
    let text: string;
    try {
      text = readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) keys.add(trimmed.slice(0, eq).replace(/^export\s+/, "").trim());
    }
  }
  return keys;
};

/** Map env keys to which provider credentials are present. */
const detectProviderEnv = (keys: Set<string>): ProviderEnv => ({
  langsmith: keys.has("LANGSMITH_API_KEY") || keys.has("LANGCHAIN_API_KEY"),
  langfuse: keys.has("LANGFUSE_PUBLIC_KEY") || keys.has("LANGFUSE_SECRET_KEY"),
  posthog: [...keys].some((k) => k.startsWith("POSTHOG_")) || keys.has("POSTHOG_API_KEY"),
  anthropic: keys.has("ANTHROPIC_API_KEY"),
  openai: keys.has("OPENAI_API_KEY"),
});

/** Choose the recommended path. The SDK (OTLP) is first-class; pull sources are alternatives. */
const chooseRecommended = (glassraySdk: boolean, env: ProviderEnv): RecommendedPath => {
  const alternatives: ("langsmith" | "langfuse" | "posthog")[] = [];
  if (env.langsmith) alternatives.push("langsmith");
  if (env.langfuse) alternatives.push("langfuse");
  if (env.posthog) alternatives.push("posthog");

  if (glassraySdk) {
    return { path: "otlp", reason: "already tracing with @glassray/tracing — just point it at Glassray", alternatives };
  }
  return { path: "otlp", reason: "add the @glassray/tracing SDK so your agent's runs show up in Glassray", alternatives };
};

/** Inspect a repo directory (defaults to cwd) and return the full detection report. */
export const detect = (cwd: string = process.cwd()): DetectReport => {
  const pkg = readPackageJson(cwd);
  const deps = allDeps(pkg);
  const language = pkg ? "node" : detectPythonFramework(cwd) ? "python" : "unknown";
  const framework = pkg ? detectJsFramework(deps) : detectPythonFramework(cwd);
  const glassraySdk = deps.has("@glassray/tracing");
  const openTelemetry = [...deps].some((d) => d.startsWith("@opentelemetry/"));
  const providerEnv = detectProviderEnv(readEnvKeys(cwd));
  return {
    cwd,
    packageManager: detectPackageManager(cwd),
    language,
    framework,
    tracing: { glassraySdk, openTelemetry },
    providerEnv,
    recommended: chooseRecommended(glassraySdk, providerEnv),
  };
};

/** One-line human summary of the detection (the setup "Detected: …" line). */
export const summarizeDetect = (r: DetectReport): string => {
  const parts: string[] = [];
  if (r.packageManager !== "unknown") parts.push(r.packageManager);
  if (r.framework) parts.push(r.framework);
  parts.push(
    r.tracing.glassraySdk
      ? "already tracing with @glassray/tracing"
      : r.tracing.openTelemetry
        ? "using OpenTelemetry"
        : "not tracing yet",
  );
  const envs: string[] = [];
  if (r.providerEnv.langsmith) envs.push("LangSmith");
  if (r.providerEnv.langfuse) envs.push("Langfuse");
  if (r.providerEnv.posthog) envs.push("PostHog");
  if (envs.length > 0) parts.push(`${envs.join(" + ")} keys in .env`);
  return parts.join(" · ");
};
