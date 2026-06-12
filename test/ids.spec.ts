import { describe, expect, it } from "vitest";
import { workflowInstanceId } from "../src/ids.ts";

// Cloudflare validates instance IDs against this pattern (max 100 chars) and
// rejects anything else with `instance.invalid_id`.
const VALID_INSTANCE_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

describe("workflowInstanceId", () => {
	it("sanitizes a scoped npm package name into a valid id", () => {
		const id = workflowInstanceId("org-repo-abc123", "npm", "@types/node");
		expect(id).toMatch(VALID_INSTANCE_ID);
		expect(id).not.toContain("@");
		expect(id).not.toContain("/");
	});

	it("sanitizes a Renovate group name with spaces", () => {
		const id = workflowInstanceId(
			"org-repo-abc123",
			"npm",
			"all non-major dependencies",
		);
		expect(id).toMatch(VALID_INSTANCE_ID);
		expect(id).not.toContain(" ");
	});

	it("sanitizes a repository name containing a dot", () => {
		const id = workflowInstanceId("my-org", "uppy.js");
		expect(id).toMatch(VALID_INSTANCE_ID);
		expect(id).not.toContain(".");
	});

	it("never exceeds Cloudflare's 100-character limit", () => {
		const id = workflowInstanceId(
			"x".repeat(200),
			"npm",
			"@scope/a-very-long-package-name-that-keeps-going-and-going",
		);
		expect(id.length).toBeLessThanOrEqual(100);
		expect(id).toMatch(VALID_INSTANCE_ID);
	});

	it("appends a unique suffix so repeated parts do not collide", () => {
		const first = workflowInstanceId("org-repo", "npm", "astro");
		const second = workflowInstanceId("org-repo", "npm", "astro");
		expect(first).not.toBe(second);
		expect(first).toMatch(VALID_INSTANCE_ID);
		expect(second).toMatch(VALID_INSTANCE_ID);
	});

	it("falls back to a valid id when every part is unsafe", () => {
		const id = workflowInstanceId("@@@", "///");
		expect(id).toMatch(VALID_INSTANCE_ID);
	});
});
