import {
  readSymmyGroupMembershipFacts,
  SymmyMembershipSourceUnavailable,
} from '../../shared/readers/symmy-membership-customer-facts.ts';
import { symmyCustomerRecordProven, symmyCustomerSourceRecordId } from '@app/shared-contracts/symmy';
import { CustomerProfileSourceResponseSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import { createHash } from 'node:crypto';

import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import { ConfigProvider, DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyCustomerRowsSchema, symmyCustomerRecordSeed } from '../../shared/domain/symmy-customer-batch.ts';
import { buildSymmyCustomerPlan } from '../../src/persistence/symmy-customer-plan.ts';
import {
  SymmyGroupCustomerRowsSchema,
  SymmyGroupMembershipCustomerFactSchema,
  SymmyMembershipCustomerAuthoritySchema,
} from '../../shared/domain/symmy-customer-group-batch.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { buildSymmyGroupMembershipPlan } from '../../src/persistence/symmy-customer-group-membership-plan.ts';
import type {
  SymmyGroupMembershipCustomerSource,
  SymmyGroupMembershipLineage,
  SymmyGroupMembershipOrder,
  SymmyGroupMembershipPlanInput,
} from '../../src/persistence/symmy-customer-group-membership-plan.ts';
import { resolveSymmyMembershipCustomerProfiles } from '../../src/persistence/symmy-job-store.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const routeId = '33333333-3333-4333-8333-333333333333';
/** The Symmy route a request is admitted on; its source route is `routeId`. */
const admittedRouteId = '77777777-7777-4777-8777-777777777777';
const customerAuthority = {
  issuer: 'route-issuer',
  mappingRevision: 'customer-mapping-1',
  namespace: 'route-customers',
  recordType: 'CUSTOMER',
  route: { id: '88888888-8888-4888-8888-888888888888', revision: 'customers-1' },
};
/** The namespace the route enrolls its membership source in: one reserved for ERP memberships. */
const membershipNamespace = 'erp-membership-v1:route-memberships';
const authority = { mappingRevision: 'mapping-1', routeId, routeRevision: 'route-1' };
const groupRef = (resourceId: string) => ({
  moduleId: 'commerce.customer-context',
  resourceId,
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
});
const wholesale = groupRef('44444444-4444-4444-8444-444444444444');
const retail = groupRef('55555555-5555-4555-8555-555555555555');
const templateFor = (
  target: ReturnType<typeof groupRef>,
  groupRecordId: string,
  enrolled = true,
  sourceNamespace = membershipNamespace,
) =>
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
          sourceNamespace,
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
    profileKind: 'RETAIL' as const,
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: profileTenant,
    },
  },
});
const rowsOf = (...customerIds: readonly string[]) =>
  Schema.decodeUnknownSync(SymmyGroupCustomerRowsSchema)(customerIds.map((customerId) => ({ customerId })));
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
/** A route without a selling legal entity. */
const noLegalEntity = Option.getOrUndefined(Option.none<string>());
const lower = 'abcdef00-6666-4666-8666-666666666666';
const later = 'ffffffff-6666-4666-8666-666666666666';

/**
 * The admission's lineage ledger and the source's receipts: the next order of a lineage, one more than the last one
 * reserved for it, and the profile Symmy created for each customer the source sent.
 */
