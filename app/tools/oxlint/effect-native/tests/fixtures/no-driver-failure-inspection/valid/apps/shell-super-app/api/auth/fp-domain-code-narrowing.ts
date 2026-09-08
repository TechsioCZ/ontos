/**
 * False positive reproduction (adversarial review of `no-driver-failure-inspection`).
 *
 * `code` is in `narrowedKeys` but is NOT in `ambiguousKeys`, so *any* `'code' in x` reports —
 * including narrowing of a first-party domain error code that has nothing to do with a
 * PostgreSQL/driver failure. Every typed error in this repo carries a `code` field
 * (`code: 'contacts_persistence_unavailable'`, `code: 'action_transaction_failed'`, ...), so `code`
 * is at least as ambiguous as `detail`/`schema`/`table`.
 *
 * Real occurrence: `apps/shell-super-app/api/auth/service.ts:285`
 *   `Predicate.isObjectKeyword(error.body) && error.body !== null && 'code' in error.body`
 * reads OntOS's own `ONTOS_IDENTITY_FORBIDDEN` / `ONTOS_IDENTITY_UNAVAILABLE` code back off a
 * better-auth `APIError` body, after `error instanceof APIError` has already narrowed the failure.
 * There is no SQLSTATE, no socket code and no `.cause` chain — the Core-owned *database* failure
 * decoder the message recommends cannot fix this line. Audit A5's target is the four PostgreSQL
 * cause-chain/SQLSTATE walkers, not domain-code transport.
 *
 * Suggested fix: add `code` to `ambiguousKeys` (so it needs a failure-shaped subject *and* driver
 * evidence nearby), or require a SQLSTATE/network-code comparison in the same narrowing.
 */
class ApiError extends Error {
	readonly body: unknown;
	readonly statusCode: number;
	constructor(statusCode: number, body: unknown) {
		super("api error");
		this.body = body;
		this.statusCode = statusCode;
	}
}

const FORBIDDEN_IDENTITY_CODE = "ONTOS_IDENTITY_FORBIDDEN";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export const isForbiddenIdentity = (error: unknown): boolean => {
	if (!(error instanceof ApiError)) return false;
	// FALSE POSITIVE: reported as `in` narrowing "on the driver key `code`".
	const code = isRecord(error.body) && "code" in error.body ? error.body.code : undefined;
	return code === FORBIDDEN_IDENTITY_CODE;
};

/** Same root cause on a first-party Problem Details value. */
export const isKnownProblem = (problem: unknown): boolean =>
	isRecord(problem) && "code" in problem && problem.code === "contacts_persistence_unavailable";
