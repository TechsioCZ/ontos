import {
  ActivityRevisionConflict,
  ActivityReferenceIneligible,
  ActivityScopeMismatch,
  ActivityCommandSchema,
  ActivityReferenceUnavailable,
} from '../../shared/actions/apply-command.ts';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessService, OperationalScope } from '@app/core-runtime';
import { ActivityRefSchema } from '../../shared/resources/activity.ts';
import { EmailObservationSchema, RelationshipsStateSchema } from '../../shared/apis/records.ts';
import {
  evolveRelationshipsState,
  visibleActivities,
  visibleEmailObservations,
} from '../../src/services/persistence.service.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'party',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const input = { now: DateTime.makeUnsafe('2026-10-05T10:00:00Z'), partyRef, resourceId: 'activity', tenantId };
const command = {
  _tag: 'RecordActivity',
  followUpTaskRef: {
    moduleId: 'siampark.work',
    resourceId: 'existing-task',
    resourceType: 'siampark.work.task',
    tenantId,
  },
  kind: 'CALL',
  occurredAt: '2026-10-05T09:00:00Z',
  ownerPrincipalRef: { principalId: '20000000-0000-4000-8000-000000000002', tenantId },
  partyRef,
  summary: 'Called tenant',
} as const;
it.effect('records canonical identity and the existing follow-up Task without creating another Task', () =>
  Effect.gen(function* case1() {
    const decoded = yield* Schema.decodeEffect(ActivityCommandSchema)(command);
    const change = yield* evolveRelationshipsState({ activities: [], emailObservations: [] }, decoded, input);
    expect(change.state.activities).toHaveLength(1);
    expect(change.activity.followUpTaskRef).toEqual(command.followUpTaskRef);
    expect(change.activity.partyRef).toEqual(partyRef);
    expect(DateTime.toEpochMillis(change.activity.occurredAt)).toBeLessThan(
      DateTime.toEpochMillis(change.activity.createdAt),
    );
    expect(yield* evolveRelationshipsState(change.state, decoded, input).pipe(Effect.flip)).toBeInstanceOf(
      ActivityRevisionConflict,
    );
    expect(
      yield* evolveRelationshipsState({ activities: [], emailObservations: [] }, decoded, {
        ...input,
        partyRef: { ...partyRef, resourceId: 'unrelated' },
      }).pipe(Effect.flip),
    ).toBeInstanceOf(ActivityReferenceIneligible);
  }),
);
it.effect('refuses missing identity and foreign tenant references', () =>
  Effect.gen(function* case2() {
    const { followUpTaskRef: omittedTask, partyRef: omitted, ...noIdentity } = command;
    void omitted;
    void omittedTask;
    expect(yield* Schema.decodeEffect(ActivityCommandSchema)(noIdentity).pipe(Effect.isFailure)).toBe(true);
    expect(
      yield* evolveRelationshipsState(
        { activities: [], emailObservations: [] },
        yield* Schema.decodeEffect(ActivityCommandSchema)({
          ...command,
          followUpTaskRef: { ...command.followUpTaskRef, tenantId: '30000000-0000-4000-8000-000000000001' },
        }),
        input,
      ).pipe(Effect.flip),
    ).toBeInstanceOf(ActivityScopeMismatch);
  }),
);

