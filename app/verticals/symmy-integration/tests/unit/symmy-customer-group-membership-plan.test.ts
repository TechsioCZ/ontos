import { createHash } from 'node:crypto';
import { SymmyEffectOutcomeSchema } from '@app/shared-contracts/symmy';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { SymmyGroupCustomerRowsSchema } from '../../shared/domain/symmy-customer-group-batch.ts';
import { AdmitSymmyJobPayloadSchema } from '../../shared/domain/symmy-job-admission.ts';
import {
  SymmyFixtureExecutionPlanSchema,
  SymmyPinnedJobPlanSchema,
  projectSymmyUnsupportedBranches,
} from '../../shared/domain/symmy-job-execution.ts';
import {
  SymmyPartyCommerceIntentSchema,
  SymmyPartyCommerceOwnerReceiptSchema,
} from '../../shared/domain/symmy-party-commerce-intents.ts';
import { symmyCustomerSourceRecordId } from '../../src/persistence/symmy-customer-plan.ts';
import {
  buildSymmyGroupMembershipPlan,
  symmyMembershipProfilesFromReceipts,
} from '../../src/persistence/symmy-customer-group-membership-plan.ts';

const membershipIntentSchema = SymmyPartyCommerceIntentSchema.pipe(Schema.toTaggedUnion('_tag')).cases
  .CustomerGroupMembership;

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenant = '99999999-9999-4999-8999-999999999999';
const routeId = '22222222-2222-4222-8222-222222222222';
const legalEntityId = '33333333-3333-4333-8333-333333333333';
const authority = { mappingRevision: 'mapping-1', routeId, routeRevision: 'route-1' };
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
const operation = {
  entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
};
const templateFor = (targetTenant = tenantId, enrolled = true) =>
  Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    items: [
      {
        effects: [{ effectKey: 'enrolled', operation: { ...operation, schemaVersion: enrolled ? '1' : '2' } }],
        itemKey: 'membership',
        source: {
          entityKind: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuerId: 'erp',
          sourceNamespace: 'memberships',
          sourceRecordId: 'enrolled',
        },
      },
    ],
    selector: {
      kind: 'CUSTOMER_GROUP',
      source: {
        entityKind: 'CUSTOMER_GROUP',
        issuerId: 'erp',
        route: { integrationRouteId: routeId, tenantId },
        sourceNamespace: 'groups',
        sourceRecordId: 'wholesale',
      },
      target: {
        moduleId: 'commerce.customer-context',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'commerce.customer-context.customer-group',
        tenantId: targetTenant,
      },
    },
  });
const ref = (resourceType: string, resourceId: string, targetTenant = tenantId) => ({
  moduleId: 'commerce.customer-context',
  resourceId,
  resourceType,
  tenantId: targetTenant,
});
const retailReceipt = (resourceId = '55555555-5555-4555-8555-555555555555', targetTenant = tenantId) =>
  Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
    _tag: 'RetailProfileEnsured',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'party.registry.party',
      tenantId: targetTenant,
    },
    profileRef: ref('commerce.customer-context.retail-customer-profile', resourceId, targetTenant),
  });
const organizationReceipt = Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
  _tag: 'CounterpartyProfileCreated',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  profileRef: ref('commerce.customer-context.counterparty-purchasing-profile', '88888888-8888-4888-8888-888888888888'),
});
const profiles = () =>
  symmyMembershipProfilesFromReceipts(
    [
      { organization: false, receipt: retailReceipt(), recordId: 'person' },
      { organization: true, receipt: organizationReceipt, recordId: 'organization' },
    ],
    tenantId,
  );
const rowsOf = (...ids: string[]) =>
  Schema.decodeUnknownSync(SymmyGroupCustomerRowsSchema)(ids.map((customerId) => ({ customerId })));
const build = (rows = rowsOf('person', 'organization', 'unknown'), template = templateFor(), key = 'request-1') =>
  buildSymmyGroupMembershipPlan({
    admittedRouteId: routeId,
    authority,
    digest,
    idempotencyKey: key,
    legalEntityId,
    reserve: () => Effect.succeed({ effectiveAt: DateTime.makeUnsafe('2026-11-23T00:00:00Z'), order: 1 }),
    resolveProfiles: () => Effect.succeed(profiles()),
    rows,
    template,
    tenantId,
  });

describe('public group customers admission', () => {
  it('accepts bounded distinct customer ids, refusing duplicates and empty batches', () => {
    expect(Schema.is(SymmyGroupCustomerRowsSchema)([{ customerId: 'person' }])).toBe(true);
    expect(Schema.is(SymmyGroupCustomerRowsSchema)([])).toBe(false);
    expect(Schema.is(SymmyGroupCustomerRowsSchema)([{ customerId: 'x' }, { customerId: 'x' }])).toBe(false);
    expect(
      Schema.is(SymmyGroupCustomerRowsSchema)(Array.from({ length: 17 }, (_, i) => ({ customerId: `${i}` }))),
    ).toBe(false);
  });
  it('requires the group route, code and no other source', () => {
    const payload = {
      code: 'wholesale',
      groupCustomers: [{ customerId: 'person' }],
      idempotencyKey: 'request-1',
      routeKey: 'customerGroupCustomersBatch',
    };
    expect(Schema.is(AdmitSymmyJobPayloadSchema)(payload)).toBe(true);
    expect(Schema.is(AdmitSymmyJobPayloadSchema)({ ...payload, routeKey: 'customersBatch' })).toBe(false);
    const { code: _code, ...withoutCode } = payload;
    expect(Schema.is(AdmitSymmyJobPayloadSchema)(withoutCode)).toBe(false);
    expect(Schema.is(AdmitSymmyJobPayloadSchema)({ ...payload, fixtureId: 'fixture' })).toBe(false);
  });
});

