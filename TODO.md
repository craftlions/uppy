## Mandatory

- WORKFLOWS + SANDBOX (microvm & kata) E2B / NORTHFLANK / https://sprites.dev/#billing / https://www.daytona.io/docs/ https://vercel.com/docs/sandbox https://blaxel.ai/ https://e2b.dev/ E2B / DAYTONAY
- add gitSignOff -> will be default
- :maintainLockFilesWeekly -> will be a default feature but every 3 days
- :semanticCommitsDisabled -> figure out what to do
- :rebaseStalePrs -> default for the start
- :separateMultipleMajorReleases -> decide https://docs.renovatebot.com/configuration-options/#separatemajorminor https://docs.renovatebot.com/configuration-options/#separatemultiplemajor
- helpers:pinGitHubActionDigests -> support github actions https://docs.renovatebot.com/presets-helpers/#helperspingithubactiondigests
- add dry mode / website mode

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
