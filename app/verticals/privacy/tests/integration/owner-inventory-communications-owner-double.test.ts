import { scopePartRefs } from '@app/communications/privacy-owner/inventory';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { describe, expect, it } from 'effect-rstest';

import { runOwnerInventory } from '../../src/api/owner-inventory.read.ts';
import {
  activityWith,
  capabilitiesOf,
  coverageEntry,
  fixtureTenantId,
  lookupRequestOf,
} from '../support/owner-inventory-communications.fixture.ts';
import { communicationsOwnerDouble, ownerUnavailable } from '../support/communications-owner-double.ts';

/**
 * [#1410 AC-14 AC-15 AC-16, E19] Privacy's public owner-inventory Read asks Communications for its OWN data through the
 * published Owner Coverage Read and turns the answer into the inventory entry. Four outcomes are kept apart: an existing
 * scope, a separately evaluated complete empty scope, a partial coverage and an unavailable module.
 *
 * What is NOT real here, honestly: the owner is Privacy's OWN labelled double, built from the published Read contract only
 * (`support/communications-owner-double.ts`); it imports nothing of the Communications vertical's tests or tables, because test
 * code must never be on that vertical's package surface. That the real owner answers so over native PostgreSQL is proven in
 * the Communications suite (`privacy-owner-coverage.test.ts`). The Processing Activity is a labelled fixture, and Core's
 * governed call, SpiceDB and the governed Read transport are not run: the call is answered in the SDK's outcome vocabulary.
 */

const services = Layer.mergeAll(NodeCrypto.layer, NodeServices.layer, Reactivity.layer);
const tenantId = fixtureTenantId;
const owner = (backupEvaluated: boolean, forTenant = tenantId) =>
  communicationsOwnerDouble({
    backupEvaluated,
    refsBySubject: {
      'customer-1': ['communications.core.request:FICTIONAL-1', 'communications.core.intent:FICTIONAL-1'],
    },
    tenantId: forTenant,
  });

const communicationsActivity = (activityTenantId: string) =>
  activityWith(
    activityTenantId,
    scopePartRefs.map((scope) => coverageEntry(activityTenantId, 'communications.core', scope)),
  );

const entryOf = (answer: Effect.Success<ReturnType<typeof runOwnerInventory>>) =>
  answer.result.entries.find(({ moduleId }) => moduleId === 'communications.core');

describe('Privacy -> Communications -> Privacy over the published Owner Coverage contract (AC-15)', () => {
  it.live('finds the existing own data of the subject and evidences it with owner references', () =>
    Effect.gen(function* existingData() {
      const { capabilities } = capabilitiesOf(communicationsActivity(tenantId), tenantId, owner(true));
      const answer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities);
      const entry = entryOf(answer);
      expect(entry?.status).toBe('FOUND');
      expect(entry?.resourceRefs.some((ref) => ref.startsWith('communications.core.request:'))).toBe(true);
      expect(entry?.resourceRefs.some((ref) => ref.startsWith('communications.core.intent:'))).toBe(true);
      expect(answer.result.complete).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live(
    'proves a separately and completely evaluated empty scope as NO_DATA, only with the whole scope evidenced',
    () =>
      Effect.gen(function* emptyScope() {
        const activity = communicationsActivity(tenantId);
        const request = lookupRequestOf(tenantId, 'customer-404');
        const complete = capabilitiesOf(activity, tenantId, owner(true));
        const evaluatedAnswer = yield* runOwnerInventory(request, complete.capabilities);
        expect(entryOf(evaluatedAnswer)?.status).toBe('NO_DATA');
        expect(evaluatedAnswer.result.complete).toBe(true);
        // the very same empty search without the backup evaluation is partial, never a false empty scope (empty table != proof)
        const incomplete = capabilitiesOf(activity, tenantId, owner(false));
        const unevaluatedAnswer = yield* runOwnerInventory(request, incomplete.capabilities);
        expect(entryOf(unevaluatedAnswer)?.status).toBe('PARTIAL');
        expect(unevaluatedAnswer.result.complete).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('keeps a partial coverage partial for an existing subject when the backup cannot be observed', () =>
    Effect.gen(function* partial() {
      const { capabilities } = capabilitiesOf(communicationsActivity(tenantId), tenantId, owner(false));
      const answer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities);
      expect(entryOf(answer)?.status).toBe('PARTIAL');
      expect(answer.result.complete).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('keeps an unavailable module unavailable: it is never NO_DATA and never complete', () =>
    Effect.gen(function* unavailableModule() {
      const { capabilities } = capabilitiesOf(communicationsActivity(tenantId), tenantId, () =>
        Effect.succeed(ownerUnavailable),
      );
      const answer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-404'), capabilities);
      expect(entryOf(answer)?.status).toBe('UNAVAILABLE');
      expect(answer.result.complete).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('never confirms an answer for another tenant: the owner does not find a scope of a different tenant', () =>
    Effect.gen(function* foreignScope() {
      const foreignTenant = '00000000-0000-4000-8000-0000000000ff';
      // the owner knows only the home tenant: the scope of another tenant is not found, whatever the activity claims
      const { capabilities } = capabilitiesOf(communicationsActivity(foreignTenant), foreignTenant, owner(true));
      const answer = yield* runOwnerInventory(lookupRequestOf(foreignTenant, 'customer-1'), capabilities);
      expect(entryOf(answer)?.status).toBe('UNAVAILABLE');
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
