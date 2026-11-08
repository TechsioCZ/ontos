#!/usr/bin/env node
/**
 * LOCAL ONLY. Repairs the demo's reviewed access by re-running the canonical reviewed seed (ADR-0030).
 *
 * The helper used to write its own `scoped_role` / `context_permission` / `action` relationships for one
 * persona. Authorization v2 retired that model: PostgreSQL holds intent and one Core writer projects it, so
 * the repair is the idempotent reviewed seed (`scripts/demo/local-repair.mts`), which writes exactly the
 * reviewed Roles, Assignments and memberships of `scripts/demo/permissions.mts`.
 */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit } from 'effect';

import { runCanonicalDemoRepair } from './local-repair.mts';

const program = runCanonicalDemoRepair()
  .pipe(Effect.tap(() => Console.log('Demo reviewed access re-seeded; identities and records were not reset.')))
  .pipe(Effect.provide(NodeServices.layer));

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(program);
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
