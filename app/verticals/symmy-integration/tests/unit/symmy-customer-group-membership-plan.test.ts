import { createHash } from 'node:crypto';

import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyGroupCustomerRowsSchema } from '../../shared/domain/symmy-customer-group-batch.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import {
  buildSymmyGroupMembershipPlan,
  orderSymmyPlanMemberships,
} from '../../src/persistence/symmy-customer-group-membership-plan.ts';
import type {
  SymmyGroupMembershipLineage,
  SymmyGroupMembershipOrder,
} from '../../src/persistence/symmy-customer-group-membership-plan.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const routeId = '33333333-3333-4333-8333-333333333333';
const authority = { mappingRevision: 'mapping-1', routeId, routeRevision: 'route-1' };
const groupRef = (resourceId: string) => ({
  moduleId: 'commerce.customer-context',
  resourceId,
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
});
const wholesale = groupRef('44444444-4444-4444-8444-444444444444');
const retail = groupRef('55555555-5555-4555-8555-555555555555');
const templateFor = (target: ReturnType<typeof groupRef>, groupRecordId: string, enrolled = true) =>
  Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'enrolled-membership',
            operation: {
              entrypointKey: enrolled
                ? 'commerce.customer-context.apply-customer-group-membership-source'
                : 'commerce.customer-context.assign-customer-group',
              moduleId: 'commerce.customer-context',
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'membership',
        source: {
          entityKind: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuerId: 'route-issuer',
          sourceNamespace: 'route-memberships',
          sourceRecordId: 'enrollment',
        },
      },
    ],
    selector: {
      kind: 'CUSTOMER_GROUP',
      source: {
        entityKind: 'CUSTOMER_GROUP',
        issuerId: 'route-issuer',
        route: { integrationRouteId: routeId, tenantId },
        sourceNamespace: 'route-groups',
        sourceRecordId: groupRecordId,
      },
      target,
    },
    sourceRouteId: routeId,
  });
const profile = (resourceId: string, profileTenant = tenantId) => ({
  profile: {
    profileKind: 'RETAIL',
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: profileTenant,
    },
  },
});
const rowsOf = (...rows: readonly unknown[]) => Schema.decodeUnknownSync(SymmyGroupCustomerRowsSchema)(rows);
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
/** A route without a selling legal entity. */
const noLegalEntity = Option.getOrUndefined(Option.none<string>());

/** The admission's lineage ledger: the next order of a lineage, one more than the last one reserved for it. */
const ledger = () => {
  const reserved: SymmyGroupMembershipLineage[] = [];
  const last = new Map<string, number>();
  const reserve = (lineage: SymmyGroupMembershipLineage) =>
    Effect.sync((): SymmyGroupMembershipOrder => {
      reserved.push(lineage);
      const key = JSON.stringify([lineage.issuer, lineage.namespace, lineage.profileId]);
      const order = (last.get(key) ?? 0) + 1;
      last.set(key, order);
      return { effectiveAt: DateTime.makeUnsafe(`2026-11-20T10:00:0${order}.000Z`), order };
    });
  return { reserve, reserved };
};
type Ledger = ReturnType<typeof ledger>;
const build = (
  book: Ledger,
  rows: ReturnType<typeof rowsOf>,
  template: SymmyFixtureExecutionPlan = templateFor(wholesale, 'symmy-wholesale'),
  options: { readonly idempotencyKey?: string; readonly withoutLegalEntity?: boolean } = {},
) =>
  buildSymmyGroupMembershipPlan({
    authority,
    digest,
    idempotencyKey: options.idempotencyKey ?? 'members-key-1',
    legalEntityId: options.withoutLegalEntity === true ? noLegalEntity : legalEntityId,
    reserve: book.reserve,
    rows,
    template,
    tenantId,
  });