const firstCustomerSent = { 'customer-1': lower };
const ledger = (sent: Readonly<Record<string, string>> = firstCustomerSent) => {
  const reserved: SymmyGroupMembershipLineage[] = [];
  const resolved: { readonly recordIds: readonly string[]; readonly source: SymmyGroupMembershipCustomerSource }[] = [];
  const last = new Map<string, number>();
  const reserve = (lineage: SymmyGroupMembershipLineage) =>
    Effect.sync((): SymmyGroupMembershipOrder => {
      reserved.push(lineage);
      const key = JSON.stringify([lineage.issuer, lineage.namespace, lineage.profileId]);
      const order = (last.get(key) ?? 0) + 1;
      last.set(key, order);
      return { effectiveAt: DateTime.makeUnsafe(`2026-11-20T10:00:0${order}.000Z`), order };
    });
  const resolveProfiles = (source: SymmyGroupMembershipCustomerSource, recordIds: readonly string[]) =>
    Effect.sync(() => {
      resolved.push({ recordIds, source });
      const profiles = new Map(
        recordIds.flatMap((recordId) => {
          const resourceId = sent[recordId];
          return resourceId === undefined
            ? []
            : [
                [
                  recordId,
                  Schema.decodeUnknownSync(SymmyGroupMembershipCustomerFactSchema)({
                    customerSource: {
                      effectId: 'owner-profile',
                      issuer: 'route-issuer',
                      mappingRevision: 'customers-mapping-1',
                      namespace: 'route-customers',
                      occurrenceId: 'customer-occurrence',
                      order: 1,
                      recordId,
                      recordType: 'CUSTOMER',
                      revision: 'customer-1',
                      route: { id: '88888888-8888-4888-8888-888888888888', revision: 'customers-route-1' },
                    },
                    processingKind: 'PERSONAL',
                    profile: profile(resourceId).profile,
                  }),
                ] as const,
              ];
        }),
      );
      return profiles;
    });
  return { reserve, reserved, resolved, resolveProfiles };
};
type Ledger = ReturnType<typeof ledger>;
const build = <ResolveFailure>(
  book: {
    readonly reserve: Ledger['reserve'];
    readonly resolveProfiles: SymmyGroupMembershipPlanInput<never, ResolveFailure, never>['resolveProfiles'];
  },
  rows: ReturnType<typeof rowsOf>,
  template: SymmyFixtureExecutionPlan = templateFor(wholesale, 'symmy-wholesale'),
  options: {
    readonly admittedRoute?: string;
    readonly idempotencyKey?: string;
    readonly withoutLegalEntity?: boolean;
  } = {},
) =>
  buildSymmyGroupMembershipPlan({
    admittedRouteId: options.admittedRoute ?? admittedRouteId,
    authority,
    digest,
    idempotencyKey: options.idempotencyKey ?? 'members-key-1',
    legalEntityId: options.withoutLegalEntity === true ? noLegalEntity : legalEntityId,
    reserve: book.reserve,
    resolveProfiles: book.resolveProfiles,
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
/** The source record the customers plan derives for a customer id the owners cannot take as it is. */
const derived = (customerId: string) =>
  `symmy-customer:${createHash('sha256').update(symmyCustomerRecordSeed(customerId)).digest('hex')}`;
const many = (count: number) => Array.from({ length: count }, (_, index) => ({ customerId: `customer-${index}` }));
/** The assertion the first membership of a plan states. */
const assertion = (plan: Option.Option<SymmyFixtureExecutionPlan>) =>
  assignmentOf(Option.getOrThrow(plan), 0).source.assertionId;

describe('Symmy group membership plan from the public customers', () => {
  it.effect('resolves each customer id to the profile its source created and assigns it under its reserved order', () =>
    Effect.gen(function* assignsSelectedGroup() {
      const book = ledger();
      const plan = Option.getOrThrow(yield* build(book, rowsOf('customer-1')));
      // The customers are looked up under the source the route enrolls the membership write for.
      expect(book.resolved).toEqual([
        { recordIds: ['customer-1'], source: { issuerId: 'route-issuer', sourceNamespace: membershipNamespace } },
      ]);
      const [item] = plan.items;
      expect(item?.itemKey).toBe('membership-0');
      expect(item?.effects[0]?.originalTarget).toEqual(profile(lower).profile.profileRef);
      expect(item?.source).toMatchObject({
        entityKind: 'CUSTOMER_GROUP_MEMBERSHIP',
        issuerId: 'route-issuer',
        sourceNamespace: membershipNamespace,
      });
      expect(assignmentOf(plan, 0)).toMatchObject({
        customerSource: {
          namespace: 'route-customers',
          recordId: 'customer-1',
          route: { id: '88888888-8888-4888-8888-888888888888', revision: 'customers-route-1' },
        },
      });
      const assignment = assignmentOf(plan, 0);
      expect(assignment).toMatchObject({
        effectiveAt: '2026-11-20T10:00:01.000Z',
        groupRef: wholesale,
        manager: {
          factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuer: 'route-issuer',
          sourceNamespace: membershipNamespace,
          tenantId,
        },
        operation: 'ASSIGN',
        profile: profile(lower).profile,
        route: { id: routeId, revision: 'route-1' },
        source: { effectId: 'SYMMY_ASSIGNED_AT_ADMISSION', order: 1, sourceRecordId: item?.source.sourceRecordId },
      });
      expect(assignment.source.assertionId).toBe(item?.sourceOccurrenceId);
      expect(book.reserved).toEqual([{ issuer: 'route-issuer', namespace: membershipNamespace, profileId: lower }]);
    }),
  );

  it.effect('refuses a customer the source has not sent yet for its item alone, and the other customers run', () =>
    Effect.gen(function* refusesUnknownCustomer() {
      const book = ledger();
      const plan = Option.getOrThrow(yield* build(book, rowsOf('customer-unknown', 'customer-1')));
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual(['membership-0', 'membership-1']);
      const [unknown, known] = plan.items;
      // No owner effect, nothing reserved: the item's outcome is its branch, unsupported as missing context.
      expect(unknown?.effects).toEqual([]);
      expect(unknown?.unsupportedBranches).toEqual([{ branchKey: 'customer', kind: 'CustomerHint' }]);
      expect(unknown?.sourceOccurrenceId).toBeDefined();
      // The refused item names its own derived membership record, never the customer's record or its route.
      for (const item of [unknown, known]) {
        expect(item?.source).toMatchObject({
          entityKind: 'CUSTOMER_GROUP_MEMBERSHIP',
          sourceNamespace: membershipNamespace,
        });
        expect(item?.source.sourceRecordId).toMatch(/^symmy-membership:[0-9a-f]{64}$/u);
      }
      expect(JSON.stringify(unknown)).not.toContain('customer-unknown');
      expect(known?.unsupportedBranches).toBeUndefined();
      expect(assignmentOf(plan, 1)).toMatchObject({ profile: profile(lower).profile, source: { order: 1 } });
      expect(book.reserved.map(({ profileId }) => profileId)).toEqual([lower]);
      // A request of unknown customers only is still admitted: every item is its own refusal.
      const none = Option.getOrThrow(
        yield* build(book, rowsOf('customer-unknown'), undefined, { idempotencyKey: 'k2' }),
      );
      expect(none.items.flatMap(({ effects }) => effects)).toEqual([]);
      expect(book.reserved).toHaveLength(1);
    }),
  );

  it.effect('names a customer by the same source record the customers plan derives from its customer id', () =>
    Effect.gen(function* sharesCustomerRecord() {
      const book = ledger();
      const literalInDerivedForm = `symmy-customer:${'a'.repeat(64)}`;
      const ids = ['customer-1', 'x'.repeat(200), 'ž'.repeat(201), ' padded ', 'e\u0301', 'é', literalInDerivedForm];
      const template = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
        items: [
          {
            effects: [
              {
                effectKey: 'party',
                operation: {
                  entrypointKey: 'party.registry.create-party',
                  moduleId: 'party.registry',
                  schemaVersion: '1',
                },
              },
              {
                effectKey: 'profile',
                operation: {
                  entrypointKey: 'commerce.customer-context.ensure-retail-customer-profile',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
              },
            ],
            itemKey: 'customer',
            source: {
              entityKind: 'CUSTOMER',
              issuerId: customerAuthority.issuer,
              sourceNamespace: customerAuthority.namespace,
              sourceRecordId: 'enrollment',
            },
          },
        ],
        sourceRouteId: customerAuthority.route.id,
      });
      const customers = Option.getOrThrow(
        yield* buildSymmyCustomerPlan({
          authority,
          digest,
          idempotencyKey: 'customer-protocol',
          legalEntityId,
          receivedAt: DateTime.makeUnsafe('2026-11-20T10:00:00.000Z'),
          rows: Schema.decodeUnknownSync(SymmyCustomerRowsSchema)(
            ids.map((customerId) => ({
              addresses: [],
              contacts: [],
              customerId,
              firstName: 'Ada',
              kind: 'PERSON',
              lastName: 'Lovelace',
              officialIdentifiers: [],
            })),
          ),
          template,
          tenantId,
        }),
      );
      const memberships = Option.getOrThrow(yield* build(book, rowsOf(...ids)));
      const producedIds = customers.items.map(({ source }) => source.sourceRecordId);
      expect(book.resolved[0]?.recordIds).toEqual(producedIds);
      expect(memberships.items).toHaveLength(ids.length);
      expect(producedIds).toEqual([
        'customer-1',
        'x'.repeat(200),
        derived('ž'.repeat(201)),
        derived(' padded '),
        'e\u0301',
        'é',
        literalInDerivedForm,
      ]);
      // A previous literal and a padded input can name the same old record. Only the source can say which it owns.
      const literal = derived(' padded ');
      const origin = { ...customerAuthority, tenantId };
      const proof = (customerId: string) => symmyCustomerRecordProven(origin, customerId, literal, digest);
      const configured = ConfigProvider.fromUnknown({
        ONTOS_SYMMY_CUSTOMER_RECORD_PROVENANCE: JSON.stringify([
          { ...origin, recordId: literal, wireDigest: derived(literal).slice('symmy-customer:'.length) },
        ]),
      });
      expect(yield* symmyCustomerSourceRecordId(literal, digest)).toBe(literal);
      expect(yield* proof(literal)).toBe(false);
      expect(yield* proof(literal).pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured))).toBe(true);
      expect(yield* proof(' padded ').pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured))).toBe(
        false,
      );
    }),
  );

  it.effect('gives one customer distinct orders when two admissions assign it to two groups, in admission order', () =>
    Effect.gen(function* twoGroupsOneLineage() {
      const book = ledger();
      const first = Option.getOrThrow(yield* build(book, rowsOf('customer-1')));
      const second = Option.getOrThrow(
        yield* build(book, rowsOf('customer-1'), templateFor(retail, 'symmy-retail'), {
          idempotencyKey: 'members-key-2',
        }),
      );
      expect(assignmentOf(first, 0)).toMatchObject({ groupRef: wholesale, source: { order: 1 } });
      expect(assignmentOf(second, 0)).toMatchObject({ groupRef: retail, source: { order: 2 } });
      expect(assignmentOf(second, 0).effectiveAt >= assignmentOf(first, 0).effectiveAt).toBe(true);
      expect(first.items[0]?.source.sourceRecordId).not.toBe(second.items[0]?.source.sourceRecordId);
    }),
  );

  it.effect('reserves the lineages of one request in canonical order and keeps the items in request order', () =>
    Effect.gen(function* canonicalReservationOrder() {
      const book = ledger({ 'customer-1': lower, 'customer-2': later });
      const plan = Option.getOrThrow(yield* build(book, rowsOf('customer-2', 'customer-1')));
      expect(book.reserved.map(({ profileId }) => profileId)).toEqual([lower, later]);
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual(['membership-0', 'membership-1']);
      expect(assignmentOf(plan, 0).profile.profileRef.resourceId).toBe(later);
      expect(assignmentOf(plan, 1).profile.profileRef.resourceId).toBe(lower);
    }),
  );

  it.effect('replays one key into the same assertions and records, and names new ones per route and group', () =>
    Effect.gen(function* distinctAssertions() {
      const book = ledger();
      const rows = rowsOf('customer-1');
      const once = Option.getOrThrow(yield* build(book, rows));
      const again = Option.getOrThrow(yield* build(book, rows));
      expect(again.items.map(({ source, sourceOccurrenceId }) => ({ source, sourceOccurrenceId }))).toEqual(
        once.items.map(({ source, sourceOccurrenceId }) => ({ source, sourceOccurrenceId })),
      );
      const first = assertion(Option.some(once));
      const otherRoute = assertion(
        yield* build(book, rows, templateFor(wholesale, 'symmy-wholesale'), {
          admittedRoute: '88888888-8888-4888-8888-888888888888',
        }),
      );
      const otherGroup = assertion(yield* build(book, rows, templateFor(retail, 'symmy-retail')));
      expect(new Set([first, otherRoute, otherGroup]).size).toBe(3);
    }),
  );

  it('refuses a request that names one customer twice, none or more than sixteen', () => {
    const accepts = Schema.is(SymmyGroupCustomerRowsSchema);
    expect(accepts(many(16))).toBe(true);
    expect(accepts(many(17))).toBe(false);
    expect(accepts([])).toBe(false);
    expect(accepts([{ customerId: 'customer-1' }, { customerId: 'customer-1' }])).toBe(false);
  });

  it.effect('plans nothing and reserves nothing without a selected group, a ledger source or a legal entity', () =>
    Effect.gen(function* refusesUnroutable() {
      const book = ledger();
      const rows = rowsOf('customer-1');
      expect(Option.isNone(yield* build(book, rows, templateFor(wholesale, 'g', false)))).toBe(true);
      // A membership source outside the namespaces reserved for ERP memberships is ordered by its callers, not here.
      expect(Option.isNone(yield* build(book, rows, templateFor(wholesale, 'g', true, 'route-memberships')))).toBe(
        true,
      );
      expect(Option.isNone(yield* build(book, rows, undefined, { withoutLegalEntity: true }))).toBe(true);
      const foreignGroup = { ...wholesale, tenantId: '99999999-9999-4999-8999-999999999999' };
      expect(Option.isNone(yield* build(book, rows, templateFor(foreignGroup, 'g')))).toBe(true);
      const { selector: _unselected, ...withoutSelector } = templateFor(wholesale, 'g');
      expect(Option.isNone(yield* build(book, rows, withoutSelector))).toBe(true);
      expect(book.resolved).toEqual([]);
      expect(book.reserved).toEqual([]);
    }),
  );
});

