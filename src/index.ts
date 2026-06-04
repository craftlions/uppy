import { env, waitUntil } from "cloudflare:workers";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { createWebMiddleware } from "@octokit/webhooks";
import { detectDependencies, renderDependencies } from "./deps.ts";

// biome-ignore lint/performance/noBarrelFile: @cloudflare/sandbox
export { Sandbox } from "@cloudflare/sandbox";

const app = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
  webhooks: {
    secret: env.GITHUB_APP_WEBHOOK_SECRET,
  },
  Octokit: Octokit.plugin(restEndpointMethods),
});

app.webhooks.on("push", async ({ octokit, id, name, payload }) => {
  console.log(`Received event ${name} with id ${id}`);
});

app.webhooks.on(
  "pull_request.closed",
  async ({ octokit, id, name, payload }) => {
    console.log(`Received event ${name} with id ${id}`);
  }
);

async function triggerUppyRun({
  organization,
  repository,
}: {
  organization: string;
  repository: string;
}) {
  const { data: installation } =
    await app.octokit.rest.apps.getRepoInstallation({
      owner: organization,
      repo: repository,
    });
  const octokit = await app.getInstallationOctokit(installation.id);
  const issues = await octokit.rest.issues.listForRepo({
    owner: organization,
    repo: repository,
    state: "open",
    creator: "craftlions-uppy[bot]",
  });

  const ecosystems = await detectDependencies(
    octokit,
    organization,
    repository
  );
  const detected = renderDependencies(ecosystems);
  const body = `This issue lists Uppy updates and detected dependencies.\n\nLast updated at ${new Date().toISOString()}${
    detected ? `\n\n${detected}` : ""
  }`;

  if (issues.data.length > 0) {
    await octokit.rest.issues.update({
      owner: organization,
      repo: repository,
      issue_number: issues.data[0].number,
      body,
    });
  } else {
    await octokit.rest.issues.create({
      owner: organization,
      repo: repository,
      title: "Uppy Dashboard",
      body,
    });
  }
}

const middleware = createWebMiddleware(app.webhooks);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/github/webhooks") {
      return middleware(request);
    }
    if (request.method === "POST" && url.pathname === "/runs") {
      const body = await request.json();
      waitUntil(
        triggerUppyRun({
          organization: body.organization,
          repository: body.repository,
        })
      );

      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
