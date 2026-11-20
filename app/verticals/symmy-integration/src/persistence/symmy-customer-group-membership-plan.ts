import { DateTime, Effect, Option, Schema } from 'effect';

import { SYMMY_EFFECT_ASSIGNED_AT_ADMISSION } from '../../shared/domain/symmy-customer-batch.ts';
import {
  SYMMY_GROUP_MEMBERSHIP_REASON,
  canonicalSymmyGroupCustomers,
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
    // Lineages are reserved in one canonical order, so two admissions that share profiles never deadlock.
    const canonicalOrder = rows
      .map((row, index) => ({ index, row }))
      .toSorted((left, right) => (profileId(left.row) < profileId(right.row) ? -1 : 1));
    const built = yield* Effect.forEach(
      canonicalOrder,
      ({ index, row }) =>
        reserve({ issuer: source.issuerId, namespace: source.sourceNamespace, profileId: profileId(row) }).pipe(
          Effect.flatMap((order) => membershipItem(row, index, order)),
          Effect.map((item) => ({ index, item })),
        ),
      { concurrency: 1 },
    );
    const items = built.toSorted((left, right) => left.index - right.index).map(({ item }) => item);
    return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items });
  },
);
