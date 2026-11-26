import { DateTime, Effect, Match, Option, Order, Schema } from 'effect';

import { SYMMY_EFFECT_ASSIGNED_AT_ADMISSION } from '../../shared/domain/symmy-customer-batch.ts';
import {
  SYMMY_GROUP_MEMBERSHIP_REASON,
  symmyGroupMembershipOccurrenceSeed,
  symmyGroupMembershipRecordSeed,
} from '../../shared/domain/symmy-customer-group-batch.ts';
import type {
  SymmyGroupCustomerRows,
  SymmyGroupMembershipProfile,
} from '../../shared/domain/symmy-customer-group-batch.ts';
import type { SymmyPartyCommerceOwnerReceipt } from '../../shared/domain/symmy-party-commerce-intents.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { uuidFromDigest } from './derived-identity.ts';
import { symmyCustomerSourceRecordId } from './symmy-customer-plan.ts';
import type { SymmyCustomerSourceAuthority } from './symmy-customer-plan.ts';
import type { Digest } from './symmy-price-list-plan.ts';

const applyOperation = {
  entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
} as const;

type PlanItem = SymmyFixtureExecutionPlan['items'][number];
type PlanEffect = PlanItem['effects'][number];
type TemplateSource = PlanItem['source'];

/** Whether an effect is the owner's membership write, the one operation the membership adapter executes. */
const isMembershipWrite = ({ operation }: Pick<PlanEffect, 'operation'>) =>
  operation.moduleId === applyOperation.moduleId &&
  operation.entrypointKey === applyOperation.entrypointKey &&
  operation.schemaVersion === applyOperation.schemaVersion;

/** The owner stores a profile as a UUID, so two spellings of one profile are one lineage. */
const canonicalProfileId = (resourceId: string): string => resourceId.toLowerCase();

/**
 * One lineage of the owner's membership order: every membership of one canonical profile managed by one source
 * issuer and namespace, whichever group it names. The owner refuses an older order of a lineage, so each lineage
 * needs its own increasing order.
 */
export interface SymmyGroupMembershipLineage {
  readonly issuer: string;
  readonly namespace: string;
  readonly profileId: string;
}

/** The order reserved for one lineage and the effective instant that goes with it. */
export interface SymmyGroupMembershipOrder {
  readonly effectiveAt: DateTime.Utc;
  readonly order: number;
}

/**
 * The one order in which every admission reserves its lineages: by canonical profile, then issuer, then namespace.
 * Two admissions that share lineages take their locks in the same order, so they never deadlock.
 */
const lineageOrder: Order.Order<SymmyGroupMembershipLineage> = Order.combine(
  Order.mapInput(Order.String, ({ profileId }: SymmyGroupMembershipLineage) => profileId),
  Order.combine(
    Order.mapInput(Order.String, ({ issuer }: SymmyGroupMembershipLineage) => issuer),
    Order.mapInput(Order.String, ({ namespace }: SymmyGroupMembershipLineage) => namespace),
  ),
);

/** The source whose customers a membership names: the issuer and namespace the route enrolls the membership write for. */
export interface SymmyGroupMembershipCustomerSource {
  readonly issuerId: string;
  readonly sourceNamespace: string;
}

export interface SymmyGroupMembershipCustomer {
  readonly processingKind: 'PERSONAL_DATA' | 'ORG_BUSINESS_REFERENCE';
  readonly profile: SymmyGroupMembershipProfile;
}

