/**
 * The one refusal the retired demo authorization helpers share (ADR-0030).
 *
 * Authorization v2 retired the `scoped_role` / `module_access` / `context_permission` / `action` model: the
 * engine schema is fixed, PostgreSQL holds intent and one Core writer projects it. A demo helper that used
 * to write those relations by hand cannot translate itself — a hand-written tuple is reconciled away by
 * the next Core write, and no import or migration step exists — so it refuses with the canonical
 * replacement instead of writing a relationship nothing reads, or a tuple the engine no longer accepts.
 */
import { Schema } from 'effect';

export class RetiredDemoAuthorizationError extends Schema.TaggedError<RetiredDemoAuthorizationError>()(
  'RetiredDemoAuthorizationError',
  { code: Schema.String, reason: Schema.String },
) {}

/** The canonical replacement of every retired demo grant helper: the reviewed seed of the whole tenant. */
export const CANONICAL_DEMO_SEED_REMEDIATION =
  'Use the canonical reviewed seed: locally `pnpm demo:reset-permissions` (or `pnpm demo:reset`), on stage `apps/shell-super-app/scripts/bootstrap-stage-accounts.mts` with the operator accounts file, and the Access administration screens for one-off changes. The legacy SpiceDB scoped-role/context-permission/action policy has no migration or import step (ADR-0030).';

export const refuseRetiredDemoAuthorization = (code: string, reason: string): RetiredDemoAuthorizationError =>
  new RetiredDemoAuthorizationError({ code, reason: `${reason} ${CANONICAL_DEMO_SEED_REMEDIATION}` });
