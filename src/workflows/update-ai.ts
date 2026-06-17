import type { SafeUpgrade } from "../deps.ts";

/**
 * The default Cloudflare-hosted text model uppy summarises updates with. A small,
 * free-allocation-friendly instruct model (see the issue: Workers AI bills in
 * Neurons against a daily free budget). The model is configurable via the
 * `UPDATE_AI_MODEL` Worker var so it can be swapped without a code change.
 */
export const DEFAULT_UPDATE_AI_MODEL = "@cf/meta/llama-3.2-1b-instruct";

/**
 * Input bounds. Workers AI bills in Neurons against a daily free allocation, so
 * the diff and changelog fed to the model are hard-capped: a single large PR diff
 * or release-note blob must never blow through the budget or the model's request
 * limit. The model is also asked for a bounded reply via {@link MAX_OUTPUT_TOKENS}.
 */
export const MAX_DIFF_CHARS = 6000;
export const MAX_CHANGELOG_CHARS = 2000;
export const MAX_OUTPUT_TOKENS = 400;

/** Output bounds, applied after parsing so a chatty model can't bloat the PR body. */
export const MAX_SUMMARY_CHARS = 500;
export const MAX_LIST_ITEMS = 5;
export const MAX_LIST_ITEM_CHARS = 280;

/** The marker appended to a field clipped to its budget cap. */
export const TRUNCATION_MARKER = "\n… [truncated]";

/**
 * The structured result the PR-body renderer consumes. Keeping the AI step's
 * output structured (rather than a Markdown blob) keeps rendering deterministic:
 * the renderer never re-runs prompt construction. When analysis could not be
 * produced, {@link unavailableReason} carries a short, user-facing note and the
 * three content fields are empty.
 */
export type UpdateAiAnalysis = {
	/** A 1-3 sentence, non-alarmist update hint for the user. */
	summary: string;
	/** Notable risks or behavior changes worth knowing about. */
	risks: string[];
	/** Specific files, commands, workflows, or behavior worth testing. */
	testHints: string[];
	/** Present when analysis was skipped or failed; the section renders this note. */
	unavailableReason?: string;
};

export interface UpdateAiInput {
	upgrades: SafeUpgrade[];
	/** The generated compare diff for the PR branch. */
	diff: string;
	/** Optional changelog / release-note text for the dependency update. */
	changelog?: string;
}

export interface AnalyzeUpdateOptions {
	/** Overrides {@link DEFAULT_UPDATE_AI_MODEL}; sourced from `env.UPDATE_AI_MODEL`. */
	model?: string;
}

/** Clip `text` to `max` characters, appending {@link TRUNCATION_MARKER} when cut. */
function clip(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return trimmed.slice(0, max) + TRUNCATION_MARKER;
}

/** A one-line summary of the upgrades, the stable header of every prompt. */
function describeUpgrades(upgrades: SafeUpgrade[]): string {
	return upgrades
		.map(
			(upgrade) =>
				`${upgrade.package} ${upgrade.current} → ${upgrade.target} (${upgrade.updateType})`,
		)
		.join("\n");
}

/**
 * Build the bounded user prompt. The diff and changelog are clipped to their caps
 * so the request stays inside the free Neuron allocation. The model is asked for
 * compact, uncertain-by-default JSON: for a dependency update, false confidence is
 * worse than a short "unsure" note.
 */
export function buildUpdatePrompt(input: UpdateAiInput): string {
	const sections = [
		"You are reviewing an automated dependency update pull request.",
		"Summarise the practical impact for a developer. Be concise and non-alarmist.",
		"Do not claim certainty; if the diff is inconclusive, say so briefly.",
		"",
		"Respond with ONLY a JSON object of this exact shape, no prose, no code fences:",
		'{"summary": string, "risks": string[], "testHints": string[]}',
		"- summary: 1-3 sentences of practical update guidance.",
		"- risks: notable risks or behavior changes (empty array if none are evident).",
		"- testHints: specific files, commands, workflows, or behavior to test.",
		"",
		"## Update",
		describeUpgrades(input.upgrades),
	];
	const changelog = input.changelog?.trim();
	if (changelog) {
		sections.push(
			"",
			"## Changelog / release notes",
			clip(changelog, MAX_CHANGELOG_CHARS),
		);
	}
	const diff = input.diff.trim();
	if (diff) {
		sections.push("", "## Generated diff", clip(diff, MAX_DIFF_CHARS));
	}
	return sections.join("\n");
}

