import { describe, expect, it } from "vitest";
import { githubVersioning, semverVersioning } from "../src/versioning.ts";

describe("semverVersioning", () => {
	it("validates and judges stability", () => {
		expect(semverVersioning.isValid("1.2.3")).toBe(true);
		expect(semverVersioning.isValid("v1.2.3")).toBe(true);
		expect(semverVersioning.isValid("workspace:*")).toBe(false);
		expect(semverVersioning.isStable("1.2.3")).toBe(true);
		expect(semverVersioning.isStable("1.2.3-rc.1")).toBe(false);
		expect(semverVersioning.isStable("nope")).toBe(false);
	});

	it("treats any strictly greater version as an upgrade", () => {
		expect(semverVersioning.isUpgrade("1.2.3", "1.2.4")).toBe(true);
		expect(semverVersioning.isUpgrade("1.2.3", "1.2.3")).toBe(false);
		expect(semverVersioning.isUpgrade("1.2.3", "1.2.2")).toBe(false);
		expect(semverVersioning.isUpgrade("1.2.3", "garbage")).toBe(false);
	});

	it("compares, classifies the bump, and matches the base", () => {
		expect(semverVersioning.compare("1.0.0", "2.0.0")).toBeLessThan(0);
		expect(semverVersioning.difference("1.2.3", "2.0.0")).toBe("major");
		expect(semverVersioning.isSameBase("1.2.3", "1.2.3-rc.1")).toBe(true);
		expect(semverVersioning.isSameBase("1.2.3", "1.3.0")).toBe(false);
	});
});

describe("githubVersioning", () => {
	it("tolerates the v prefix and coarse tags", () => {
		expect(githubVersioning.isValid("v4")).toBe(true);
		expect(githubVersioning.isValid("v4.1")).toBe(true);
		expect(githubVersioning.isValid("v4.1.0")).toBe(true);
		expect(githubVersioning.isValid("4.1.0")).toBe(true);
		expect(githubVersioning.isValid("v4.1.0-beta.1")).toBe(true);
		expect(githubVersioning.isValid("main")).toBe(false);
		expect(
			githubVersioning.isValid("3df4ab11eba7bda6032a0b82a6bb43b11571feac"),
		).toBe(false);
	});

	it("reads a coarse tag as a track: only a higher track upgrades it", () => {
		// v4 floats within the v4.x.y line, so only v5 advances it.
		expect(githubVersioning.isUpgrade("v4", "v4.1.0")).toBe(false);
		expect(githubVersioning.isUpgrade("v4", "v4.9.9")).toBe(false);
		expect(githubVersioning.isUpgrade("v4", "v5.0.0")).toBe(true);
	});

	it("reads a major.minor tag as a finer track", () => {
		expect(githubVersioning.isUpgrade("v4.1", "v4.1.9")).toBe(false);
		expect(githubVersioning.isUpgrade("v4.1", "v4.2.0")).toBe(true);
		expect(githubVersioning.isUpgrade("v4.1", "v5.0.0")).toBe(true);
	});

	it("compares a fully-qualified tag as ordinary semver", () => {
		expect(githubVersioning.isUpgrade("v4.1.0", "v4.1.1")).toBe(true);
		expect(githubVersioning.isUpgrade("v4.1.0", "v4.1.0")).toBe(false);
		expect(githubVersioning.isUpgrade("v4.1.0", "v3.9.9")).toBe(false);
	});

	it("classifies the bump across coarse and concrete tags", () => {
		expect(githubVersioning.difference("v4", "v5.0.0")).toBe("major");
		expect(githubVersioning.difference("v4.1.0", "v4.2.0")).toBe("minor");
		expect(githubVersioning.difference("v4.1.0", "v4.1.0")).toBeNull();
	});

	it("judges stability across the v prefix", () => {
		expect(githubVersioning.isStable("v4.1.0")).toBe(true);
		expect(githubVersioning.isStable("v4.1.0-beta.1")).toBe(false);
	});
});
