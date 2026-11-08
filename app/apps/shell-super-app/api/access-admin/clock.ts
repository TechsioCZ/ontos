import { Context } from 'effect';
import type { Effect } from 'effect';

/**
 * The instant of one access-administration request, minted at the composition root from the one Clock
 * (D6). Every administration surface hands this instant to Core's fenced writes, so no BFF reads a
 * clock of its own and a test can state the instant it asserts.
 */
export interface AccessAdminClockService {
  readonly now: Effect.Effect<Date>;
}

export class AccessAdminClock extends Context.Service<AccessAdminClock, AccessAdminClockService>()(
  '@app/shell-super-app/api/access-admin/clock/AccessAdminClock',
) {}
