export type Family = "gpt" | "claude";
export type FamilyMode = "auto" | Family;

export interface ModelRef {
  provider: string;
  id: string;
}

/**
 * A prompt-engineering technique loaded from a `.md` file.
 *
 * Parsed structure of a template file:
 *   ---
 *   name: implement
 *   keywords: [implement, add, build, create]
 *   ---
 *
 *   ## system            (shared system instructions; required)
 *   ...
 *
 *   ## system.gpt        (extra system instructions for GPT family; optional)
 *   ...
 *
 *   ## system.claude     (extra system instructions for Claude family; optional)
 *   ...
 *
 *   ## user              (user message body; required; supports {{draft}} placeholder)
 *   {{draft}}
 */
export interface Template {
  /** Slug derived from filename (e.g. "implement"). */
  id: string;
  /** Display name from frontmatter, defaults to id. */
  name: string;
  /** Lowercase keywords used for auto-picking. */
  keywords: string[];
  /** Shared system instructions. */
  systemShared: string;
  /** GPT-only system instructions (appended after shared when family=gpt). */
  systemGpt: string;
  /** Claude-only system instructions (appended after shared when family=claude). */
  systemClaude: string;
  /** User-message body. Supports `{{draft}}` and `{{family}}` placeholders. */
  userTemplate: string;
  /** Absolute path on disk (for /pe edit-ish features later). */
  filePath: string;
}

export interface Settings {
  version: 1;
  /** Manual override of the rewrite family. "auto" = derive from active model. */
  familyMode: FamilyMode;
  /** Used when familyMode=auto and the active model cannot be classified. */
  fallbackFamily: Family;
  /** "active" = use the session's current model. Otherwise call this specific model. */
  enhancerModel: { mode: "active" } | { mode: "fixed"; ref: ModelRef };
  /** Fallback technique id used when no keyword matches and the user does not pick one. */
  defaultTechnique: string;
  /** Show a notification with the chosen technique after each enhancement. */
  notify: boolean;
  /**
   * If true (default), inject a directive that forces the rewritten prompt to be in
   * the same natural language as the user's draft, regardless of the language used
   * in the prompt-engineering templates themselves (which are typically English).
   */
  preserveDraftLanguage: boolean;
}
