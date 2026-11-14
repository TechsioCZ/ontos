import * as owner from '@app/core-runtime/testing/owner-evidence' with { rstest: 'importActual' };
import { Effect, Layer } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { partyCompositionSnapshot } from '../integration/application-composition.setup.ts';

rs.mock('@app/core-runtime/testing/owner-evidence', () => ({
  ...owner,
  CoreDatabaseLive: Layer.effect(owner.CoreDatabase, Effect.die('Import must not acquire a database')),
}));

it('imports the Party authority setup without starting database bootstrap', () => {
  expect(Effect.isEffect(partyCompositionSnapshot)).toBe(true);
});
