/**
 * A Rust/Go-style result: a call either succeeds with `data` or fails with an
 * `error`, never both. Callers branch on the `ok` discriminant instead of
 * wrapping calls in try/catch, which keeps error handling explicit and typed.
 */
export type Result<T, E = Error> =
	| { ok: true; data: T }
	| { ok: false; error: E };

/** Build a successful result. */
export const ok = <T>(data: T): Result<T, never> => ({ ok: true, data });

/** Build a failed result. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
