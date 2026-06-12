import { customAlphabet } from "nanoid";

export const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

/** Cloudflare's maximum length for a Workflow instance ID. */
const INSTANCE_ID_MAX_LENGTH = 100;

/** Any run of characters Cloudflare rejects in a Workflow instance ID. */
const INSTANCE_ID_UNSAFE = /[^A-Za-z0-9_-]+/g;

/**
 * Build a Cloudflare Workflow instance ID from human-readable parts.
 *
 * Cloudflare validates instance IDs against `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` with
 * a 100-character maximum and rejects anything else with `instance.invalid_id`.
 * Our parts routinely violate that: repository names allow dots, npm packages
 * are scoped (`@types/node`), and Renovate group names contain spaces. Each part
 * has its unsafe runs collapsed to a hyphen; a `nanoid()` suffix then guarantees
 * uniqueness, and the readable prefix is truncated so that suffix always
 * survives inside the length limit.
 */
export function workflowInstanceId(...parts: string[]): string {
	const suffix = nanoid();
	const body =
		parts
			.join("-")
			.replace(INSTANCE_ID_UNSAFE, "-")
			.replace(/-+/g, "-")
			.replace(/^-+/, "") || "x";
	const room = INSTANCE_ID_MAX_LENGTH - suffix.length - 1;
	const prefix = body.slice(0, room).replace(/-+$/, "") || "x";
	return `${prefix}-${suffix}`;
}