function toBoundedList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.slice(0, MAX_LIST_ITEMS)
		.map((item) =>
			item.length > MAX_LIST_ITEM_CHARS
				? `${item.slice(0, MAX_LIST_ITEM_CHARS)}…`
				: item,
		);
}

/**
 * Extract the first balanced JSON object from a model reply. Small instruct models
 * routinely wrap JSON in prose or code fences, so we slice from the first `{` to
 * the matching `}` rather than trusting the whole reply to be valid JSON.
 */
function extractJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start === -1) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return text.slice(start, index + 1);
			}
		}
	}
	return undefined;
}

/**
 * Parse a model reply into a bounded {@link UpdateAiAnalysis}, or undefined when
 * the reply has no usable JSON or no summary. All fields are clamped here so a
 * chatty or malformed reply cannot bloat the PR body.
 */
export function parseAnalysis(text: string): UpdateAiAnalysis | undefined {
	const json = extractJsonObject(text);
	if (!json) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const obj = parsed as Record<string, unknown>;
	const rawSummary = typeof obj.summary === "string" ? obj.summary.trim() : "";
	if (rawSummary.length === 0) {
		return undefined;
	}
	const summary =
		rawSummary.length > MAX_SUMMARY_CHARS
			? `${rawSummary.slice(0, MAX_SUMMARY_CHARS)}…`
			: rawSummary;
	return {
		summary,
		risks: toBoundedList(obj.risks),
		testHints: toBoundedList(obj.testHints),
	};
}

/** A fallback result carrying a short, user-facing reason and no content. */
function unavailable(reason: string): UpdateAiAnalysis {
	return { summary: "", risks: [], testHints: [], unavailableReason: reason };
}

/** The narrow slice of the Workers AI binding {@link analyzeUpdate} needs. */
type TextOutput = { response?: unknown };

/**
 * Summarise an update's risks with Cloudflare Workers AI, degrading gracefully on
 * every failure mode. This NEVER throws and NEVER retries: a failed, rate-limited,
 * over-budget, or malformed response returns a fallback {@link UpdateAiAnalysis}
 * with an {@link UpdateAiAnalysis.unavailableReason} so the caller can still
 * create/update the PR. Exactly one model call is made, and its input is bounded
 * by {@link buildUpdatePrompt} to protect the free Neuron allocation.
 */
export async function analyzeUpdate(
	ai: Ai | undefined,
	input: UpdateAiInput,
	options?: AnalyzeUpdateOptions,
): Promise<UpdateAiAnalysis> {
	if (!ai) {
		return unavailable("AI analysis is not configured for this Worker.");
	}
	const hasInput =
		input.diff.trim().length > 0 || (input.changelog?.trim().length ?? 0) > 0;
	if (!hasInput) {
		return unavailable("No diff or changelog was available to analyze.");
	}
	const model = options?.model?.trim() || DEFAULT_UPDATE_AI_MODEL;
	const prompt = buildUpdatePrompt(input);
	let output: TextOutput;
	try {
		output = (await ai.run(model, {
			messages: [
				{
					role: "system",
					content:
						"You are a terse, careful release-notes assistant. Reply with JSON only.",
				},
				{ role: "user", content: prompt },
			],
			max_tokens: MAX_OUTPUT_TOKENS,
			temperature: 0.2,
		})) as TextOutput;
	} catch {
		// Rate limit, over-allocation, timeout, transport error — all collapse to a
		// single fallback. We deliberately do not retry: retries can burn the daily
		// Neuron budget fast.
		return unavailable("AI analysis was unavailable for this update.");
	}
	const responseText =
		typeof output?.response === "string" ? output.response : "";
	const analysis = parseAnalysis(responseText);
	if (!analysis) {
		return unavailable("AI analysis returned no usable result.");
	}
	return analysis;
}
