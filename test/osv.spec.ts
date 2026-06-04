import { describe, expect, it, vi } from "vitest";
import {
	fetchOsvVulnerabilityAlerts,
	logOsvVulnerabilityAlerts,
	renderOsvVulnerabilityAlerts,
} from "../src/osv.ts";

describe("fetchOsvVulnerabilityAlerts", () => {
	it("queries OSV batch for npm packages and returns vulnerable dependencies", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				results: [
					{
						vulns: [{ id: "GHSA-1234", modified: "2026-01-01T00:00:00Z" }],
					},
					{},
				],
			}),
		);

		const alerts = await fetchOsvVulnerabilityAlerts(
			[
				{ name: "left-pad", version: "1.3.0" },
				{ name: "vitest", version: "4.1.7" },
			],
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledWith(
			"https://api.osv.dev/v1/querybatch",
			expect.objectContaining({
				body: JSON.stringify({
					queries: [
						{
							package: { ecosystem: "npm", name: "left-pad" },
							version: "1.3.0",
						},
						{
							package: { ecosystem: "npm", name: "vitest" },
							version: "4.1.7",
						},
					],
				}),
				method: "POST",
			}),
		);
		expect(alerts).toEqual([
			{
				dependency: { name: "left-pad", version: "1.3.0" },
				vulnerabilities: [
					{ id: "GHSA-1234", modified: "2026-01-01T00:00:00Z" },
				],
			},
		]);
	});

	it("throws when OSV returns an error response", async () => {
		const fetcher = vi.fn(async () => new Response("nope", { status: 503 }));

		await expect(
			fetchOsvVulnerabilityAlerts(
				[{ name: "left-pad", version: "1.3.0" }],
				fetcher,
			),
		).rejects.toThrow("OSV query failed with status 503");
	});
});

describe("logOsvVulnerabilityAlerts", () => {
	it("logs every vulnerable package", () => {
		const logger = { log: vi.fn() };

		logOsvVulnerabilityAlerts(
			[
				{
					dependency: { name: "left-pad", version: "1.3.0" },
					vulnerabilities: [{ id: "GHSA-1234" }, { id: "OSV-2026-1" }],
				},
			],
			logger,
		);

		expect(logger.log).toHaveBeenCalledWith(
			"OSV vulnerability found for left-pad@1.3.0: GHSA-1234, OSV-2026-1",
		);
	});
});

describe("renderOsvVulnerabilityAlerts", () => {
	it("renders a GitHub warning block with OSV alerts", () => {
		const markdown = renderOsvVulnerabilityAlerts([
			{
				dependency: { name: "left-pad", version: "1.3.0" },
				vulnerabilities: [{ id: "GHSA-1234" }, { id: "OSV-2026-1" }],
			},
		]);

		expect(markdown).toMatchInlineSnapshot(`
      "> [!WARNING]
      > OSV reported vulnerabilities for detected npm dependencies.
      >
      > | Package | Version | Vulnerabilities |
      > | --- | --- | --- |
      > | \`left-pad\` | \`1.3.0\` | \`GHSA-1234\`, \`OSV-2026-1\` |"
    `);
	});

	it("returns an empty string when there are no OSV alerts", () => {
		expect(renderOsvVulnerabilityAlerts([])).toBe("");
	});
});
