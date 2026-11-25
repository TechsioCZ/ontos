import { Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { validateController } from './prove-storefront-artifact.mts';
import { unavailableCgroup } from '../../packages/storefront-runtime/src/telemetry.ts';

it('rejects missing OOM counters when the runner can measure them', () => {
  const controller = { ...unavailableCgroup, oom: Option.some(0), oomKill: Option.some(0), version: 'v2' as const };
  expect(validateController(controller, controller)).toBe(true);
  expect(validateController({ ...controller, oom: Option.none() }, controller)).toBe(false);
  expect(validateController({ ...controller, oomKill: Option.none() }, controller)).toBe(false);
  expect(validateController(unavailableCgroup, unavailableCgroup)).toBe(true);
});
