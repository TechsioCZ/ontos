/**
 * FALSE POSITIVE (adversarial review, no-promise-shaped-port).
 *
 * These module-private `async` helpers are the *extracted body* of the one blessed Promise→Effect
 * conversion in this file: they are not exported, and their only callers are inside the argument
 * subtree of a single `Effect.tryPromise`. The audit's A5 target ("centralize Promise conversion at
 * the driver edge") is already met here; the rule only fails to see it because `atDriverEdge` is
 * lexical. Factoring a 60-line `try:` body into named helpers must not create three findings.
 *
 * Real hits reproduced here:
 * - apps/shell-super-app/api/modules/installed-module-catalog.ts:66,109
 * - packages/core-runtime/src/install/stage-context-bootstrap.ts:149,370
 * - apps/shell-super-app/api/auth/stage-demo-bootstrap-runtime-infrastructure.ts:25
 * - apps/shell-super-app/api/auth/impersonation-service.ts:271,289
 */
import { Effect } from "effect";

// The pg Pool and the Drizzle executor come from the driver-edge module (`allowPaths`).
import { database, pool } from "../auth/db/client.ts";

const reconcilePostgresContext = async (tenantId: string): Promise<string> =>
	await database.transaction(async () => tenantId);

const readBoundedBody = async (response: Response, maxBytes: number): Promise<string> => {
	const text = await response.text();
	return text.slice(0, maxBytes);
};

export const reconcileStageContext = (tenantId: string, response: Response) =>
	Effect.tryPromise({
		catch: () => "stage_context_bootstrap_failed" as const,
		try: async () => {
			const reconciled = await reconcilePostgresContext(tenantId);
			const body = await readBoundedBody(response, 1024);
			await pool.end();
			return `${reconciled}:${body}`;
		},
	});
