import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import {
  ActivityRevisionConflict,
  ActivityReferenceIneligible,
  ActivityScopeMismatch,
  ActivityCommandSchema,
} from '../../shared/actions/apply-command.ts';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { OperationalScope } from '@app/core-runtime';
import { ActivityRefSchema } from '../../shared/resources/activity.ts';
import { evolveRelationshipsState, visibleActivities } from '../../src/services/persistence.service.ts';

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
    moduleId: 'work.tasks',
    resourceId: 'existing-task',
    resourceType: 'work.tasks.task',
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
    const change = yield* evolveRelationshipsState({ activities: [] }, decoded, input);
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
      yield* evolveRelationshipsState({ activities: [] }, decoded, {
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
        { activities: [] },
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
it.effect('an explicit Activity reach exposes only that Activity and AND restrictions cannot widen it', () =>
  Effect.gen(function* filteredActivities() {
    const decoded = yield* Schema.decodeEffect(ActivityCommandSchema)(command);
    const change = yield* evolveRelationshipsState({ activities: [] }, decoded, input);
    const otherRef = yield* Schema.decodeEffect(ActivityRefSchema)({ ...change.activity.ref, resourceId: 'other' });
    const records = [change.activity, { ...change.activity, ref: otherRef }];
    const reach: ListAccessPredicate = {
      groups: [
        {
          clauses: [
            { conditions: [{ _tag: 'RecordKeyIn' as const, recordKeys: [RecordKeySchema.make('activity')] as const }] },
          ],
        },
      ],
    };
    expect(yield* visibleActivities(records, scope, reach)).toEqual([change.activity]);
    expect(
      yield* visibleActivities(records, scope, {
        groups: [
          ...reach.groups,
          {
            clauses: [
              {
                conditions: [
                  Schema.decodeSync(ListAccessConditionSchema)({
                    _tag: 'TeamMemberOf',
                    teamIds: ['20000000-0000-4000-8000-000000000006'],
                  }),
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
    expect(
      yield* visibleActivities(
        [
          {
            ...change.activity,
            ref: {
              ...change.activity.ref,
              tenantId: Schema.decodeSync(ActivityRefSchema)({
                ...change.activity.ref,
                tenantId: '30000000-0000-4000-8000-000000000001',
              }).tenantId,
            },
          },
        ],
        scope,
        { groups: [] },
      ),
    ).toEqual([]);
  }),
);
