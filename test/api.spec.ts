import { describe, expect, it, vi } from "vitest";
import { configResponse } from "../src/api.ts";
import type { ContentReader } from "../src/deps.ts";

/** Build a mocked Octokit whose getContent serves base64 file fixtures. */
function mockReader(files: Record<string, string>): ContentReader {
  const getContent = vi.fn(({ path }: { path: string }) => {
    const content = files[path];
    if (content === undefined) {
      return Promise.reject(new Error("Not Found"));
    }
    return Promise.resolve({
      data: { type: "file", content: btoa(content) },
    });
  });
  return { rest: { repos: { getContent } } };
}

describe("configResponse", () => {
  it("returns 200 with the located path and parsed config", async () => {
    const octokit = mockReader({
      "renovate.json5": "{ extends: ['config:recommended'] }",
    });
    const response = await configResponse(octokit, "acme", "repo");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "renovate.json5",
      config: { extends: ["config:recommended"] },
    });
  });

  it("returns 404 when the repository has no Renovate config", async () => {
    const octokit = mockReader({});
    const response = await configResponse(octokit, "acme", "repo");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "No Renovate config found for acme/repo",
    });
  });

  it("returns 422 when a config exists but cannot be parsed", async () => {
    const octokit = mockReader({ "renovate.json": "{ broken" });
    const response = await configResponse(octokit, "acme", "repo");
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("renovate.json");
  });
});