/** A membership plan holds only source assignments: anything else fails this decoder. */
const AssignmentIntentSchema = Schema.Struct({
  _tag: Schema.Literal('CustomerGroupMembership'),
  payload: ApplyCustomerGroupMembershipSourcePayloadSchema.members[0],
});
const assignmentOf = (plan: SymmyFixtureExecutionPlan, index: number) =>
  Schema.decodeUnknownSync(AssignmentIntentSchema)(plan.items[index]?.effects[0]?.intent).payload;
const lower = 'abcdef00-6666-4666-8666-666666666666';

describe('Symmy group membership plan from the public customers', () => {
  it.effect('assigns each profile to the selected group under its manager, route and reserved order', () =>
    Effect.gen(function* assignsSelectedGroup() {
      const book = ledger();
      const plan = Option.getOrThrow(yield* build(book, rowsOf(profile(lower))));
      const [item] = plan.items;
      expect(item?.itemKey).toBe('membership-0');
      expect(item?.effects[0]?.originalTarget).toEqual(profile(lower).profile.profileRef);
      expect(item?.source).toMatchObject({
        entityKind: 'CUSTOMER_GROUP_MEMBERSHIP',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-memberships',
      });
      const assignment = assignmentOf(plan, 0);
      expect(assignment).toMatchObject({
        effectiveAt: '2026-11-20T10:00:01.000Z',
        groupRef: wholesale,
        manager: {
          factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuer: 'route-issuer',
          sourceNamespace: 'route-memberships',
          tenantId,
        },
        operation: 'ASSIGN',
        profile: profile(lower).profile,
        route: { id: routeId, revision: 'route-1' },
        source: { effectId: 'SYMMY_ASSIGNED_AT_ADMISSION', order: 1, sourceRecordId: item?.source.sourceRecordId },
      });
      expect(assignment.source.assertionId).toBe(item?.sourceOccurrenceId);
      expect(book.reserved).toEqual([{ issuer: 'route-issuer', namespace: 'route-memberships', profileId: lower }]);
    }),
  );

  it.effect('gives one profile distinct orders when it joins two groups, in the order of admission', () =>
    Effect.gen(function* twoGroupsOneLineage() {
      const book = ledger();
      const first = Option.getOrThrow(yield* build(book, rowsOf(profile(lower))));
      const second = Option.getOrThrow(
        yield* build(book, rowsOf(profile(lower)), templateFor(retail, 'symmy-retail'), {
          idempotencyKey: 'members-key-2',
        }),
      );
      expect(assignmentOf(first, 0)).toMatchObject({ groupRef: wholesale, source: { order: 1 } });
      expect(assignmentOf(second, 0)).toMatchObject({ groupRef: retail, source: { order: 2 } });
      expect(assignmentOf(second, 0).effectiveAt >= assignmentOf(first, 0).effectiveAt).toBe(true);
      expect(first.items[0]?.source.sourceRecordId).not.toBe(second.items[0]?.source.sourceRecordId);
    }),
  );

  it.effect('chooses the lineage from the canonical profile, so two spellings of one profile share it', () =>
    Effect.gen(function* canonicalLineage() {
      const book = ledger();
      const upper = Option.getOrThrow(yield* build(book, rowsOf(profile(lower.toUpperCase()))));
      const plain = Option.getOrThrow(
        yield* build(book, rowsOf(profile(lower)), templateFor(retail, 'symmy-retail'), {
          idempotencyKey: 'members-key-2',
        }),
      );
      expect(book.reserved.map(({ profileId }) => profileId)).toEqual([lower, lower]);
      expect(assignmentOf(upper, 0).profile.profileRef.resourceId).toBe(lower);
      expect(upper.items[0]?.effects[0]?.originalTarget?.resourceId).toBe(lower);
      expect([assignmentOf(upper, 0).source.order, assignmentOf(plain, 0).source.order]).toEqual([1, 2]);
    }),
  );

  it.effect('reserves the lineages of one request in canonical order and keeps the items in request order', () =>
    Effect.gen(function* canonicalReservationOrder() {
      const book = ledger();
      const later = 'ffffffff-6666-4666-8666-666666666666';
      const plan = Option.getOrThrow(yield* build(book, rowsOf(profile(later), profile(lower))));
      expect(book.reserved.map(({ profileId }) => profileId)).toEqual([lower, later]);
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual(['membership-0', 'membership-1']);
      expect(assignmentOf(plan, 0).profile.profileRef.resourceId).toBe(later);
    }),
  );

  it.effect('plans nothing and reserves nothing without a selected group, a membership source or a legal entity', () =>
    Effect.gen(function* refusesUnroutable() {
      const book = ledger();
      const rows = rowsOf(profile(lower));
      expect(Option.isNone(yield* build(book, rows, templateFor(wholesale, 'g', false)))).toBe(true);
      expect(
        Option.isNone(yield* build(book, rows, templateFor(groupRef(lower), 'g'), { withoutLegalEntity: true })),
      ).toBe(true);
      const foreignGroup = { ...wholesale, tenantId: '99999999-9999-4999-8999-999999999999' };
      expect(Option.isNone(yield* build(book, rows, templateFor(foreignGroup, 'g')))).toBe(true);
      const foreignProfile = rowsOf(profile(lower, '99999999-9999-4999-8999-999999999999'));
      expect(Option.isNone(yield* build(book, foreignProfile))).toBe(true);
      expect(book.reserved).toEqual([]);
    }),
  );
});

