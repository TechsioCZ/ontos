import { createHash } from 'node:crypto';

import { Effect, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AdmitSymmySyncPayloadSchema } from '../../shared/actions/admit-symmy-sync.ts';
import {
  SymmyCustomerGroupDefinitionFactsSchema,
  SymmyCustomerGroupRowsSchema,
} from '../../shared/domain/symmy-customer-group-batch.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyPartyCommerceIntentSchema } from '../../shared/domain/symmy-party-commerce-intents.ts';
import { buildSymmyCustomerGroupPlan } from '../../src/persistence/symmy-customer-group-plan.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const routeId = '33333333-3333-4333-8333-333333333333';
const authority = { mappingRevision: 'mapping-1', routeId, routeRevision: 'route-1' };
const operation = (entrypointKey: string) => ({
  entrypointKey,
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
});
const create = operation('commerce.customer-context.create-customer-group');
const update = operation('commerce.customer-context.update-customer-group');
const templateWith = (...enrolled: readonly ReturnType<typeof operation>[]) =>
  Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    items: [
      {
        effects: enrolled.map((enrolledOperation, index) => ({
          effectKey: `enrolled-${index}`,
          operation: enrolledOperation,
        })),
        itemKey: 'customer-group',
        source: {
          entityKind: 'CUSTOMER_GROUP',
          issuerId: 'route-issuer',
          sourceNamespace: 'route-groups',
          sourceRecordId: 'enrollment',
        },
      },
    ],
    sourceRouteId: routeId,
  });
type GroupChange = Partial<Record<'businessCode' | 'meaningKey' | 'name', string>>;
const group = (code: string, overrides: GroupChange = {}) => ({
  businessCode: 'WHOLESALE_BUYERS',
  code,
  description: 'Customers the source classifies as wholesale buyers',
  meaningKey: 'symmy.wholesale-buyers',
  membershipCriteria: 'The source explicitly assigns each wholesale buyer',
  name: 'Wholesale buyers',
  purpose: 'Wholesale buyer classification',
  ...overrides,
});
const groupRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
};
const factFor = (code: string) => ({
  businessCode: 'WHOLESALE_BUYERS',
  code,
  groupRef,
  meaningKey: 'symmy.wholesale-buyers',
  revision: 3,
  sourceOrder: 7,
});
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
const build = (
  rows: readonly unknown[],
  facts: readonly unknown[] = [],
  template: SymmyFixtureExecutionPlan = templateWith(create, update),
  idempotencyKey = 'group-key-1',
) =>
  buildSymmyCustomerGroupPlan({
    authority,
    digest,
    facts: Schema.decodeUnknownSync(SymmyCustomerGroupDefinitionFactsSchema)(facts),
    idempotencyKey,
    rows: Schema.decodeUnknownSync(SymmyCustomerGroupRowsSchema)(rows),
    template,
  });
const intentOf = (plan: SymmyFixtureExecutionPlan, index: number) =>
  Schema.decodeUnknownSync(SymmyPartyCommerceIntentSchema)(plan.items[index]?.effects[0]?.intent);
/** The create the item plans, if it plans one. */
const createOf = (plan: SymmyFixtureExecutionPlan, index: number) =>
  Match.value(intentOf(plan, index)).pipe(
    Match.tag('CustomerGroupCreate', ({ payload }) => payload),
    Match.option,
  );
/** The update the item plans, if it plans one. */
const updateOf = (plan: SymmyFixtureExecutionPlan, index: number) =>
  Match.value(intentOf(plan, index)).pipe(
    Match.tag('CustomerGroupUpdate', ({ payload }) => payload),
    Match.option,
  );
const revisionOf = (plan: SymmyFixtureExecutionPlan, index: number) =>
  Option.getOrThrow(Option.orElse(createOf(plan, index), () => updateOf(plan, index))).source?.revision;

