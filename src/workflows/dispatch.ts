/**
 * The manager-to-binding dispatch map: which {@link Env} Workflow binding each
 * Manager's Safe upgrades are routed to. A literal so adding a Manager is a
 * one-line change; a Manager missing from it is a programmer error and throws at
 * the dispatch seam rather than being silently dropped.
 */
export const MANAGER_WORKFLOW_BINDINGS = {
	mise: "MISE_WORKFLOW",
	npm: "NPM_WORKFLOW",
	"github-actions": "GITHUB_ACTIONS_WORKFLOW",
} as const satisfies Record<string, keyof Env>;

/**
 * Managers whose update mechanism is not yet wired. Their Safe upgrades stay on
 * the dashboard but are not dispatched, so no no-op Manager workflow runs.
 * github-actions is deferred until an `aube action` subcommand exists.
 */
export const DEFERRED_MANAGERS: ReadonlySet<string> = new Set([
	"github-actions",
]);

/** The Workflow binding for a Manager, throwing when the Manager is unmapped. */
export function managerWorkflowBinding(manager: string): keyof Env {
	const binding = (
		MANAGER_WORKFLOW_BINDINGS as Record<string, keyof Env | undefined>
	)[manager];
	if (!binding) {
		throw new Error(`No Manager workflow binding registered for "${manager}"`);
	}
	return binding;
}
