import type { GraphqlClient } from "../src/datasources/github-tags.ts";
import { describe, expect, it } from "vitest";
import { datasourceCore } from "../src/datasources/mise.ts";
import { datasourceNpm } from "../src/datasources/npm.ts";
import { datasourceFor, MANAGERS, managerByName } from "../src/manager.ts";
import { githubVersioning } from "../src/versioning.ts";

const noopClient: GraphqlClient = {
	graphql: () => Promise.resolve({}),
};

describe("managerByName", () => {
	it("finds a registered manager and its datasource", () => {
		expect(managerByName("github-actions")?.datasource).toBe("github-tags");
		expect(managerByName("npm")?.datasource).toBe("npm");
		expect(managerByName("mise")?.datasource).toBeUndefined();
	});

	it("returns undefined for an unknown manager", () => {
		expect(managerByName("cargo")).toBeUndefined();
	});

	it("registers mise, npm, and github-actions in dashboard order", () => {
		expect(MANAGERS.map((manager) => manager.name)).toEqual([
			"mise",
			"npm",
			"github-actions",
		]);
	});
});

describe("datasourceFor", () => {
	it("returns the shared npm and core singletons", () => {
		expect(datasourceFor("npm", noopClient)).toBe(datasourceNpm);
		expect(datasourceFor("core", noopClient)).toBe(datasourceCore);
	});

	it("builds a github-tags datasource speaking github versioning", () => {
		const datasource = datasourceFor("github-tags", noopClient);
		expect(datasource?.versioning).toBe(githubVersioning);
	});

	it("builds github-releases and aqua datasources", () => {
		expect(datasourceFor("github-releases", noopClient)).not.toBeNull();
		expect(datasourceFor("aqua", noopClient)).not.toBeNull();
	});

	it("returns null for an unknown datasource", () => {
		expect(datasourceFor("docker", noopClient)).toBeNull();
	});
});