export interface SymmyGroupMembershipPlanInput<Failure, ResolveFailure, ReserveFailure> {
  /** The Symmy route the request was admitted on. One key sent to two group routes names two assertions. */
  readonly admittedRouteId: string;
  /** The authority of the source route: the route identity and revision every assertion cites. */
  readonly authority: SymmyCustomerSourceAuthority;
  /** A stable hex digest. Replays of one Idempotency-Key must reproduce every derived identity. */
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  /** The legal entity of the membership owner. It comes from the route scope, never from the body. */
  readonly legalEntityId: string | undefined;
  /**
   * Chooses the next order from retained membership plans inside the admission transaction. It is called once per resolved
   * customer, in canonical lineage order, and only on the first admission: a replay reads the saved plan instead.
   */
  readonly reserve: (lineage: SymmyGroupMembershipLineage) => Effect.Effect<SymmyGroupMembershipOrder, ReserveFailure>;
  /**
   * The customer profile Symmy created for each source record of this source, read inside the admission
   * transaction from its own accepted owner receipts. A record the source never sent, or one whose receipts
   * name more than one profile, has no entry.
   */
  readonly resolveProfiles: (
    source: SymmyGroupMembershipCustomerSource,
    recordIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, SymmyGroupMembershipCustomer>, ResolveFailure>;
  readonly rows: SymmyGroupCustomerRows;
  readonly template: SymmyFixtureExecutionPlan;
  readonly tenantId: string;
}

interface PlannedCustomer {
  readonly index: number;
  readonly itemKey: string;
  readonly occurrenceId: string;
  readonly profile: Option.Option<SymmyGroupMembershipCustomer>;
  readonly recordId: string;
}

/** More than one canonical profile for a record is ambiguous, never a guessed customer. */
export const symmyMembershipProfilesFromReceipts = (
  receipts: readonly {
    readonly organization: boolean;
    readonly receipt: SymmyPartyCommerceOwnerReceipt;
    readonly recordId: string;
  }[],
  tenantId: string,
): ReadonlyMap<string, SymmyGroupMembershipCustomer> => {
  const candidates = new Map<string, Map<string, SymmyGroupMembershipCustomer>>();
  for (const { organization, receipt, recordId } of receipts) {
    const profile = Match.value(receipt).pipe(
      Match.tags({
        CounterpartyProfileCreated: ({ profileRef }): SymmyGroupMembershipProfile => ({
          profileKind: 'COUNTERPARTY',
          profileRef,
        }),
        RetailProfileEnsured: ({ profileRef }): SymmyGroupMembershipProfile => ({ profileKind: 'RETAIL', profileRef }),
      }),
      Match.orElse(() => null),
    );
    if (profile === null || profile.profileRef.tenantId !== tenantId) {
      continue;
    }
    const known = candidates.get(recordId) ?? new Map<string, SymmyGroupMembershipCustomer>();
    const processingKind =
      organization && profile.profileKind === 'COUNTERPARTY' ? 'ORG_BUSINESS_REFERENCE' : 'PERSONAL_DATA';
    known.set(`${profile.profileKind}:${profile.profileRef.resourceId.toLowerCase()}:${processingKind}`, {
      processingKind,
      profile,
    });
    candidates.set(recordId, known);
  }
  return new Map(
    [...candidates].flatMap(([recordId, profiles]) => {
      const [only] = profiles.values();
      return profiles.size === 1 && only !== undefined ? [[recordId, only] as const] : [];
    }),
  );
};

/**
 * Maps the customers of the selected group to one internal plan: per customer one item. A customer whose source
 * record has a profile gets the source ASSIGN of that profile to the group the route enrollment selects, under the
 * next retained order of its lineage. A customer the source has not sent yet gets an item with no owner effect and a
 * `CustomerHint` branch: it is refused alone, as missing context, and the other customers run. A route that selects
 * no group of the tenant, enrolls no membership write or has no legal entity yields no plan at all, and nothing is
 * reserved.
 */
export const buildSymmyGroupMembershipPlan = Effect.fn('SymmyGroupMembershipPlan.build')(
  function* buildSymmyGroupMembershipPlan<Failure, ResolveFailure, ReserveFailure>(
    input: SymmyGroupMembershipPlanInput<Failure, ResolveFailure, ReserveFailure>,
  ) {
    const { admittedRouteId, authority, digest, idempotencyKey, legalEntityId, reserve, rows, template, tenantId } =
      input;
    const { selector } = template;
    const enrolled = template.items.find(({ effects }) => effects.some(isMembershipWrite));
    if (
      legalEntityId === undefined ||
      enrolled === undefined ||
      selector?.kind !== 'CUSTOMER_GROUP' ||
      selector.target === undefined ||
      selector.target.tenantId !== tenantId ||
      selector.source.route.tenantId !== tenantId
    ) {
      return Option.none<SymmyFixtureExecutionPlan>();
    }
    const source: TemplateSource = enrolled.source;
    const groupRef = selector.target;
    const customerRecords = yield* Effect.forEach(
      rows,
      ({ customerId }) => symmyCustomerSourceRecordId(customerId, digest),
      {
        concurrency: 1,
      },
    );
    const profiles = yield* input.resolveProfiles(
      { issuerId: source.issuerId, sourceNamespace: source.sourceNamespace },
      customerRecords,
    );
    const customers: readonly PlannedCustomer[] = yield* Effect.forEach(
      customerRecords,
      Effect.fn('SymmyGroupMembershipPlan.customer')(function* plannedCustomer(customerRecordId, index) {
        const itemKey = `membership-${index}`;
        const [record, occurrence] = yield* Effect.all(
          [
            digest(symmyGroupMembershipRecordSeed(selector.source.sourceRecordId, customerRecordId)),
            digest(
              symmyGroupMembershipOccurrenceSeed({
                groupId: groupRef.resourceId,
                idempotencyKey,
                itemKey,
                routeId: admittedRouteId,
              }),
            ),
          ],
          { concurrency: 1 },
        );
        return {
          index,
          itemKey,
          occurrenceId: uuidFromDigest(occurrence),
          profile: Option.fromUndefinedOr(profiles.get(customerRecordId)),
          recordId: `symmy-membership:${record}`,
        };
      }),
      { concurrency: 1 },
    );
    const itemSource = (customer: PlannedCustomer) => ({
      entityKind: source.entityKind,
      issuerId: source.issuerId,
      sourceNamespace: source.sourceNamespace,
      sourceRecordId: customer.recordId,
    });
    const membershipItem = (
      customer: PlannedCustomer,
      fact: SymmyGroupMembershipCustomer,
      order: SymmyGroupMembershipOrder,
    ) => ({
      effects: [
        {
          effectKey: 'customer-group-assignment',
          intent: {
            _tag: 'CustomerGroupMembership',
            payload: {
              effectiveAt: DateTime.formatIso(order.effectiveAt),
              groupRef,
              manager: {
                factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
                issuer: source.issuerId,
                sourceNamespace: source.sourceNamespace,
                tenantId,
              },
              operation: 'ASSIGN',
              profile: fact.profile,
              ...(fact.processingKind === 'ORG_BUSINESS_REFERENCE'
                ? { processingKind: fact.processingKind, reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED' }
                : { reason: SYMMY_GROUP_MEMBERSHIP_REASON }),
              route: { id: authority.routeId, revision: authority.routeRevision },
              source: {
                assertionId: customer.occurrenceId,
                effectId: SYMMY_EFFECT_ASSIGNED_AT_ADMISSION,
                order: order.order,
                sourceRecordId: customer.recordId,
              },
            },
          },
          operation: applyOperation,
          originalTarget: fact.profile.profileRef,
        },
      ],
      itemKey: customer.itemKey,
      source: itemSource(customer),
      sourceOccurrenceId: customer.occurrenceId,
    });
    // Lineages are reserved in the one canonical order, so two admissions that share lineages never deadlock.
    const resolved = customers
      .flatMap((customer) =>
        Option.match(customer.profile, {
          onNone: () => [],
          onSome: (profile) => [
            {
              customer,
              lineage: {
                issuer: source.issuerId,
                namespace: source.sourceNamespace,
                profileId: canonicalProfileId(profile.profile.profileRef.resourceId),
              },
              profile,
            },
          ],
        }),
      )
      .toSorted((left, right) => lineageOrder(left.lineage, right.lineage));
    const assigned = yield* Effect.forEach(
      resolved,
      ({ customer, lineage, profile }) =>
        reserve(lineage).pipe(
          Effect.map((order) => [customer.index, membershipItem(customer, profile, order)] as const),
        ),
      { concurrency: 1 },
    );
    const assignedItems = new Map<number, ReturnType<typeof membershipItem>>(assigned);
    const items = customers.map(
      (customer) =>
        assignedItems.get(customer.index) ?? {
          effects: [],
          itemKey: customer.itemKey,
          source: itemSource(customer),
          sourceOccurrenceId: customer.occurrenceId,
          unsupportedBranches: [{ branchKey: 'customer', kind: 'CustomerHint' }],
        },
    );
    return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items });
  },
);
