/**
 * Default templates seeded into ~/.pi/agent/pi-prompt-enhancer/ on first run.
 *
 * Each entry is `filename -> markdown body`. Users own the files afterwards —
 * the extension never overwrites existing ones and only creates the directory
 * when it is missing.
 */

const SHARED_USER = "Rewrite the following user draft. Keep the user's intent and concrete details. Reply with only the rewritten prompt — no preamble, no commentary, no markdown fences.\n\n<draft>\n{{draft}}\n</draft>";

const baseSystem = (role: string): string =>
  [
    `You are an expert prompt rewriter for a coding-agent workflow. You will receive a rough user draft and rewrite it as ${role}.`,
    "Preserve the user's intent, file paths, commands, APIs, concrete numbers, and acceptance criteria.",
    "Do not invent facts, files, or requirements. Do not add filler or generic best-practice lists.",
    "Keep the rewrite concise and faithful in scope.",
    "Output ONLY the rewritten prompt text. Do not wrap it in fences or quotes. Do not add any commentary before or after.",
  ].join("\n");

const gptGuidance = [
  "## system.gpt",
  "",
  "GPT-family guidance (OpenAI prompt best practices):",
  "- Lead with the outcome / desired result, then add success criteria, constraints, and output shape only when they change behavior.",
  "- Prefer compact natural prose and short bullet lists over heavy XML or section stacks.",
  "- Use decision rules instead of long process scripts. Reserve `always`, `never`, `must` for true invariants.",
  "- State stop rules and what to do under uncertainty when relevant.",
].join("\n");

const claudeGuidance = [
  "## system.claude",
  "",
  "Claude-family guidance (Anthropic prompt best practices):",
  "- Use explicit structure when it materially improves clarity. XML-like sections such as <task>, <context>, <constraints>, <verification>, <deliverable> are welcome.",
  "- Put the most important instructions early, then context, then the request.",
  "- Be direct and unambiguous; Claude follows structured instructions reliably and benefits from explicit role framing.",
  "- When useful, ask Claude to think step-by-step before producing the final output.",
].join("\n");

function template(opts: {
  name: string;
  keywords: string[];
  role: string;
  taskGuidance: string[];
}): string {
  const frontmatter = ["---", `name: ${opts.name}`, `keywords: [${opts.keywords.join(", ")}]`, "---"].join("\n");

  const system = [
    "## system",
    "",
    baseSystem(opts.role),
    "",
    "Task-specific guidance:",
    ...opts.taskGuidance.map((line) => `- ${line}`),
  ].join("\n");

  const user = ["## user", "", SHARED_USER].join("\n");

  return [frontmatter, "", system, "", gptGuidance, "", claudeGuidance, "", user, ""].join("\n");
}

export const SEED_TEMPLATES: Record<string, string> = {
  "implement.md": template({
    name: "implement",
    keywords: ["implement", "add", "build", "create", "support", "integrate", "wire up"],
    role: "a concise implementation task",
    taskGuidance: [
      "Make the goal explicit in one sentence.",
      "List concrete scope boundaries when the draft implies them (in-scope vs out-of-scope).",
      "Surface relevant files, components, or APIs the agent should inspect first.",
      "State acceptance criteria and verification steps (tests, lint, manual checks) only if they fit the draft.",
      "Do not invent files, frameworks, or constraints the user did not mention.",
    ],
  }),

  "debug.md": template({
    name: "debug",
    keywords: ["debug", "fix", "bug", "broken", "error", "crash", "fails", "failing", "stuck", "hangs"],
    role: "a debugging task",
    taskGuidance: [
      "Bias the agent toward inspecting before editing.",
      "Ask for reproduction or confirmation of the symptom first.",
      "Push for root-cause analysis before applying a fix.",
      "When relevant, include regression-test coverage and a verification step after the fix.",
      "Preserve any error messages, stack traces, or commands from the draft verbatim.",
    ],
  }),

  "review.md": template({
    name: "review",
    keywords: ["review", "audit", "findings", "code review", "look over"],
    role: "a code-review task",
    taskGuidance: [
      "Make it explicit that the agent inspects current state before suggesting changes.",
      "Ask for findings ordered by severity or impact.",
      "Discourage speculative redesign unless the user asked for it.",
      "Encourage citing file paths and line numbers when reporting issues.",
    ],
  }),

  "refactor.md": template({
    name: "refactor",
    keywords: ["refactor", "cleanup", "clean up", "simplify", "restructure", "reorganize", "dedupe"],
    role: "a refactoring task",
    taskGuidance: [
      "State that behavior must be preserved unless the draft says otherwise.",
      "Discourage API or signature changes unless the user asked for them.",
      "Encourage running the relevant checks (tests, typecheck, lint) after the refactor.",
      "Surface duplication, dead code, or structural smells worth attacking.",
    ],
  }),

  "explain.md": template({
    name: "explain",
    keywords: ["explain", "how", "why", "walk me through", "help me understand", "what does"],
    role: "an explanation request",
    taskGuidance: [
      "Keep it explanatory — do not turn it into an execution contract.",
      "Ask for plain prose grounded in the actual code or context the user mentions.",
      "Encourage code references (file paths, function names) instead of abstract generalities.",
      "Discourage suggesting changes unless the user explicitly asked for them.",
    ],
  }),

  "plan.md": template({
    name: "plan",
    keywords: ["plan", "design", "architecture", "approach", "strategy", "roadmap"],
    role: "a planning task with no implementation",
    taskGuidance: [
      "Forbid writing code — this is design only.",
      "Ask for: goal, 2-3 candidate approaches, trade-offs, recommended path, and milestones.",
      "Encourage explicit assumptions and open questions.",
      "Keep it concrete to the user's stack and codebase — no generic SaaS-architecture filler.",
    ],
  }),

  "research.md": template({
    name: "research",
    keywords: ["research", "investigate", "compare", "evaluate", "spike", "look up", "find out"],
    role: "a focused research task",
    taskGuidance: [
      "Define the question and the decision the research feeds into.",
      "Ask for implementation-relevant facts, not exhaustive surveys.",
      "When web sources are involved, require citing them.",
      "End with a recommended path or shortlist, not raw notes.",
    ],
  }),

  "general.md": template({
    name: "general",
    keywords: [],
    role: "a stronger, clearer version of the original request",
    taskGuidance: [
      "Improve clarity, structure, and specificity without changing the user's intent.",
      "Do not turn an open question into a coding task. Do not turn a coding task into an essay.",
      "Trim filler and duplicated phrasing.",
      "Keep concrete details (file paths, commands, numbers) exactly as the user wrote them.",
    ],
  }),
};
