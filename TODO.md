## Mandatory

- add gitSignOff -> will be default
- :maintainLockFilesWeekly -> will be a default feature but every 3 days
- :semanticCommitsDisabled -> figure out what to do
- :rebaseStalePrs -> default for the start
- :separateMultipleMajorReleases -> decide https://docs.renovatebot.com/configuration-options/#separatemajorminor https://docs.renovatebot.com/configuration-options/#separatemultiplemajor
- helpers:pinGitHubActionDigests -> support github actions https://docs.renovatebot.com/presets-helpers/#helperspingithubactiondigests
- :pinDevDependencies -> support pinning https://docs.renovatebot.com/presets-default/#pindevdependencies
- add dry mode / website mode
- security:minimumReleaseAgeNpm -> force security / paranoid https://docs.renovatebot.com/presets-security/#securityminimumreleaseagenpm
- :dependencyDashboard -> add config for dependencydashboard https://docs.renovatebot.com/presets-default/#dependencydashboard

## Stretch Goals

- :reviewer(alexanderniebuhr)
- AI reviewer & codemod
- :configMigration -> only needed once we ship uppy.jsonc
- :disableRateLimiting -> we might not need to have rate limits at all?
- :replacements:all -> investigate / optional e18e
- abandonments:recommended -> add abandonments https://docs.renovatebot.com/presets-abandonments/#abandonmentsrecommended

## Others to check

":semanticPrefixFixDepsChoreOthers", 
":ignoreModulesAndTests", 
"group:monorepos", 
"group:recommended", 
"mergeConfidence:age-confidence-badges", 
"workarounds:all", 
"helpers:forgejoDigestChangelogs", 
"helpers:giteaDigestChangelogs", 
"helpers:githubDigestChangelogs", 
"helpers:gitlabDigestChangelogs", 
"helpers:goXPackagesChangelogLink", 
"helpers:goXPackagesNameLink", 
"helpers:renovateChangelog"
"docker:pinDigests", 

## Code backup


// const sandbox = getSandbox(env.Sandbox, sessionId);
// const sandbox = getSandbox(env.Sandbox, `build-${repoName}-${commit}`);
// try {
//   const sandbox = getSandbox(env.Sandbox, sessionId);
//   await sandbox.exec("npm run build");
// } finally {
//   await sandbox.destroy(); // Clean up temporary sandboxes
// }

import { getSandbox } from '@cloudflare/sandbox';
import { getVersionsBatch } from 'fast-npm-meta'

export { Sandbox } from '@cloudflare/sandbox';

function newestByDate(time: Record<string, string> | undefined) {
  if (!time) return { version: null, publishedAt: null }

  return Object.entries(time)
    .filter(([version]) => version !== "created" && version !== "modified")
    .sort(([, a], [, b]) => new Date(b).getTime() - new Date(a).getTime())
    .map(([version, publishedAt]) => ({ version, publishedAt }))
    .at(0) ?? { version: null, publishedAt: null }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/check") {
      let sandbox;
      const sessionId = `session-${Date.now()}-${Math.random()}`;
      try {
        sandbox = getSandbox(env.Sandbox, sessionId, {
          enableDefaultSession: false,
          normalizeId: true,
          sleepAfter: "5m",
          containerTimeouts: {
            portReadyTimeoutMS: 180_000,
            instanceGetTimeoutMS: 60_000
          }
        })

        const c = await sandbox.gitCheckout('https://github.com/craftlions/website', {
          branch: 'main',
          depth: 1
        });

        const packageJson = await sandbox.exec('mise --no-config --no-env --no-hooks exec aube@1.16.1 -- aube list --json', {
          cwd: c.targetDir
        });

        const deps = JSON.parse(packageJson.stdout);
        const packageVersionsInfo = await getVersionsBatch(Object.keys(deps), {
          throw: false,
          metadata: true
        });

        if (!("error" in packageVersionsInfo)) {
          return Response.json(packageVersionsInfo);
        }

        
      } finally {
        await sandbox?.destroy().catch(() => { });
      }
    }

    return Response.json(
      { message: "Use POST /check" },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;