const currentCustomer = (recordId: string, icoAuthority: 'ORGANIZATION' | 'PERSONAL' = 'PERSONAL') =>
  Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema.members[1])({
    _tag: 'CURRENT',
    item: {
      icoAuthority,
      partyRef: { moduleId: 'party.registry', resourceId: lower, resourceType: 'party.registry.party', tenantId },
      partySourceReference: {
        occurrenceId: 'party-occurrence',
        recordId,
        source: {
          issuer: customerAuthority.issuer,
          namespace: 'party-customers',
          recordType: 'CUSTOMER',
          routeRef: customerAuthority.route.id,
        },
      },
      profile: {
        profileRef: {
          kind: 'COUNTERPARTY',
          moduleId: 'commerce.customer-context',
          resourceId: lower,
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId,
        },
        revision: 1,
        state: 'ACTIVE',
        subject: {
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: later,
            resourceType: 'party.registry.counterparty',
            tenantId,
          },
          kind: 'COUNTERPARTY',
        },
      },
      source: {
        ...customerAuthority,
        effectId: 'current-profile-effect',
        occurrenceId: 'current-customer-occurrence',
        order: 2,
        recordId,
        revision: 'customer-revision-2',
      },
    },
  });

describe('Current customer membership authority independent of delivery history', () => {
  it.effect('keeps unknown-only batches as per-item missing context with no orders', () =>
    Effect.gen(function* unknownOnly() {
      const facts = yield* readSymmyGroupMembershipFacts({
        authority: customerAuthority,
        read: () => Effect.succeed({ _tag: 'ABSENT' }),
        recordIds: ['missing'],
        tenantId,
      });
      const book = ledger({});
      expect(facts).toEqual({ authority: customerAuthority, profiles: [] });
      const planned = Option.getOrThrow(
        yield* build(
          {
            ...book,
            resolveProfiles: (_source, recordIds) =>
              resolveSymmyMembershipCustomerProfiles({
                enrolled: facts.authority,
                recordIds,
                resolution: facts,
                tenantId,
              }),
          },
          rowsOf('missing'),
        ),
      );
      expect(planned.items[0]).toMatchObject({ effects: [], unsupportedBranches: [{ kind: 'CustomerHint' }] });
      expect(JSON.stringify(planned.items[0])).not.toContain(customerAuthority.namespace);
      expect(book.reserved).toEqual([]);
    }),
  );
  for (const changed of [
    { route: { ...customerAuthority.route, id: admittedRouteId } },
    { route: { ...customerAuthority.route, revision: 'customers-2' } },
    { mappingRevision: 'customer-mapping-2' },
    { namespace: 'reenrolled-customers' },
    { issuer: 'reenrolled-issuer' },
    { recordType: 'PERSON' },
  ]) {
    it.effect(`rejects queried A ABSENT after enrollment changes to ${JSON.stringify(changed)}`, () =>
      Effect.gen(function* changedAfterAbsence() {
        const queried = yield* readSymmyGroupMembershipFacts({
          authority: customerAuthority,
          read: () => Effect.succeed({ _tag: 'ABSENT' }),
          recordIds: ['missing'],
          tenantId,
        });
        // Shell read A first. The owner then locks B, before planning or native capture.
        const enrolled = yield* Schema.decodeUnknownEffect(SymmyMembershipCustomerAuthoritySchema)({
          ...customerAuthority,
          ...changed,
        });
        const book = ledger({});
        const denied = yield* build(
          {
            ...book,
            resolveProfiles: (_source, recordIds) =>
              resolveSymmyMembershipCustomerProfiles({ enrolled, recordIds, resolution: queried, tenantId }),
          },
          rowsOf('missing'),
        ).pipe(Effect.flip);
        expect(denied).toMatchObject({ code: 'route_denied' });
        expect(book.reserved).toEqual([]);
        expect(queried).toEqual({ authority: customerAuthority, profiles: [] });
      }),
    );
  }
  for (const kind of ['ORGANIZATION', 'PERSONAL'] as const) {
    it.effect(`uses authoritative ${kind} evidence for a mixed batch after history purge`, () =>
      Effect.gen(function* currentMixed() {
        const facts = yield* readSymmyGroupMembershipFacts({
          authority: customerAuthority,
          recordIds: ['customer-1', 'missing'],
          tenantId,
          // The reader has no Symmy history dependency at all.
          read: (request) =>
            Effect.succeed(
              request.recordId === 'missing' ? { _tag: 'ABSENT' } : currentCustomer(request.recordId, kind),
            ),
        });
        const book = ledger({});
        const planned = Option.getOrThrow(
          yield* build(
            {
              ...book,
              resolveProfiles: (_source, recordIds) =>
                resolveSymmyMembershipCustomerProfiles({
                  enrolled: facts.authority,
                  recordIds,
                  resolution: facts,
                  tenantId,
                }),
            },
            rowsOf('customer-1', 'missing'),
          ),
        );
        expect(planned.items[1]?.effects).toEqual([]);
        const intent = planned.items[0]?.effects[0]?.intent;
        expect(intent).toMatchObject({ payload: { customerSource: { ...customerAuthority, recordId: 'customer-1' } } });
        const membership = Schema.decodeUnknownSync(
          Schema.Struct({
            _tag: Schema.Literal('CustomerGroupMembership'),
            payload: ApplyCustomerGroupMembershipSourcePayloadSchema,
          }),
        )(intent);
        expect(membership.payload.profile.profileKind).toBe('COUNTERPARTY');
        if (kind === 'ORGANIZATION') {
          expect(membership.payload).toMatchObject({
            processingKind: 'ORG_BUSINESS_REFERENCE',
            reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED',
          });
          expect('reason' in membership.payload).toBe(false);
        } else {
          expect(membership.payload.reason).toBeDefined();
          expect(membership.payload.processingKind).not.toBe('ORG_BUSINESS_REFERENCE');
        }
        expect(book.reserved).toHaveLength(1);
      }),
    );
  }
  it.effect('keeps a customer Privacy itself refuses apart from one the owner names no profile for', () =>
    Effect.gen(function* refusedCustomer() {
      const refused = yield* readSymmyGroupMembershipFacts({
        authority: customerAuthority,
        read: (request) =>
          Effect.succeed(request.recordId === 'refused' ? { _tag: 'REFUSED' } : currentCustomer(request.recordId)),
        recordIds: ['customer-1', 'refused'],
        tenantId,
      }).pipe(Effect.flip);
      // Neither an unknown customer nor unavailable evidence: the owner's own answer about this customer.
      expect(Schema.is(Schema.TaggedStruct('SymmyMembershipCustomerRefused', {}))(refused)).toBe(true);
    }),
  );
  it.effect('does not turn owner unavailability into unknown membership context', () =>
    Effect.gen(function* ownerUnavailable() {
      const failure = new Error('owner unavailable');
      const result = yield* readSymmyGroupMembershipFacts({
        authority: customerAuthority,
        read: () => Effect.fail(failure),
        recordIds: ['customer-1'],
        tenantId,
      }).pipe(Effect.flip);
      expect(result).toBe(failure);
    }),
  );
  for (const changed of [
    { issuer: 'crossed-issuer' },
    { namespace: 'crossed-namespace' },
    { recordId: 'another-customer' },
    { recordType: 'OTHER' },
    { mappingRevision: 'other-mapping' },
    { route: { ...customerAuthority.route, id: routeId } },
    { route: { ...customerAuthority.route, revision: 'other-revision' } },
  ]) {
    it.effect(`rejects same-tenant crossed source ${JSON.stringify(changed)}`, () =>
      Effect.gen(function* crossedSource() {
        const current = currentCustomer('customer-1');
        const result = yield* readSymmyGroupMembershipFacts({
          authority: customerAuthority,
          read: () =>
            Effect.succeed({ ...current, item: { ...current.item, source: { ...current.item.source, ...changed } } }),
          recordIds: ['customer-1'],
          tenantId,
        }).pipe(Effect.flip);
        expect(Schema.is(SymmyMembershipSourceUnavailable)(result)).toBe(true);
      }),
    );
  }
});
