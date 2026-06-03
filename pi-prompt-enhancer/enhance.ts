import { complete } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveFamily } from "./family.js";
import type { Family, Settings, Template } from "./types.js";

/**
 * Test/extension seam: pass a stub `complete` to test the flow without hitting the network.
 */
export type CompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions
) => Promise<AssistantMessage>;

export interface EnhanceServices {
  completeFn?: CompleteFn;
}

export interface EnhanceResult {
  refined: string;
  family: Family;
  enhancerModel: Model<Api>;
}

/**
 * Build the LLM request, call the enhancer model, and return the rewritten draft.
 * Does NOT touch the editor — the caller decides what to do with the result.
 *
 * Throws on:
 *   - no active model + no fixed enhancer model configured
 *   - fixed enhancer model not found in the registry
 *   - missing API auth for the chosen model
 *   - model returning an empty response
 */
export async function enhanceDraft(
  ctx: ExtensionContext,
  settings: Settings,
  template: Template,
  draft: string,
  signal: AbortSignal | undefined,
  services: EnhanceServices = {}
): Promise<EnhanceResult> {
  const family = resolveFamily(settings, ctx.model);
  const enhancerModel = resolveEnhancerModel(ctx, settings);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(enhancerModel);
  if (!auth.ok) {
    throw new Error(`Cannot use ${enhancerModel.provider}/${enhancerModel.id}: ${auth.error}`);
  }

  const request = buildRequest(template, family, draft, {
    preserveDraftLanguage: settings.preserveDraftLanguage,
  });

  const fn = services.completeFn ?? complete;
  const options: ProviderStreamOptions = {
    ...(typeof auth.apiKey === "string" ? { apiKey: auth.apiKey } : {}),
    ...(auth.headers ? { headers: auth.headers } : {}),
    ...(signal ? { signal } : {}),
    maxTokens: Math.min(enhancerModel.maxTokens, 2048),
  };

  const response = await fn(enhancerModel, request, options);
  const refined = extractText(response).trim();
  if (!refined) {
    throw new Error("Enhancer model returned an empty response.");
  }
  return { refined, family, enhancerModel };
}

export interface BuildRequestOptions {
  /** If true, append a language-preservation directive to system + user messages. */
  preserveDraftLanguage?: boolean;
}

/**
 * Strong, family-agnostic directive that forces the model to reply in the same
 * natural language as the user's draft. Appended verbatim to the system prompt
 * and (in a shorter form) right after the substituted draft in the user message.
 *
 * Note: detection is delegated to the LLM, which handles arbitrary languages
 * (Slovak, German, Japanese, …) far more reliably than any heuristic we could
 * ship here.
 */
const LANGUAGE_DIRECTIVE_SYSTEM = [
  "CRITICAL LANGUAGE RULE:",
  "- Detect the natural language of the user's draft (the text inside <draft>...</draft>).",
  "- Write the rewritten prompt in EXACTLY that same natural language.",
  "- Do NOT translate the draft into English or any other language, even if these instructions are in English.",
  "- Keep technical tokens untouched in their original form: code identifiers, file paths, shell commands, API names, URLs, error messages, stack traces, library names.",
  "- If the draft mixes languages, follow the dominant prose language and leave technical tokens as written.",
].join("\n");

const LANGUAGE_DIRECTIVE_USER =
  "Reminder: reply in the SAME natural language as the draft above. Do not translate it.";

/**
 * Build the chat context. The system prompt is composed of:
 *   - shared instructions (always)
 *   - family-specific guidance block (only for the resolved family)
 *   - language-preservation directive (when enabled)
 *
 * The user message comes from the template's `{{draft}}` substitution, with an
 * optional language reminder appended.
 */
export function buildRequest(
  template: Template,
  family: Family,
  draft: string,
  options: BuildRequestOptions = {}
): Context {
  const preserveLang = options.preserveDraftLanguage !== false;

  const systemParts = [template.systemShared];
  const familyBlock = family === "claude" ? template.systemClaude : template.systemGpt;
  if (familyBlock) systemParts.push(familyBlock);
  if (preserveLang) systemParts.push(LANGUAGE_DIRECTIVE_SYSTEM);

  const systemPrompt = systemParts.join("\n\n");
  let userText = template.userTemplate.replaceAll("{{draft}}", draft).replaceAll("{{family}}", family);
  if (preserveLang) userText = `${userText}\n\n${LANGUAGE_DIRECTIVE_USER}`;

  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text: userText }],
      },
    ],
  };
}

function resolveEnhancerModel(ctx: ExtensionContext, settings: Settings): Model<Api> {
  if (settings.enhancerModel.mode === "fixed") {
    const { provider, id } = settings.enhancerModel.ref;
    const model = ctx.modelRegistry.find(provider, id);
    if (!model) {
      throw new Error(`Configured enhancer model ${provider}/${id} is not registered.`);
    }
    return model;
  }

  if (!ctx.model) {
    throw new Error("No active model. Pick a model in Pi or configure a fixed enhancer model.");
  }
  return ctx.model;
}

function extractText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
