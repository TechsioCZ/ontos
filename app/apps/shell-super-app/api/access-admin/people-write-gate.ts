import { Context, Layer } from 'effect';

import type { AccessChangesWriteGate } from './write-gate.ts';
import { WRITES_PENDING_REAL_GATE } from './write-gate.ts';

/*
 * The Lidé ship gate, apart from Novinky's (`./write-gate.ts`): the same answer under a separate tag,
 * so every composition and test harness must choose a Lidé gate of its own and proving one surface
 * never opens the other.
 */
export class AccessPeopleWriteAvailability extends Context.Service<
  AccessPeopleWriteAvailability,
  AccessChangesWriteGate
>()('@app/shell-super-app/api/access-admin/people-write-gate/AccessPeopleWriteAvailability') {}

/** Lidé's shipped state until its suite is green: reads work, every write is a retryable 503. */
export const AccessPeopleWritesClosedLive: Layer.Layer<AccessPeopleWriteAvailability> = Layer.succeed(
  AccessPeopleWriteAvailability,
  Object.freeze({ available: false, reason: WRITES_PENDING_REAL_GATE }),
);

/** The reason the proven Lidé gate reports: the suite whose green run opens it. */
export const PEOPLE_WRITES_PROVEN = 'proven by tests/integration/access-admin-people-writes.test.ts';

/** Lidé writes open, provided only once tests/integration/access-admin-people-writes.test.ts is green. */
export const AccessPeopleWritesProvenLive: Layer.Layer<AccessPeopleWriteAvailability> = Layer.succeed(
  AccessPeopleWriteAvailability,
  Object.freeze({ available: true, reason: PEOPLE_WRITES_PROVEN }),
);