const scope: OperationalScope = {
  authBindingId: '20000000-0000-4000-8000-000000000003',
  authContextRef: 'session:test',
  authMethod: 'session',
  correlationId: 'test:relationships',
  legalEntityId: '20000000-0000-4000-8000-000000000004',
  principalId: command.ownerPrincipalRef.principalId,
  tenantId,
};
const fakeAccess = (wrongDecisionKey = false): ContextAccessService => ({
  assortmentPermissions: () => Effect.succeed([]),
  businessPermissions: () => Effect.succeed([]),
  contextPermissions: ({ targets }) =>
    Effect.succeed(
      targets.map(({ moduleId, permission }) => ({
        decision: 'denied' as const,
        key: `${moduleId}:${permission}`,
      })),
    ),
  identityNamespaces: () => Effect.succeed([]),
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map((ref) => ({
        decision: ref.resourceId === 'activity' ? ('allowed' as const) : ('denied' as const),
        key: wrongDecisionKey ? 'unrelated-resource' : `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
      })),
    ),
  tenants: () => Effect.succeed([]),
});
it.effect('an assigned Activity grant exposes only that Activity and rejects a mismatched authorization result', () =>
  Effect.gen(function* filteredActivities() {
    const decoded = yield* Schema.decodeEffect(ActivityCommandSchema)(command);
    const change = yield* evolveRelationshipsState({ activities: [], emailObservations: [] }, decoded, input);
    const otherRef = yield* Schema.decodeEffect(ActivityRefSchema)({ ...change.activity.ref, resourceId: 'other' });
    const records = [change.activity, { ...change.activity, ref: otherRef }];
    expect(yield* visibleActivities(records, scope).pipe(Effect.provideService(ContextAccess, fakeAccess()))).toEqual([
      change.activity,
    ]);
    expect(
      yield* visibleActivities(records, scope).pipe(
        Effect.provideService(ContextAccess, fakeAccess(true)),
        Effect.flip,
      ),
    ).toBeInstanceOf(ActivityReferenceUnavailable);
  }),
);

const emailObservationWire = {
  attemptedAt: '2026-10-05T09:00:00Z',
  completedAt: '2026-10-05T09:00:01Z',
  correlation: 'email:followup:demo',
  integrationKind: 'EMAIL',
  mode: 'SIMULATED',
  observationId: '20000000-0000-4000-8000-000000000005',
  ownerResourceRef: {
    moduleId: 'siampark.relationships',
    resourceId: 'activity',
    resourceType: 'siampark.relationships.activity',
    tenantId,
  },
  providerLabel: 'DEMO',
  receipt: 'SIMULATED:email:followup:receipt',
  requestSummary: 'Simulated follow-up notification for the recorded Activity',
  resultSummary: 'Demo provider accepted the synthetic notification; no message sent',
  status: 'SUCCESS',
} as const;

it.effect('requires an explicit simulated provider receipt, stable UUID and valid completion chronology', () =>
  Effect.gen(function* emailObservationValidation() {
    const observation = yield* Schema.decodeEffect(EmailObservationSchema)(emailObservationWire);
    expect(observation.integrationKind).toBe('EMAIL');
    expect(observation.mode).toBe('SIMULATED');
    for (const invalid of [
      { ...emailObservationWire, observationId: 'unstable-id' },
      { ...emailObservationWire, receipt: '' },
      { ...emailObservationWire, providerLabel: 'SMTP' },
      { ...emailObservationWire, mode: 'LIVE' },
      { ...emailObservationWire, completedAt: '2026-10-05T08:59:59Z' },
    ]) {
      expect(yield* Schema.decodeUnknownEffect(EmailObservationSchema)(invalid).pipe(Effect.isFailure)).toBe(true);
    }
  }),
);

it.effect(
  'rejects orphan or foreign-tenant observation owners and preserves observations when recording Activity',
  () =>
    Effect.gen(function* emailOwnerIntegrity() {
      const decoded = yield* Schema.decodeEffect(ActivityCommandSchema)(command);
      const change = yield* evolveRelationshipsState({ activities: [], emailObservations: [] }, decoded, input);
      const activity = yield* Schema.encodeEffect(RelationshipsStateSchema)({
        activities: [change.activity],
        emailObservations: [],
      });
      const state = yield* Schema.decodeUnknownEffect(RelationshipsStateSchema)({
        ...activity,
        emailObservations: [emailObservationWire],
      });
      for (const ownerResourceRef of [
        { ...emailObservationWire.ownerResourceRef, resourceId: 'orphan' },
        { ...emailObservationWire.ownerResourceRef, tenantId: '30000000-0000-4000-8000-000000000001' },
      ]) {
        expect(
          yield* Schema.decodeUnknownEffect(RelationshipsStateSchema)({
            ...activity,
            emailObservations: [{ ...emailObservationWire, ownerResourceRef }],
          }).pipe(Effect.isFailure),
        ).toBe(true);
      }
      const next = yield* evolveRelationshipsState(state, decoded, { ...input, resourceId: 'new-activity' });
      expect(next.state.emailObservations).toEqual(state.emailObservations);
      expect(next.state.activities).toHaveLength(2);
    }),
);

it.effect('filters email attempts by the complete authorized owner Activity reference without leaking counts', () =>
  Effect.gen(function* visibleEmailAttempts() {
    const decoded = yield* Schema.decodeEffect(ActivityCommandSchema)(command);
    const change = yield* evolveRelationshipsState({ activities: [], emailObservations: [] }, decoded, input);
    const authorized = yield* visibleActivities([change.activity], scope).pipe(
      Effect.provideService(ContextAccess, fakeAccess()),
    );
    const observation = yield* Schema.decodeEffect(EmailObservationSchema)(emailObservationWire);
    const hidden = yield* Schema.decodeUnknownEffect(EmailObservationSchema)({
      ...emailObservationWire,
      ownerResourceRef: { ...emailObservationWire.ownerResourceRef, resourceId: 'hidden' },
    });
    const foreign = yield* Schema.decodeUnknownEffect(EmailObservationSchema)({
      ...emailObservationWire,
      ownerResourceRef: {
        ...emailObservationWire.ownerResourceRef,
        tenantId: '30000000-0000-4000-8000-000000000001',
      },
    });
    expect(visibleEmailObservations([observation, hidden, foreign], authorized)).toEqual([observation]);
    expect(visibleEmailObservations([observation, hidden, foreign], [])).toEqual([]);
  }),
);