describe('source-owned profile receipts', () => {
  it('distinguishes a verified organization from a personal counterparty', () => {
    expect(profiles().get('person')).toMatchObject({
      processingKind: 'PERSONAL_DATA',
      profile: { profileKind: 'RETAIL' },
    });
    expect(profiles().get('organization')).toMatchObject({
      processingKind: 'ORG_BUSINESS_REFERENCE',
      profile: { profileKind: 'COUNTERPARTY' },
    });
    expect(
      symmyMembershipProfilesFromReceipts(
        [{ organization: false, receipt: organizationReceipt, recordId: 'person' }],
        tenantId,
      ).get('person')?.processingKind,
    ).toBe('PERSONAL_DATA');
  });
  it('refuses ambiguity and cross-tenant profiles instead of guessing', () => {
    expect(
      symmyMembershipProfilesFromReceipts(
        [
          { organization: false, receipt: retailReceipt(), recordId: 'person' },
          { organization: false, receipt: retailReceipt('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), recordId: 'person' },
          {
            organization: false,
            receipt: retailReceipt('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', otherTenant),
            recordId: 'foreign',
          },
        ],
        tenantId,
      ).size,
    ).toBe(0);
  });
  it.effect('uses the identical source record normalization as customer import', () =>
    Effect.gen(function* matchesCustomerRecordNormalization() {
      expect(yield* symmyCustomerSourceRecordId('person', digest)).toBe('person');
      const id = 'x'.repeat(201);
      const hashedRecord = createHash('sha256').update(`customer-record\u0000${id}`).digest('hex');
      expect(yield* symmyCustomerSourceRecordId(id, digest)).toBe(`symmy-customer:${hashedRecord}`);
      expect(yield* symmyCustomerSourceRecordId(' padded ', digest)).not.toBe(' padded ');
    }),
  );
});

describe('group membership planner', () => {
  it('projects an unknown customer as missing_context under the existing public outcome contract', () => {
    const plan = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
      items: [
        {
          effects: [],
          itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          itemKey: 'membership-0',
          unsupportedBranches: [
            {
              branchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              branchKey: 'customer',
              kind: 'CustomerHint',
            },
          ],
        },
      ],
    });
    const [outcome] = projectSymmyUnsupportedBranches(plan.items[0]);
    expect(outcome).toMatchObject({
      owner: 'commerce.customer-context',
      reason: 'missing_context',
      status: 'unsupported',
    });
    expect(Schema.is(SymmyEffectOutcomeSchema)(outcome)).toBe(true);
  });
  it.effect('assigns imported people and organizations and refuses only the unknown item', () =>
    Effect.gen(function* assignsKnownCustomers() {
      const result = yield* build();
      expect(Option.isSome(result)).toBe(true);
      const { items } = Option.getOrThrow(result);
      expect(items).toHaveLength(3);
      const [person, organization, missing] = items;
      const personIntent = person?.effects[0]?.intent;
      Schema.asserts(membershipIntentSchema, personIntent);
      expect(personIntent.payload).toMatchObject({
        operation: 'ASSIGN',
        profile: { profileKind: 'RETAIL' },
        reason: expect.any(String),
      });
      const organizationIntent = organization?.effects[0]?.intent;
      Schema.asserts(membershipIntentSchema, organizationIntent);
      expect(organizationIntent.payload).toMatchObject({
        operation: 'ASSIGN',
        processingKind: 'ORG_BUSINESS_REFERENCE',
        reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED',
      });
      expect(missing?.effects).toEqual([]);
      expect(missing?.unsupportedBranches).toEqual([{ branchKey: 'customer', kind: 'CustomerHint' }]);
    }),
  );
  it.effect('represents all-unknown requests without fake owner effects', () =>
    Effect.gen(function* representsUnknownCustomers() {
      const result = yield* build(rowsOf('unknown'));
      expect(Option.isSome(result)).toBe(true);
      expect(Option.getOrThrow(result).items[0].effects).toEqual([]);
    }),
  );
  it.effect('refuses unenrolled operations and foreign selected groups', () =>
    Effect.gen(function* refusesOutOfScopeGroups() {
      expect(Option.isNone(yield* build(rowsOf('person'), templateFor(tenantId, false)))).toBe(true);
      expect(Option.isNone(yield* build(rowsOf('person'), templateFor(otherTenant)))).toBe(true);
    }),
  );
  it.effect('replays derived identities but separates different keys', () =>
    Effect.gen(function* derivesStableReplayIdentities() {
      const first = yield* build();
      expect(yield* build()).toEqual(first);
      expect(yield* build(rowsOf('person', 'organization', 'unknown'), templateFor(), 'request-2')).not.toEqual(first);
    }),
  );
  it('rejects silent items with neither work nor an unsupported outcome', () => {
    expect(
      Schema.is(SymmyFixtureExecutionPlanSchema)({
        items: [{ effects: [], itemKey: 'empty', source: templateFor().items[0].source }],
      }),
    ).toBe(false);
  });
});
