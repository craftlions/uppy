import type { SafeUpgrade } from "../../src/deps.ts";
import { describe, expect, it, vi } from "vitest";
import {
	analyzeUpdate,
	buildUpdatePrompt,
	DEFAULT_UPDATE_AI_MODEL,
	MAX_DIFF_CHARS,
	MAX_LIST_ITEM_CHARS,
	MAX_LIST_ITEMS,
	MAX_OUTPUT_TOKENS,
	MAX_SUMMARY_CHARS,
	parseAnalysis,
	TRUNCATION_MARKER,
	type UpdateAiInput,
} from "../../src/workflows/update-ai.ts";

const upgrade: SafeUpgrade = {
	manager: "mise",
	manifest: "mise.toml",
	package: "npm:@openai/codex",
	current: "0.63.0",
	target: "0.64.0",
	updateType: "minor",
};

const input: UpdateAiInput = {
	upgrades: [upgrade],
	diff: "diff --git a/mise.toml b/mise.toml\n@@ -1 +1 @@\n+updated",
};

/** A fake Workers AI binding whose single `run` returns/throws what a test wants. */
function makeAi(
	impl: (model: string, inputs: Record<string, unknown>) => unknown,
) {
	const run = vi.fn(async (model: string, inputs: Record<string, unknown>) =>
		impl(model, inputs),
	);
	return { ai: { run } as unknown as Ai, run };
}

const okResponse = (analysis: {
	summary: string;
	risks: string[];
	testHints: string[];
}) => ({ response: JSON.stringify(analysis) });

describe("parseAnalysis", () => {
	it("parses a clean JSON object", () => {
		const parsed = parseAnalysis(
			'{"summary":"Patch bump.","risks":["none"],"testHints":["run tests"]}',
		);
		expect(parsed).toEqual({
			summary: "Patch bump.",
			risks: ["none"],
			testHints: ["run tests"],
		});
	});

	it("extracts JSON wrapped in prose and code fences", () => {
		const parsed = parseAnalysis(
			'Sure! Here is the result:\n```json\n{"summary":"ok","risks":[],"testHints":[]}\n```\nHope that helps.',
		);
		expect(parsed?.summary).toBe("ok");
	});

	it("returns undefined for a reply with no JSON object", () => {
		expect(parseAnalysis("I cannot help with that.")).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseAnalysis('{"summary": "broken", risks: }')).toBeUndefined();
	});

	it("returns undefined when the summary is missing or empty", () => {
		expect(parseAnalysis('{"risks":["x"],"testHints":[]}')).toBeUndefined();
		expect(parseAnalysis('{"summary":"   ","risks":[]}')).toBeUndefined();
	});

	it("clamps oversized output to its budget caps", () => {
		const parsed = parseAnalysis(
			JSON.stringify({
				summary: "s".repeat(MAX_SUMMARY_CHARS + 50),
				risks: Array.from(
					{ length: MAX_LIST_ITEMS + 4 },
					(_, i) => `risk ${i}`,
				),
				testHints: ["t".repeat(MAX_LIST_ITEM_CHARS + 20)],
			}),
		);
		expect(parsed?.summary.length).toBe(MAX_SUMMARY_CHARS + 1); // +1 for the ellipsis
		expect(parsed?.risks).toHaveLength(MAX_LIST_ITEMS);
		expect(parsed?.testHints[0]?.length).toBe(MAX_LIST_ITEM_CHARS + 1);
	});

	it("drops non-string list items", () => {
		const parsed = parseAnalysis(
			'{"summary":"ok","risks":["keep",1,null,"alsokeep"],"testHints":"not-an-array"}',
		);
		expect(parsed?.risks).toEqual(["keep", "alsokeep"]);
		expect(parsed?.testHints).toEqual([]);
	});
});

describe("buildUpdatePrompt", () => {
	it("clips an oversized diff and marks the truncation", () => {
		const prompt = buildUpdatePrompt({
			upgrades: [upgrade],
			diff: "x".repeat(MAX_DIFF_CHARS * 2),
		});
		expect(prompt).toContain(TRUNCATION_MARKER);
		// The prompt header is small; the bounded diff dominates its length.
		expect(prompt.length).toBeLessThan(MAX_DIFF_CHARS + 2000);
	});

	it("includes changelog text when provided", () => {
		const prompt = buildUpdatePrompt({
			upgrades: [upgrade],
			diff: "small",
			changelog: "Fixed a crash on startup.",
		});
		expect(prompt).toContain("Changelog / release notes");
		expect(prompt).toContain("Fixed a crash on startup.");
	});
});