const membershipOperation = {
  entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
};
/** A membership as an internal plan states it, with the order the plan carries. */
const planMembership = (
  effectKey: string,
  resourceId: string,
  options: {
    readonly group?: ReturnType<typeof groupRef>;
    readonly order?: number;
    readonly profileTenant?: string;
  } = {},
) => ({
  effectKey,
  intent: {
    _tag: 'CustomerGroupMembership',
    payload: {
      effectiveAt: '2026-11-20T09:00:00.000Z',
      groupRef: options.group ?? wholesale,
      manager: {
        factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
        issuer: 'route-issuer',
        sourceNamespace: 'route-memberships',
        tenantId,
      },
      operation: 'ASSIGN',
      profile: profile(resourceId, options.profileTenant).profile,
      reason: 'Internal plan membership',
      route: { id: routeId, revision: 'route-1' },
      source: {
        assertionId: `assertion-${effectKey}`,
        effectId: 'ASSIGNED_BY_NATIVE_ADMISSION',
        order: options.order ?? 7,
        sourceRecordId: `record-${effectKey}`,
      },
    },
  },
  operation: membershipOperation,
});
/** An owner effect that is not a membership: the ledger never touches it. */
const priceAssignment = {
  effectKey: 'price-group-assignment',
  intent: {
    _tag: 'AssignCustomerPriceGroup',
    authorizationSubject: { kind: 'RETAIL' },
    payload: {
      effectiveFrom: '2026-11-20T00:00:00.000Z',
      expectedProfileRevision: 1,
      priceGroupRef: {
        moduleId: 'pricing.price-group-catalog',
        resourceId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'pricing.price-group-catalog.price-group',
        tenantId,
      },
      profile: { ...profile(lower).profile.profileRef, kind: 'RETAIL' },
      reason: 'Explicit internal assignment',
      source: {
        effectId: 'ASSIGNED_BY_NATIVE_ADMISSION',
        issuer: 'route-issuer',
        mappingRevision: 'mapping-1',
        namespace: 'route-customers',
        occurrenceId: 'occurrence-0',
        order: 7,
        recordId: 'customer-1',
        recordType: 'CUSTOMER',
        revision: 'source-1',
        route: { id: routeId, revision: 'route-1' },
      },
    },
  },
  operation: {
    entrypointKey: 'commerce.customer-context.assign-customer-price-group',
    moduleId: 'commerce.customer-context',
    schemaVersion: '1',
  },
};
/** An internal plan: one item per list of effects. */
const planOf = (...items: readonly (readonly unknown[])[]) =>
  Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    items: items.map((effects, index) => ({
      effects,
      itemKey: `item-${index}`,
      source: {
        entityKind: 'CUSTOMER',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-customers',
        sourceRecordId: `customer-${index}`,
      },
      sourceOccurrenceId: `occurrence-${index}`,
    })),
  });
