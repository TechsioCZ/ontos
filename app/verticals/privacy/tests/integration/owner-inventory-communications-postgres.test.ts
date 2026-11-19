import { scopePartRefs } from '@app/communications/privacy-owner/inventory';
import { makeCommunicationsOwnerNative } from '@app/communications/testing/privacy-owner-native';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { DateTime, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { describe, expect, it } from 'effect-rstest';

import { runOwnerInventory } from '../../src/api/owner-inventory.read.ts';
import {
  activityWith,
  capabilitiesOf,
  coverageEntry,
  lookupRequestOf,
} from '../support/owner-inventory-communications.fixture.ts';

/**
 * [#1410 AC-14 AC-15 AC-16, E19] The real composition for Communications' OWN data: Privacy's public owner-inventory Read
 * asks Communications, Communications reads its real tables on native PostgreSQL as the runtime role and answers from its
 * real Owner Coverage Read handler, and Privacy turns that answer into the inventory entry. Four outcomes are kept apart: an
 * existing scope, a separately evaluated complete empty scope, a partial coverage and an unavailable module.
 *
 * What is NOT real here, honestly: the Processing Activity is a labelled fixture (Privacy's own registry is proven by its own
 * suites), the Messaging Adapter and the backup evaluation are labelled doubles, and Core's governed call, SpiceDB and the
 * governed Read transport are not run (they need the native stack); the call is answered in the SDK's outcome vocabulary.
 */

const services = Layer.mergeAll(NodeCrypto.layer, NodeServices.layer, Reactivity.layer);
const evaluated = {
  backup: {
    evidenceRef: 'FICTIONAL-backup-evaluation-1',
    kind: 'EVALUATED',
    observedAt: DateTime.makeUnsafe('2026-11-19T10:00:00.000Z'),
  },
  eligibility: {},
  supplied: {},
} as const;
const unevaluated = { backup: { kind: 'UNAVAILABLE' }, eligibility: {}, supplied: {} } as const;

const communicationsActivity = (tenantId: string) =>
  activityWith(
    tenantId,
    scopePartRefs.map((scope) => coverageEntry(tenantId, 'communications.core', scope)),
  );

const entryOf = (answer: Effect.Success<ReturnType<typeof runOwnerInventory>>) =>
  answer.result.entries.find(({ moduleId }) => moduleId === 'communications.core');

describe('Privacy -> Communications -> Privacy over the real owner data (AC-15)', () => {
  it.live('finds the existing own data of the subject and evidences it with owner references', () =>
    Effect.gen(function* existingData() {
      const native = yield* makeCommunicationsOwnerNative();
      yield* native.seedExistingOwnData;
      const { capabilities } = capabilitiesOf(communicationsActivity(native.tenantId), native.tenantId, (asked) =>
        native.call(asked, evaluated),
      );
      const answer = yield* runOwnerInventory(lookupRequestOf(native.tenantId, 'customer-1'), capabilities);
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
        const native = yield* makeCommunicationsOwnerNative();
        yield* native.seedExistingOwnData;
        const activity = communicationsActivity(native.tenantId);
        const request = lookupRequestOf(native.tenantId, 'customer-404');
        const complete = capabilitiesOf(activity, native.tenantId, (asked) => native.call(asked, evaluated));
        const evaluatedAnswer = yield* runOwnerInventory(request, complete.capabilities);
        expect(entryOf(evaluatedAnswer)?.status).toBe('NO_DATA');
        expect(evaluatedAnswer.result.complete).toBe(true);
        // the very same empty search without the backup evaluation is partial, never a false empty scope (empty table != proof)
        const incomplete = capabilitiesOf(activity, native.tenantId, (asked) => native.call(asked, unevaluated));
        const unevaluatedAnswer = yield* runOwnerInventory(request, incomplete.capabilities);
        expect(entryOf(unevaluatedAnswer)?.status).toBe('PARTIAL');
        expect(unevaluatedAnswer.result.complete).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('keeps a partial coverage partial for an existing subject when the backup cannot be observed', () =>
    Effect.gen(function* partial() {
      const native = yield* makeCommunicationsOwnerNative();
      yield* native.seedExistingOwnData;
      const { capabilities } = capabilitiesOf(communicationsActivity(native.tenantId), native.tenantId, (asked) =>
        native.call(asked, unevaluated),
      );
      const answer = yield* runOwnerInventory(lookupRequestOf(native.tenantId, 'customer-1'), capabilities);
      expect(entryOf(answer)?.status).toBe('PARTIAL');
      expect(answer.result.complete).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('keeps an unavailable module unavailable: it is never NO_DATA and never complete', () =>
    Effect.gen(function* unavailableModule() {
      const native = yield* makeCommunicationsOwnerNative();
      const { capabilities } = capabilitiesOf(communicationsActivity(native.tenantId), native.tenantId, (asked) =>
        native.call(asked, evaluated, false),
      );
      const answer = yield* runOwnerInventory(lookupRequestOf(native.tenantId, 'customer-404'), capabilities);
      expect(entryOf(answer)?.status).toBe('UNAVAILABLE');
      expect(answer.result.complete).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('never confirms an answer for another tenant: the owner does not find a scope of a different tenant', () =>
    Effect.gen(function* foreignScope() {
      const native = yield* makeCommunicationsOwnerNative();
      yield* native.seedExistingOwnData;
      const foreignTenant = '00000000-0000-4000-8000-0000000000ff';
      const { capabilities } = capabilitiesOf(communicationsActivity(foreignTenant), foreignTenant, (asked) =>
        native.call(asked, evaluated),
      );
      const answer = yield* runOwnerInventory(lookupRequestOf(foreignTenant, 'customer-1'), capabilities);
      expect(entryOf(answer)?.status).toBe('UNAVAILABLE');
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
