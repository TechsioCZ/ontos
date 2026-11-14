import { Context, DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessIntent } from '../../src/access/decision/authority.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { AccessPrincipalKindSource } from '../../src/access/enforcement/actor.ts';
import { AccessDecisionLogBatch } from '../../src/access/enforcement/decision-log-batch.ts';
import {
  SubjectAccessInspection,
  SubjectAccessInspectionLive,
  SubjectInspectionIdentitySource,
  SubjectInspectionUnavailable,
} from '../../src/access/enforcement/index.ts';
import { ActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../src/modules/active-application-composition.ts';
import { coreActionCatalog } from '../../src/modules/actions/catalog.ts';
import { declaredActionAuthorities } from '../../src/permissions/action-authority.ts';
import { buildInstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';
import { makeAuthority, person, otherPerson, tenant } from './access-decision-support.ts';

const requesterScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000084',
    authContextRef: 'session:live-subject-inspection',
    authMethod: 'session',
    principalId: person,
    tenantId: tenant,
  }),
  correlationId: 'live-subject-inspection',
});
const base = {
  queryScope: { tenantId: tenant },
  requesterScope,
  subject: { principalId: otherPerson, tenantId: tenant },
};

const live = Effect.fn('SubjectInspectionTest.live')(function* live(snapshot: ActiveApplicationCompositionSnapshot) {
  const authority = makeAuthority({ cells: [] });
  const layer = SubjectAccessInspectionLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AccessIntent, {
          authorityFor: (scope) => {
            expect(scope).toBe(requesterScope);
            return authority.port;
          },
        }),
        Layer.succeed(AccessPrincipalKindSource, {
          readKind: ({ scope }) => {
            expect(scope).toBe(requesterScope);
            return Effect.succeed(Option.some('human'));
          },
        }),
        Layer.succeed(AccessDecisionLogBatch, {
          recordAll: (entries) => {
            for (const entry of entries) {
              expect(entry.scope).toBe(requesterScope);
              expect(entry.onBehalfOfPrincipalId).toBe(person);
            }
            return Effect.void;
          },
        }),
        Layer.succeed(DecisionCheck, {
          checkBulk: (items) => Effect.succeed(items.map(() => ({ permissionship: 'none' as const }))),
        }),
        Layer.succeed(SubjectInspectionIdentitySource, {
          read: ({ requesterScope: scope }) => {
            expect(scope).toBe(requesterScope);
            return Effect.succeed(Option.some({ principalStatus: 'active', tenantStatus: 'active' }));
          },
        }),
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      ),
    ),
  );
  const built = yield* Layer.build(layer);
  return Context.get(built, SubjectAccessInspection);
});

it('resolves actual retained Core Action registrations through the existing canonical catalog, not key prefixes', () =>
  (() => {
    const installed = buildInstalledModuleCatalog([]);
    const indexed = declaredActionAuthorities(installed);
    expect(indexed.size).toBe(coreActionCatalog.length);
    for (const registration of coreActionCatalog) {
      const resolved = indexed.get(registration.actionKey);
      expect(resolved?.legalEntityScope).toBe(registration.legalEntityScope);
      expect(resolved?.carrier.accessDeclaration?.key).toBe(registration.accessDeclaration?.key);
      expect(resolved?.carrier.accessActor?.subject).toBe(registration.accessActor?.subject);
      expect(resolved?.carrier.accessWorkload?.workloads).toEqual(registration.accessWorkload?.workloads);
    }
    expect(indexed.has('prefix-guessed.action')).toBe(false);
  })());

it.effect(
  'captures one real live inspection service with no method context requirement and refuses ungranted Core Actions',
  () =>
    Effect.gen(function* liveProjection() {
      const snapshot = yield* makeApplicationCompositionSnapshotFixture();
      const service = yield* live(snapshot);
      const result = yield* service.actions({
        ...base,
        actionKeys: ['core.identity.invite-person', 'not.a.published-action'],
      });
      expect(result).toEqual({
        authorities: [
          { actionKey: 'core.identity.invite-person', propose: 'denied', run: 'denied' },
          { actionKey: 'not.a.published-action', propose: 'denied', run: 'denied' },
        ],
        inspectionOnly: true,
      });
    }),
);

it.effect('rejects an expired approved composition before subject or Action inspection', () =>
  Effect.gen(function* expiredComposition() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    const service = yield* live(snapshot);
    yield* TestClock.setTime(DateTime.toEpochMillis(snapshot.validUntil));
    const result = yield* Effect.result(service.actions({ ...base, actionKeys: ['core.identity.invite-person'] }));
    expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
  }),
);
