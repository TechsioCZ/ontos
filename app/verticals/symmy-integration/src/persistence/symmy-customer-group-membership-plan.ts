import { Array as EffectArray, DateTime, Effect, Match, Option, Order, Schema } from 'effect';

import { SYMMY_EFFECT_ASSIGNED_AT_ADMISSION } from '../../shared/domain/symmy-customer-batch.ts';
import {
  SYMMY_GROUP_MEMBERSHIP_REASON,
  canonicalSymmyGroupCustomers,
  canonicalSymmyProfileId,
  symmyGroupMembershipRecordSeed,
} from '../../shared/domain/symmy-customer-group-batch.ts';
import type { SymmyGroupCustomerRows } from '../../shared/domain/symmy-customer-group-batch.ts';
import { symmyGroupMembershipOccurrenceSeed } from '../../shared/domain/symmy-group-membership-occurrence.ts';
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

type PlanItem = SymmyFixtureExecutionPlan['items'][number];
type PlanEffect = PlanItem['effects'][number];
type MembershipIntent = Extract<NonNullable<PlanEffect['intent']>, { readonly _tag: 'CustomerGroupMembership' }>;
type MembershipPayload = MembershipIntent['payload'];

/** Whether an effect is the owner's membership write. */
const isMembershipWrite = ({ operation }: Pick<PlanEffect, 'operation'>) =>
  operation.moduleId === applyOperation.moduleId &&
  operation.entrypointKey === applyOperation.entrypointKey &&
  operation.schemaVersion === applyOperation.schemaVersion;

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
    const { admittedRouteId, authority, digest, idempotencyKey, legalEntityId, reserve, template, tenantId } = input;
    const { selector } = template;
    const enrolled = template.items.find(({ effects }) => effects.some(isMembershipWrite));
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