describe('Symmy customer group plan from the public groups', () => {
  it.effect('creates a code the source has not bound, stating its own meaning and the route source', () =>
    Effect.gen(function* createsUnboundGroup() {
      const plan = Option.getOrThrow(yield* build([group('symmy-wholesale')]));
      const [item] = plan.items;
      expect(item?.itemKey).toBe('customer-group-0');
      expect(item?.source).toEqual({
        entityKind: 'CUSTOMER_GROUP',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-groups',
        sourceRecordId: 'symmy-wholesale',
      });
      expect(item?.effects[0]?.operation).toEqual(create);
      expect(item?.effects[0]?.originalTarget).toBeUndefined();
      expect(Option.getOrThrow(createOf(plan, 0))).toMatchObject({
        businessCode: 'WHOLESALE_BUYERS',
        initialState: 'ACTIVE',
        meaningKey: 'symmy.wholesale-buyers',
        name: 'Wholesale buyers',
        reason: 'Qualified Symmy source explicitly defines this customer group',
        source: {
          definitionEvidence: { kind: 'SOURCE_RECORD', reference: 'symmy-wholesale' },
          effectId: 'SYMMY_ASSIGNED_AT_ADMISSION',
          issuer: 'route-issuer',
          mappingRevision: 'mapping-1',
          namespace: 'route-groups',
          order: 1,
          recordId: 'symmy-wholesale',
          route: { id: routeId, revision: 'route-1' },
          sourceCode: 'symmy-wholesale',
        },
      });
    }),
  );

  it.effect('revises the group a bound code names, fenced on its revision and after its last source order', () =>
    Effect.gen(function* revisesBoundGroup() {
      const plan = Option.getOrThrow(
        yield* build([group('symmy-wholesale', { name: 'Wholesale buyers CZ' })], [factFor('symmy-wholesale')]),
      );
      const [effect] = plan.items[0]?.effects ?? [];
      expect(effect?.operation).toEqual(update);
      expect(effect?.originalTarget).toEqual(groupRef);
      expect(Option.getOrThrow(updateOf(plan, 0))).toMatchObject({
        expectedRevision: 3,
        groupRef,
        name: 'Wholesale buyers CZ',
        source: { order: 8 },
      });
    }),
  );

  it.effect('never turns a changed business code or meaning into an update of the bound group', () =>
    Effect.gen(function* changedMeaningIsACreate() {
      const changes: readonly GroupChange[] = [
        { meaningKey: 'symmy.retail-buyers' },
        { businessCode: 'RETAIL_BUYERS' },
      ];
      for (const changed of changes) {
        const plan = Option.getOrThrow(yield* build([group('symmy-wholesale', changed)], [factFor('symmy-wholesale')]));
        // The owner refuses this create as a conflict: the code is bound to a group of another meaning.
        expect(Option.getOrThrow(createOf(plan, 0))).toMatchObject({ source: { order: 8 } });
        expect(Option.isNone(updateOf(plan, 0))).toBe(true);
      }
    }),
  );

  it.effect('derives the revision from the request, so a replayed key states the same revision', () =>
    Effect.gen(function* stableRevision() {
      const first = Option.getOrThrow(yield* build([group('a'), group('b')]));
      const replay = Option.getOrThrow(yield* build([group('a'), group('b')]));
      const next = Option.getOrThrow(yield* build([group('a'), group('b')], [], undefined, 'group-key-2'));
      expect(replay).toEqual(first);
      expect(revisionOf(first, 0)).toMatch(/^symmy-customer-group-revision-[0-9a-f]{64}$/u);
      expect(revisionOf(first, 0)).not.toBe(revisionOf(first, 1));
      expect(revisionOf(next, 0)).not.toBe(revisionOf(first, 0));
      expect(first.items.map(({ sourceOccurrenceId }) => sourceOccurrenceId)).not.toEqual(
        next.items.map(({ sourceOccurrenceId }) => sourceOccurrenceId),
      );
    }),
  );

  it.effect('plans nothing for a new admission without what the owner holds for its codes', () =>
    Effect.gen(function* withoutFacts() {
      // The admission of a saved key's replay carries no facts; it must never plan a new admission.
      const admission = Schema.decodeUnknownSync(AdmitSymmySyncPayloadSchema)({
        customerGroups: [group('a')],
        idempotencyKey: 'group-key-1',
        routeKey: 'customerGroupsBatch',
      });
      const unread = yield* buildSymmyCustomerGroupPlan({
        authority,
        digest,
        facts: admission.groupFacts,
        idempotencyKey: admission.idempotencyKey,
        rows: Option.getOrThrow(Option.fromNullishOr(admission.customerGroups)),
        template: templateWith(create, update),
      });
      expect(Option.isNone(unread)).toBe(true);
      expect(Option.isSome(yield* build([group('a')]))).toBe(true);
    }),
  );

  it.effect('plans nothing when the route does not enroll the operation a row needs', () =>
    Effect.gen(function* unenrolled() {
      expect(Option.isNone(yield* build([group('a')], [], templateWith(update)))).toBe(true);
      expect(Option.isNone(yield* build([group('a')], [factFor('a')], templateWith(create)))).toBe(true);
      expect(Option.isSome(yield* build([group('a')], [factFor('a')], templateWith(update)))).toBe(true);
    }),
  );
});
