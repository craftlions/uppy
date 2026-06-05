import type { Dependency } from "./deps.ts";

const OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch";

interface OsvVulnerability {
	id: string;
	modified?: string;
}

interface OsvQueryResult {
	vulns?: OsvVulnerability[];
}

interface OsvQueryBatchResponse {
	results?: OsvQueryResult[];
}

export interface OsvVulnerabilityAlert {
	dependency: Dependency;
	vulnerabilities: OsvVulnerability[];
}

type Fetcher = typeof fetch;

const hasVersion = (dependency: Dependency): boolean =>
	dependency.version.trim() !== "";

/**
 * Query OSV's batch endpoint for npm package vulnerabilities.
 *
 * The response order is guaranteed to match the submitted query order:
 * https://google.github.io/osv.dev/post-v1-querybatch/
 */
export async function fetchOsvVulnerabilityAlerts(
	dependencies: Dependency[],
	fetcher: Fetcher = fetch,
): Promise<OsvVulnerabilityAlert[]> {
	const queryDependencies = dependencies.filter(hasVersion);
	if (queryDependencies.length === 0) {
		return [];
	}

	const response = await fetcher(OSV_QUERY_BATCH_URL, {
		body: JSON.stringify({
			queries: queryDependencies.map((dependency) => ({
				package: {
					ecosystem: "npm",
					name: dependency.name,
				},
				version: dependency.version,
			})),
		}),
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
	});

	if (!response.ok) {
		throw new Error(`OSV query failed with status ${response.status}`);
	}

	const payload = (await response.json()) as OsvQueryBatchResponse;
	const results = payload.results ?? [];
	const alerts: OsvVulnerabilityAlert[] = [];

	for (const [index, result] of results.entries()) {
		const vulnerabilities = result.vulns ?? [];
		if (vulnerabilities.length === 0) {
			continue;
		}
		const dependency = queryDependencies[index];
		if (dependency) {
			alerts.push({ dependency, vulnerabilities });
		}
	}

	return alerts;
}

/** Log one line for each vulnerable package returned by OSV. */
export function logOsvVulnerabilityAlerts(
	alerts: OsvVulnerabilityAlert[],
	logger: Pick<Console, "log"> = console,
): void {
	for (const alert of alerts) {
		const vulnerabilityIds = alert.vulnerabilities
			.map((vulnerability) => vulnerability.id)
			.join(", ");
		logger.log(
			`OSV vulnerability found for ${alert.dependency.name}@${alert.dependency.version}: ${vulnerabilityIds}`,
		);
	}
}

/** Render OSV alerts as a GitHub warning block for the Dashboard issue body. */
export function renderOsvVulnerabilityAlerts(
	alerts: OsvVulnerabilityAlert[],
): string {
	if (alerts.length === 0) {
		return "";
	}

	const rows = alerts
		.map((alert) => {
			const vulnerabilityIds = alert.vulnerabilities
				.map((vulnerability) => `\`${vulnerability.id}\``)
				.join(", ");
			return `> | \`${alert.dependency.name}\` | \`${alert.dependency.version}\` | ${vulnerabilityIds} |`;
		})
		.join("\n");

	return `> [!WARNING]
> OSV reported vulnerabilities for detected npm dependencies.
>
> | Package | Version | Vulnerabilities |
> | --- | --- | --- |
${rows}`;
}
