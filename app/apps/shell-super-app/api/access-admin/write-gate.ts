import { Context, Layer } from 'effect';

/*
 * The Novinky ship gate: whether adoption, decline and undo may run at all, and why not.
 *
 * Those three are the only part of the access-administration surface that changes access, so the
 * surface ships read-and-preview first. The server enforces this gate on every write (a retryable
 * 503, never a denial and never a silent no-op) and reports it to the screen, which must display the
 * answer rather than decide for itself. Publication of the decision is a deployment choice: a
 * composition provides the closed layer until P14's real-gate suite proves the writes, then provides
 * the proven one. Nothing here is ever read from a request body.
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
