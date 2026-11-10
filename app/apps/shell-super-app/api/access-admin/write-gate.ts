import { Context, Layer } from 'effect';

/*
 * The ship gates of the access-administration surface: whether a surface's writes may run at all, and
 * why not. Each surface that changes access has its own gate, so proving one surface never opens
 * another:
 *
 * - Novinky (adoption, decline and undo) reads `AccessChangesWriteAvailability`;
 * - Lidé (assign, revoke, delegate, teams, ownership transfer, admission and ending) reads
 *   `AccessPeopleWriteAvailability` from `./people-write-gate.ts` (one Context class per file).
 *
 * The server enforces a gate on every write of its surface (a retryable 503, never a denial and never a
 * silent no-op) and reports it to the screen, which must display the answer rather than decide for
 * itself. Publication of the decision is a deployment choice: a composition provides the closed layer
 * until the surface's real-gate suite proves the writes, then provides the proven one. Nothing here is
 * ever read from an environment variable, a request or a session.
 */

export interface AccessChangesWriteGate {
  readonly available: boolean;
  readonly reason: string;
}

/** The reason a closed gate reports; the only state the surface ships in until the suite is green. */
export const WRITES_PENDING_REAL_GATE = 'pending real-gate verification';

export class AccessChangesWriteAvailability extends Context.Service<
  AccessChangesWriteAvailability,
  AccessChangesWriteGate
>()('@app/shell-super-app/api/access-admin/write-gate/AccessChangesWriteAvailability') {}

/** The shipped state: reads and previews work, every write is refused with a retryable 503. */
export const AccessChangesWritesClosedLive: Layer.Layer<AccessChangesWriteAvailability> = Layer.succeed(
  AccessChangesWriteAvailability,
  Object.freeze({ available: false, reason: WRITES_PENDING_REAL_GATE }),
);
