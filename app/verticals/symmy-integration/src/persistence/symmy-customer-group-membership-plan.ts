import { Array as EffectArray, DateTime, Effect, Match, Option, Order, Schema } from 'effect';

import { SYMMY_EFFECT_ASSIGNED_AT_ADMISSION } from '../../shared/domain/symmy-customer-batch.ts';
import {
  SYMMY_GROUP_MEMBERSHIP_REASON,
  canonicalSymmyGroupCustomers,
  canonicalSymmyProfileId,
  symmyGroupMembershipRecordSeed,
} from '../../shared/domain/symmy-customer-group-batch.ts';
import type { SymmyGroupCustomerRows } from '../../shared/domain/symmy-customer-group-batch.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { uuidFromDigest } from './derived-identity.ts';
import type { SymmyCustomerSourceAuthority } from './symmy-customer-plan.ts';
import type { Digest } from './symmy-price-list-plan.ts';

const applyOperation = {
  entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
} as const;

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

const profileId = (row: SymmyGroupCustomerRows[number]) => row.profile.profileRef.resourceId;

export interface SymmyGroupMembershipPlanInput<Failure, ReserveFailure> {
  /** The authority of the source route: the route identity and revision every assertion cites. */
  readonly authority: SymmyCustomerSourceAuthority;
  /** A stable hex digest. Replays of one Idempotency-Key must reproduce every derived identity. */
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  /** The legal entity of the membership owner. It comes from the route scope, never from the body. */
  readonly legalEntityId: string | undefined;
  /**
   * Reserves the next order of one lineage inside the admission transaction. It is called once per row, in
   * canonical profile order, and only on the first admission: a replay reads the saved plan instead.
   */
  readonly reserve: (lineage: SymmyGroupMembershipLineage) => Effect.Effect<SymmyGroupMembershipOrder, ReserveFailure>;
  readonly rows: SymmyGroupCustomerRows;
  readonly template: SymmyFixtureExecutionPlan;
  readonly tenantId: string;
}

/**
 * Maps the customers of the selected group to one internal plan: per customer one item with the source ASSIGN of its
 * canonical profile to the group the route enrollment selects, under the order reserved for its lineage. A route
 * that selects no group of the tenant, enrolls no membership source or has no legal entity yields no plan at all,
 * and so does a profile of another tenant: nothing is admitted and no order is reserved.
 */
export const buildSymmyGroupMembershipPlan = Effect.fn('SymmyGroupMembershipPlan.build')(
  function* buildSymmyGroupMembershipPlan<Failure, ReserveFailure>(
    input: SymmyGroupMembershipPlanInput<Failure, ReserveFailure>,
  ) {
    const { authority, digest, idempotencyKey, legalEntityId, reserve, template, tenantId } = input;
    const { selector } = template;
    const enrolled = template.items.find(({ effects }) =>
      effects.some(
        ({ operation }) =>
          operation.moduleId === applyOperation.moduleId &&
          operation.entrypointKey === applyOperation.entrypointKey &&
          operation.schemaVersion === applyOperation.schemaVersion,
      ),
    );
    const rows = canonicalSymmyGroupCustomers(input.rows);
    if (
      legalEntityId === undefined ||
      enrolled === undefined ||
      selector?.kind !== 'CUSTOMER_GROUP' ||
      selector.target === undefined ||
      selector.target.tenantId !== tenantId ||
      selector.source.route.tenantId !== tenantId ||
      rows.some(({ profile }) => profile.profileRef.tenantId !== tenantId)
    ) {
      return Option.none<SymmyFixtureExecutionPlan>();
    }
    const { source } = enrolled;
    const groupRef = selector.target;
    const membershipItem = Effect.fn('SymmyGroupMembershipPlan.item')(function* membershipItem(
      { profile }: SymmyGroupCustomerRows[number],
      index: number,
      order: SymmyGroupMembershipOrder,
    ) {
      const itemKey = `membership-${index}`;
      const [record, occurrence] = yield* Effect.all(
        [
          digest(symmyGroupMembershipRecordSeed(selector.source.sourceRecordId, profile.profileRef.resourceId)),
          digest(`occurrence\u0000${idempotencyKey}\u0000${itemKey}`),
        ],
        { concurrency: 1 },
      );
      const recordId = `symmy-membership:${record}`;
      const occurrenceId = uuidFromDigest(occurrence);
      return {
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
                profile,
                reason: SYMMY_GROUP_MEMBERSHIP_REASON,
                route: { id: authority.routeId, revision: authority.routeRevision },
                source: {
                  assertionId: occurrenceId,
                  effectId: SYMMY_EFFECT_ASSIGNED_AT_ADMISSION,
                  order: order.order,
                  sourceRecordId: recordId,
                },
              },
            },
            operation: applyOperation,
            originalTarget: profile.profileRef,
          },
        ],
        itemKey,
        source: {
          entityKind: source.entityKind,
          issuerId: source.issuerId,
          sourceNamespace: source.sourceNamespace,
          sourceRecordId: recordId,
        },
        sourceOccurrenceId: occurrenceId,
      };
    });
    // Lineages are reserved in the one canonical order, so two admissions that share lineages never deadlock.
    const canonicalOrder = rows
      .map((row, index) => ({
        index,
        lineage: { issuer: source.issuerId, namespace: source.sourceNamespace, profileId: profileId(row) },
        row,
      }))
      .toSorted((left, right) => lineageOrder(left.lineage, right.lineage));
    const built = yield* Effect.forEach(
      canonicalOrder,
      ({ index, lineage, row }) =>
        reserve(lineage).pipe(
          Effect.flatMap((order) => membershipItem(row, index, order)),
          Effect.map((item) => ({ index, item })),
        ),
      { concurrency: 1 },
    );
    const items = built.toSorted((left, right) => left.index - right.index).map(({ item }) => item);
    return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items });
  },
);