const orderPlan = (book: Ledger, plan: SymmyFixtureExecutionPlan, withoutLegalEntity = false) =>
  orderSymmyPlanMemberships({
    legalEntityId: withoutLegalEntity ? noLegalEntity : legalEntityId,
    plan,
    reserve: book.reserve,
    tenantId,
  });

describe('Symmy membership order of an internal plan', () => {
  it.effect('replaces the order the plan carries with the next order of the lineage the public customers share', () =>
    Effect.gen(function* replacesPlanOrder() {
      const book = ledger();
      const publicPlan = Option.getOrThrow(yield* build(book, rowsOf(profile(lower))));
      expect(assignmentOf(publicPlan, 0).source.order).toBe(1);
      // The plan names the same profile in another spelling and claims order 7; the ledger gives it order 2.
      const ordered = yield* orderPlan(
        book,
        planOf([priceAssignment, planMembership('membership', lower.toUpperCase(), { group: retail })]),
      );
      expect(Option.getOrThrow(ordered)).toEqual(
        planOf([priceAssignment, planMembership('membership', lower.toUpperCase(), { group: retail, order: 2 })]),
      );
      expect(book.reserved).toEqual([
        { issuer: 'route-issuer', namespace: 'route-memberships', profileId: lower },
        { issuer: 'route-issuer', namespace: 'route-memberships', profileId: lower },
      ]);
    }),
  );

  it.effect('reserves each lineage once in canonical order and orders its memberships as the plan states them', () =>
    Effect.gen(function* consecutiveLineageOrders() {
      const book = ledger();
      const later = 'ffffffff-6666-4666-8666-666666666666';
      const ordered = yield* orderPlan(
        book,
        planOf(
          [planMembership('later', later, { order: 1 })],
          [planMembership('first', lower, { order: 1 }), planMembership('second', lower, { group: retail, order: 1 })],
        ),
      );
      expect(Option.getOrThrow(ordered)).toEqual(
        planOf(
          [planMembership('later', later, { order: 1 })],
          [planMembership('first', lower, { order: 1 }), planMembership('second', lower, { group: retail, order: 2 })],
        ),
      );
      expect(book.reserved.map(({ profileId }) => profileId)).toEqual([lower, later]);
    }),
  );

  it.effect('returns a plan without a membership as it is and reserves nothing', () =>
    Effect.gen(function* noMembership() {
      const book = ledger();
      const plan = planOf([priceAssignment]);
      expect(Option.getOrThrow(yield* orderPlan(book, plan))).toBe(plan);
      expect(Option.getOrThrow(yield* orderPlan(book, plan, true))).toBe(plan);
      expect(book.reserved).toEqual([]);
    }),
  );

  it.effect('refuses a membership without a lineage of the route and reserves nothing', () =>
    Effect.gen(function* refusesUnorderable() {
      const book = ledger();
      const foreignTenant = '99999999-9999-4999-8999-999999999999';
      for (const plan of [
        planOf([planMembership('foreign', lower, { profileTenant: foreignTenant })]),
        planOf([planMembership('valid', lower), planMembership('not-a-uuid', 'customer-1')]),
      ]) {
        expect(Option.isNone(yield* orderPlan(book, plan))).toBe(true);
      }
      expect(Option.isNone(yield* orderPlan(book, planOf([planMembership('valid', lower)]), true))).toBe(true);
      expect(book.reserved).toEqual([]);
    }),
  );
});