describe("analyzeUpdate", () => {
	it("returns the structured analysis on a successful model call", async () => {
		const { ai, run } = makeAi(() =>
			okResponse({
				summary: "Minor bump, low risk.",
				risks: ["Behaviour of the CLI flag changed."],
				testHints: ["Run the codex smoke test."],
			}),
		);

		const result = await analyzeUpdate(ai, input);

		expect(result).toEqual({
			summary: "Minor bump, low risk.",
			risks: ["Behaviour of the CLI flag changed."],
			testHints: ["Run the codex smoke test."],
		});
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("falls back without calling AI when the binding is missing", async () => {
		const result = await analyzeUpdate(undefined, input);
		expect(result.summary).toBe("");
		expect(result.unavailableReason).toBeTruthy();
	});

	it("falls back without calling AI when there is no diff or changelog", async () => {
		const { ai, run } = makeAi(() =>
			okResponse({
				summary: "should not run",
				risks: [],
				testHints: [],
			}),
		);

		const result = await analyzeUpdate(ai, {
			upgrades: [upgrade],
			diff: "   ",
		});

		expect(run).not.toHaveBeenCalled();
		expect(result.unavailableReason).toContain("No diff or changelog");
	});

	it("falls back (and never retries) when the model call throws", async () => {
		const { ai, run } = makeAi(() => {
			throw new Error("429 rate limited");
		});

		const result = await analyzeUpdate(ai, input);

		expect(run).toHaveBeenCalledTimes(1);
		expect(result.summary).toBe("");
		expect(result.unavailableReason).toBeTruthy();
	});

	it("falls back when the model returns malformed output", async () => {
		const { ai } = makeAi(() => ({ response: "not json at all" }));
		const result = await analyzeUpdate(ai, input);
		expect(result.unavailableReason).toBeTruthy();
	});

	it("falls back when the model omits a response field", async () => {
		const { ai } = makeAi(() => ({}));
		const result = await analyzeUpdate(ai, input);
		expect(result.unavailableReason).toBeTruthy();
	});

	it("bounds the prompt and caps the output tokens to protect the budget", async () => {
		const { ai, run } = makeAi(() =>
			okResponse({ summary: "ok", risks: [], testHints: [] }),
		);

		await analyzeUpdate(ai, {
			upgrades: [upgrade],
			diff: "x".repeat(MAX_DIFF_CHARS * 5),
		});

		const [, inputs] = run.mock.calls[0] ?? [];
		const messages = (inputs as { messages: { content: string }[] }).messages;
		const userContent = messages.at(-1)?.content ?? "";
		expect(userContent).toContain(TRUNCATION_MARKER);
		expect(userContent.length).toBeLessThan(MAX_DIFF_CHARS + 2000);
		expect((inputs as { max_tokens: number }).max_tokens).toBe(
			MAX_OUTPUT_TOKENS,
		);
	});

	it("uses the default model, and the configured model when supplied", async () => {
		const { ai, run } = makeAi(() =>
			okResponse({ summary: "ok", risks: [], testHints: [] }),
		);

		await analyzeUpdate(ai, input);
		expect(run.mock.calls[0]?.[0]).toBe(DEFAULT_UPDATE_AI_MODEL);

		await analyzeUpdate(ai, input, { model: "@cf/meta/llama-3.1-8b-instruct" });
		expect(run.mock.calls[1]?.[0]).toBe("@cf/meta/llama-3.1-8b-instruct");
	});

	it("falls back to the default model when the configured model is blank", async () => {
		const { ai, run } = makeAi(() =>
			okResponse({ summary: "ok", risks: [], testHints: [] }),
		);
		await analyzeUpdate(ai, input, { model: "   " });
		expect(run.mock.calls[0]?.[0]).toBe(DEFAULT_UPDATE_AI_MODEL);
	});
});
