export interface Dependency {
  name: string;
  version: string;
}

export interface DependencyFile {
  dependencies: Dependency[];
  file: string;
}

export interface DependencyEcosystem {
  ecosystem: string;
  files: DependencyFile[];
}

/**
 * Minimal Octokit shape required to read file contents. Keeping it narrow makes
 * the function trivial to mock in unit tests while staying compatible with a
 * real Octokit instance.
 */
export interface ContentReader {
  rest: {
    repos: {
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
      }) => Promise<{ data: unknown }>;
    };
  };
}

const LEADING_QUOTE = /^['"]/;
const TRAILING_QUOTE = /['"]$/;
const INLINE_VERSION = /version\s*=\s*["']([^"']+)["']/;
const NPM_RANGE_PREFIX = /^[\^~>=<\s]+/;
const WHITESPACE = /\s/g;

const unquote = (value: string): string =>
  value.replace(LEADING_QUOTE, "").replace(TRAILING_QUOTE, "");

const extractMiseVersion = (rawValue: string): string => {
  // Inline table form, e.g. { version = "1.17.1", os = ["linux"] }
  if (rawValue.startsWith("{")) {
    const match = rawValue.match(INLINE_VERSION);
    return match ? match[1] : "";
  }
  return unquote(rawValue);
};

/** Take the bare tool name from a mise key like `github:endevco/aube`. */
const normalizeMiseName = (key: string): string => {
  const afterSlash = key.split("/").at(-1) ?? key;
  return afterSlash.split(":").at(-1) ?? afterSlash;
};

/** Strip semver range operators from an npm version spec, e.g. `^1.2.3`. */
const cleanNpmVersion = (version: string): string =>
  version.replace(NPM_RANGE_PREFIX, "").trim();

/** Parse the `[tools]` table of a mise.toml file into dependencies. */
export function parseMiseToml(content: string): Dependency[] {
  const deps: Dependency[] = [];
  let inTools = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      inTools = line === "[tools]";
      continue;
    }
    if (!inTools) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const name = normalizeMiseName(unquote(line.slice(0, eq).trim()));
    const version = extractMiseVersion(line.slice(eq + 1).trim());
    deps.push({ name, version });
  }

  return deps;
}

/** Parse `dependencies` and `devDependencies` of a package.json file. */
export function parsePackageJson(content: string): Dependency[] {
  const pkg = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.entries(all).map(([name, version]) => ({
    name,
    version: cleanNpmVersion(version),
  }));
}

/** Read a file from a repository and decode it, or null if it is missing. */
async function fetchFileContent(
  octokit: ContentReader,
  owner: string,
  repo: string,
  path: string
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if (
      data &&
      !Array.isArray(data) &&
      typeof data === "object" &&
      "type" in data &&
      data.type === "file" &&
      "content" in data &&
      typeof data.content === "string"
    ) {
      return atob(data.content.replace(WHITESPACE, ""));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the supported manifest files from a repository and parse the installed
 * dependencies and versions grouped by ecosystem.
 */
export async function detectDependencies(
  octokit: ContentReader,
  owner: string,
  repo: string
): Promise<DependencyEcosystem[]> {
  const ecosystems: DependencyEcosystem[] = [];

  const miseContent = await fetchFileContent(octokit, owner, repo, "mise.toml");
  if (miseContent) {
    const dependencies = parseMiseToml(miseContent);
    if (dependencies.length > 0) {
      ecosystems.push({
        ecosystem: "mise",
        files: [{ file: "mise.toml", dependencies }],
      });
    }
  }

  const pkgContent = await fetchFileContent(
    octokit,
    owner,
    repo,
    "package.json"
  );
  if (pkgContent) {
    const dependencies = parsePackageJson(pkgContent);
    if (dependencies.length > 0) {
      ecosystems.push({
        ecosystem: "npm",
        files: [{ file: "package.json", dependencies }],
      });
    }
  }

  return ecosystems;
}

const countDependencies = (eco: DependencyEcosystem): number =>
  eco.files.reduce((sum, file) => sum + file.dependencies.length, 0);

/** Render detected dependencies as a Markdown table per ecosystem. */
export function renderDependencies(ecosystems: DependencyEcosystem[]): string {
  if (ecosystems.length === 0) {
    return "";
  }

  const sections = ecosystems.map((eco) => {
    const rows = eco.files
      .flatMap((file) =>
        file.dependencies.map(
          (dep) => `| \`${dep.name}\` | \`${dep.version}\` | \`${file.file}\` |`
        )
      )
      .join("\n");
    return `### ${eco.ecosystem} (${countDependencies(eco)})\n\n| Package | Version | Manifest |\n| --- | --- | --- |\n${rows}`;
  });

  return `## Detected Dependencies\n\n${sections.join("\n\n")}`;
}