/** The membership intent an effect states, if it states one. */
const membershipOf = ({ intent }: PlanEffect): Option.Option<MembershipIntent> =>
  intent === undefined
    ? Option.none()
    : Match.value(intent).pipe(
        Match.tag('CustomerGroupMembership', (membership) => Option.some(membership)),
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

interface ResourceRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
const sameResource = (left: ResourceRef | undefined, right: ResourceRef | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;
/** The one group an assignment or a removal names; a complete or partial set names none. */
const namedGroup = (payload: MembershipPayload) =>
  payload.operation === 'ASSIGN' || payload.operation === 'REMOVE' ? payload.groupRef : undefined;

const effectIdentity = (itemKey: string, effectKey: string) => `${itemKey}\u0000${effectKey}`;

/**
 * The plan's effects in its one deterministic dependency order: each effect after every effect it depends on, and
 * otherwise in the order the plan lists them. None when the dependencies form a cycle.
 */
const dependencyOrder = (plan: SymmyFixtureExecutionPlan) => {
  const nodes = plan.items.flatMap(({ effects, itemKey }) =>
    effects.map((effect) => ({
      dependencies: (effect.dependsOn ?? []).map((dependency) =>
        Schema.is(Schema.String)(dependency)
          ? effectIdentity(itemKey, dependency)
          : effectIdentity(dependency.itemKey, dependency.effectKey),
      ),
      effect,
      identity: effectIdentity(itemKey, effect.effectKey),
    })),
  );
  const placed = new Set<string>();
  const ordered: { readonly effect: PlanEffect; readonly identity: string }[] = [];
  for (const _node of nodes) {
    const next = nodes.find(
      ({ dependencies, identity }) =>
        !placed.has(identity) && dependencies.every((dependency) => placed.has(dependency)),
    );
    if (next === undefined) {
      return Option.none<typeof ordered>();
    }
    placed.add(next.identity);
    ordered.push(next);
  }
  return Option.some(ordered);
};

/** The effect with the given order of its lineage in place of the order the plan carries. */
const withOrder = (effect: PlanEffect, intent: MembershipIntent, order: number): PlanEffect => {
  const { payload } = intent;
  return { ...effect, intent: { ...intent, payload: { ...payload, source: { ...payload.source, order } } } };
};

export interface SymmyPlanMembershipOrderInput<ReserveFailure> {
  /** The authority of the admitted route's source route: the route every membership must cite. */
  readonly authority: SymmyCustomerSourceAuthority;
  /** The legal entity of the membership owner. It comes from the route scope, never from the plan. */
  readonly legalEntityId: string | undefined;
  readonly plan: SymmyFixtureExecutionPlan;
  /** Reserves the next order of one lineage inside the admission transaction, exactly as for the public customers. */
  readonly reserve: (lineage: SymmyGroupMembershipLineage) => Effect.Effect<SymmyGroupMembershipOrder, ReserveFailure>;
  /** The admitted route's enrollment: the membership sources it enrolls and the group it selects. */
  readonly template: SymmyFixtureExecutionPlan;
  readonly tenantId: string;
}

/**
 * Gives every customer group membership an internal plan or a route template states the order the lineage ledger
 * reserves, as for the public customers: the same lineage of the canonical profile and the manager, the same
 * reservation and lock, in the same canonical order. The order the plan carries is never read: it is replaced, so no
 * caller places a membership outside the ledger. Memberships of one lineage take consecutive orders from its one
 * reservation in the plan's dependency order, so no membership waits for one that depends on it.
 *
 * A plan without a membership reserves nothing and is returned as it is. There is no plan, and nothing is reserved,
 * for dependencies that form a cycle, for a route without a legal entity, and for a membership whose profile is not
 * a UUID of the route's tenant or that names a manager the route does not enroll for the membership write, another
 * source route than the admitted route's, or, on a route that selects a customer group, any other group.
 */
export const orderSymmyPlanMemberships = Effect.fn('SymmyGroupMembershipPlan.orderPlanMemberships')(
  function* orderSymmyPlanMemberships<ReserveFailure>(input: SymmyPlanMembershipOrderInput<ReserveFailure>) {
    const { authority, legalEntityId, plan, reserve, template, tenantId } = input;
    const ordered = dependencyOrder(plan);
    if (Option.isNone(ordered)) {
      return Option.none<SymmyFixtureExecutionPlan>();
    }
    const memberships = ordered.value.flatMap(({ effect, identity }) =>
      Option.toArray(membershipOf(effect)).map((intent) => ({
        effect,
        identity,
        intent,
        lineage: membershipLineage(intent.payload),
      })),
    );
    if (memberships.length === 0) {
      return Option.some(plan);
    }
    const managers = template.items.flatMap(({ effects, source }) => (effects.some(isMembershipWrite) ? [source] : []));
    const { selector } = template;
    const enrolled = (payload: MembershipPayload) =>
      payload.profile.profileRef.tenantId === tenantId &&
      isUuid(payload.profile.profileRef.resourceId) &&
      payload.manager.tenantId === tenantId &&
      managers.some(
        ({ issuerId, sourceNamespace }) =>
          issuerId === payload.manager.issuer && sourceNamespace === payload.manager.sourceNamespace,
      ) &&
      payload.route.id === authority.routeId &&
      payload.route.revision === authority.routeRevision &&
      (selector?.kind !== 'CUSTOMER_GROUP' || sameResource(namedGroup(payload), selector.target));
    if (legalEntityId === undefined || memberships.some(({ intent }) => !enrolled(intent.payload))) {
      return Option.none<SymmyFixtureExecutionPlan>();
    }
    const lineages = EffectArray.dedupeWith(
      memberships.map(({ lineage }) => lineage),
      sameLineage,
    ).toSorted(lineageOrder);
    const reservations = yield* Effect.forEach(
      lineages,
      (lineage) => reserve(lineage).pipe(Effect.map(({ order }) => ({ first: order, lineage }))),
      { concurrency: 1 },
    );
    const reordered = new Map<string, PlanEffect>();
    for (const { first, lineage } of reservations) {
      const ofLineage = memberships.filter((membership) => sameLineage(membership.lineage, lineage));
      for (const [offset, { effect, identity, intent }] of ofLineage.entries()) {
        reordered.set(identity, withOrder(effect, intent, first + offset));
      }
    }
    return Option.some({
      ...plan,
      items: EffectArray.map<SymmyFixtureExecutionPlan['items'], PlanItem>((item) => ({
        ...item,
        effects: EffectArray.map<PlanItem['effects'], PlanEffect>(
          (effect) => reordered.get(effectIdentity(item.itemKey, effect.effectKey)) ?? effect,
        )(item.effects),
      }))(plan.items),
    });
  },
);
