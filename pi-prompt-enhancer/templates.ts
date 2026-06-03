import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { SEED_TEMPLATES } from "./seed.js";
import type { Template } from "./types.js";

export const TEMPLATES_DIR = join(homedir(), ".pi", "agent", "pi-prompt-enhancer");

export interface LoadResult {
  templates: Template[];
  errors: string[];
}

/** Ensure ~/.pi/agent/pi-prompt-enhancer/ exists and seed default `.md` files if missing. */
export function ensureSeedTemplates(dir: string = TEMPLATES_DIR): void {
  mkdirSync(dir, { recursive: true });
  for (const [filename, body] of Object.entries(SEED_TEMPLATES)) {
    const target = join(dir, filename);
    if (!existsSync(target)) {
      writeFileSync(target, body, "utf8");
    }
  }
}

/** Discover and parse every `.md` template in the directory. Bad files are returned as errors but do not throw. */
export function loadTemplates(dir: string = TEMPLATES_DIR): LoadResult {
  if (!existsSync(dir)) {
    return { templates: [], errors: [] };
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const templates: Template[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    try {
      const raw = readFileSync(filePath, "utf8");
      templates.push(parseTemplate(raw, filePath));
    } catch (err) {
      errors.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  templates.sort((a, b) => a.id.localeCompare(b.id));
  return { templates, errors };
}

export function parseTemplate(raw: string, filePath: string): Template {
  const id = basename(filePath, ".md");
  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(frontmatter);
  const sections = parseSections(body);

  const systemShared = (sections["system"] ?? "").trim();
  const systemGpt = (sections["system.gpt"] ?? "").trim();
  const systemClaude = (sections["system.claude"] ?? "").trim();
  const userTemplate = (sections["user"] ?? "").trim();

  if (!systemShared) {
    throw new Error("missing required `## system` section");
  }
  if (!userTemplate) {
    throw new Error("missing required `## user` section");
  }
  if (!userTemplate.includes("{{draft}}")) {
    throw new Error("`## user` section must reference {{draft}}");
  }

  return {
    id,
    name: typeof meta.name === "string" && meta.name ? meta.name : id,
    keywords: normalizeKeywords(meta.keywords),
    systemShared,
    systemGpt,
    systemClaude,
    userTemplate,
    filePath,
  };
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: "", body: raw };
  }
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

/**
 * Minimal frontmatter parser — supports `key: value` and `key: [a, b, c]`.
 * We intentionally avoid pulling in a yaml dependency to stay zero-dep.
 */
function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value: string = trimmed.slice(colon + 1).trim();
    if (!key) continue;

    if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => stripQuotes(part.trim()))
        .filter(Boolean);
      continue;
    }

    out[key] = stripQuotes(value);
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Splits the body into named sections keyed by `## name`. Section names are
 * lowercased so users can use `## System` or `## system` interchangeably.
 */
function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let currentKey: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentKey !== null) {
      sections[currentKey] = buffer.join("\n");
    }
    buffer = [];
  };

  for (const line of lines) {
    const header = line.match(/^##\s+(.+?)\s*$/);
    if (header) {
      flush();
      currentKey = (header[1] ?? "").toLowerCase();
      continue;
    }
    if (currentKey !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}