type PlanItem = SymmyFixtureExecutionPlan['items'][number];
type PlanEffect = PlanItem['effects'][number];
type MembershipPayload = Extract<
  NonNullable<PlanEffect['intent']>,
  { readonly _tag: 'CustomerGroupMembership' }
>['payload'];

/** The membership an effect states, if it states one. */
const membershipOf = ({ intent }: PlanEffect): Option.Option<MembershipPayload> =>
  intent === undefined
    ? Option.none()
    : Match.value(intent).pipe(
        Match.tag('CustomerGroupMembership', ({ payload }) => Option.some(payload)),
        Match.orElse(() => Option.none()),
      );
/** The owner keys a membership by its profile and its manager, so they name its lineage. */
const membershipLineage = (payload: MembershipPayload): SymmyGroupMembershipLineage => ({
  issuer: payload.manager.issuer,
  namespace: payload.manager.sourceNamespace,
  profileId: canonicalSymmyProfileId(payload.profile.profileRef.resourceId),
});
const sameLineage = (left: SymmyGroupMembershipLineage, right: SymmyGroupMembershipLineage) =>
  lineageOrder(left, right) === 0;
const isUuid = Schema.is(Schema.String.check(Schema.isUUID()));

/** The plan with the memberships of one lineage at consecutive orders from `first`, in the plan's own order. */
const withLineageOrders = (
  plan: SymmyFixtureExecutionPlan,
  lineage: SymmyGroupMembershipLineage,
  first: number,
): SymmyFixtureExecutionPlan => {
  let next = first;
  const ordered = (effect: PlanEffect): PlanEffect =>
    effect.intent === undefined
      ? effect
      : Match.value(effect.intent).pipe(
          Match.tag('CustomerGroupMembership', (intent) => {
            if (!sameLineage(membershipLineage(intent.payload), lineage)) {
              return effect;
            }
            const order = next;
            next = order + 1;
            const { payload } = intent;
            return { ...effect, intent: { ...intent, payload: { ...payload, source: { ...payload.source, order } } } };
          }),
          Match.orElse(() => effect),
        );
  return {
    ...plan,
    items: EffectArray.map<SymmyFixtureExecutionPlan['items'], PlanItem>((item) => ({
      ...item,
      effects: EffectArray.map<PlanItem['effects'], PlanEffect>(ordered)(item.effects),
    }))(plan.items),
  };
};

export interface SymmyPlanMembershipOrderInput<ReserveFailure> {
  /** The legal entity of the membership owner. It comes from the route scope, never from the plan. */
  readonly legalEntityId: string | undefined;
  readonly plan: SymmyFixtureExecutionPlan;
  /** Reserves the next order of one lineage inside the admission transaction, exactly as for the public customers. */
  readonly reserve: (lineage: SymmyGroupMembershipLineage) => Effect.Effect<SymmyGroupMembershipOrder, ReserveFailure>;
  readonly tenantId: string;
}

/**
 * Gives every customer group membership an internal plan or a route template states the order the lineage ledger
 * reserves, as for the public customers: the same lineage of the canonical profile and the manager, the same
 * reservation and lock, in the same canonical order. The order the plan carries is never read: it is replaced, so no
 * caller places a membership outside the ledger. Memberships of one lineage take consecutive orders from its one
 * reservation, in the order the plan states them. A plan without a membership reserves nothing and is returned as it
 * is. A membership whose profile is not a UUID of the route's tenant, or a route without a legal entity, has no
 * lineage: there is no plan and nothing is reserved.
 */
export const orderSymmyPlanMemberships = Effect.fn('SymmyGroupMembershipPlan.orderPlanMemberships')(
  function* orderSymmyPlanMemberships<ReserveFailure>(input: SymmyPlanMembershipOrderInput<ReserveFailure>) {
    const { legalEntityId, plan, reserve, tenantId } = input;
    const memberships = plan.items.flatMap(({ effects }) =>
      effects.flatMap((effect) => Option.toArray(membershipOf(effect))),
    );
    if (memberships.length === 0) {
      return Option.some(plan);
    }
    if (
      legalEntityId === undefined ||
      memberships.some(
        ({ profile }) => profile.profileRef.tenantId !== tenantId || !isUuid(profile.profileRef.resourceId),
      )
    ) {
      return Option.none<SymmyFixtureExecutionPlan>();
    }
    const lineages = EffectArray.dedupeWith(memberships.map(membershipLineage), sameLineage).toSorted(lineageOrder);
    return Option.some(
      yield* Effect.reduce(
        lineages,
        () => plan,
        (current, lineage) =>
          reserve(lineage).pipe(Effect.map(({ order }) => withLineageOrders(current, lineage, order))),
      ),
    );
  },
);
