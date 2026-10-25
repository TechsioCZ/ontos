/**
 * Customer segment facade for the sales demo: a customer's "Segment" is its current Commerce Customer
 * Context customer-group membership in one of `customerSegmentDefinitions`.
 *
 * Cross-vertical boundary: commerce-customer-context already depends on party-registry (package and
 * TypeScript project reference), so party-registry cannot import its published client without a cycle.
 * This file therefore mirrors only the wire shape of the one owner read it calls, through the same
 * governed BFF transport and an audience-bound gateway as the owner's generated clients. The response
 * schema is deliberately partial: unknown owner fields are ignored, never re-validated here.
 *
 * Owner read used (POST under the gateway's commerce-customer-context API base):
 *   reads/counterparty-customer-group-memberships: the segment groups by business code and the current
 *   memberships of the listed counterparties. It needs only the `customer.group.read` context permission,
 *   so read-only roles see segments too and no role ever runs a write Action to display them. The demo
 *   reset seeds the groups; a segment whose group is missing is simply not offered.
 *
 * Segment rule: a customer may hold memberships in several segment groups; the current segment is the
 * VALID membership with the latest `effectiveFrom` (ties: latest `assignedAt`).
 */
import { makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { DateTime, Effect, Option, Random, Redacted, Schedule, Schema, SchemaGetter } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

import { CounterpartyRefSchema } from '../../shared/resources/counterparty.ts';
import type { CounterpartyRef } from '../../shared/resources/counterparty.ts';
import { customerSegmentDefinitions } from '../../shared/domain/customer-segment-definitions.ts';
import type { CustomerSegmentCode } from '../../shared/domain/customer-segment-definitions.ts';

export { customerSegmentDefinitions } from '../../shared/domain/customer-segment-definitions.ts';

const OWNER_API_PREFIX = '/commerce-customer-context-api';
const ownerGateway = makeOperationGateway('commerce-customer-context');

// ----- Owner wire contract (partial mirror of commerce-customer-context shared/apis) -----

export const CustomerSegmentGroupIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerSegmentGroupId'),
);
export type CustomerSegmentGroupId = typeof CustomerSegmentGroupIdSchema.Type;

const canonicalInstant = Schema.makeFilter((value: string) => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
    ? undefined
    : 'timestamp must be one canonical UTC instant with millisecond precision';
});
/** Canonical UTC instant (JSON form) as the owner writes it, so instants order as strings; same codec as the owner. */
const InstantSchema = Schema.toEncoded(
  Schema.String.check(canonicalInstant).pipe(
    Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
      decode: SchemaGetter.transform(DateTime.makeUnsafe),
      encode: SchemaGetter.transform(DateTime.formatIso),
    }),
  ),
);

const GroupRefSchema = Schema.Struct({ resourceId: CustomerSegmentGroupIdSchema });
const MembershipSchema = Schema.Struct({
  assignedAt: InstantSchema,
  effectiveFrom: InstantSchema,
  groupRef: GroupRefSchema,
  state: Schema.String,
});
type Membership = typeof MembershipSchema.Type;

const MembershipsApi = HttpApi.make('CustomerSegmentsMembershipsApi').add(
  HttpApiGroup.make('counterpartyCustomerGroupMemberships').add(
    HttpApiEndpoint.post('execute', '/reads/counterparty-customer-group-memberships', {
      // The owner's transient 503 carries `retryable: true`; declaring it keeps that marker for the retry below.
      error: makeRetryableProblemDetailsSchema('CustomerSegmentsUnavailableProblem', 503),
      payload: Schema.Struct({
        businessCodes: Schema.Array(Schema.String),
        counterpartyRefs: Schema.Array(CounterpartyRefSchema),
      }),
      success: Schema.Struct({
        groups: Schema.Array(
          Schema.Struct({
            businessCode: Schema.String,
            currentDefinition: Schema.Struct({ name: Schema.String }),
            currentState: Schema.String,
            groupRef: GroupRefSchema,
          }),
        ),
        items: Schema.Array(
          Schema.Struct({
            counterpartyRef: Schema.Struct({ resourceId: Schema.String }),
            membership: MembershipSchema,
          }),
        ),
      }),
    }),
  ),
);

// ----- Transport -----

/** Any owner transport, authorization or problem failure, reduced to the owner's problem detail. */
export class CustomerSegmentsError extends Schema.TaggedError<CustomerSegmentsError>()('CustomerSegmentsError', {
  reason: Schema.String,
  /** The owner marked the failure transient (`retryable: true`), so asking again may succeed. */
  retryable: Schema.Boolean,
}) {}

const ProblemDetailSchema = Schema.Struct({ detail: Schema.String });
const isRetryableProblem = Schema.is(Schema.Struct({ retryable: Schema.Literal(true) }));
const toSegmentsError = (cause: unknown) =>
  new CustomerSegmentsError({
    reason: Schema.is(ProblemDetailSchema)(cause) ? cause.detail : String(cause),
    retryable: isRetryableProblem(cause),
  });

const correlation = Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
  Effect.map(([first, second]) => `party-registry:customer-segments:memberships:${first}:${second}`),
);

/** One owner read with a fresh audience-bound gateway assertion. */
const readMemberships = (counterpartyRefs: readonly CounterpartyRef[]) =>
  correlation.pipe(
    Effect.flatMap((requestCorrelation) =>
      ownerGateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
        makeGovernedEffectBffClient(
          {
            api: MembershipsApi,
            credential: Redacted.make(credential),
            defaultApiPrefix: OWNER_API_PREFIX,
            requestCorrelation,
          },
          { baseUrl: apiBaseUrl, compositionRevision },
        ).pipe(
          Effect.flatMap((client) =>
            client.counterpartyCustomerGroupMemberships.execute({
              payload: {
                businessCodes: customerSegmentDefinitions.map(({ businessCode }) => businessCode),
                counterpartyRefs,
              },
            }),
          ),
        ),
      ),
    ),
    Effect.mapError(toSegmentsError),
  );

// ----- Public facade -----

export interface CustomerSegment {
  readonly code: CustomerSegmentCode;
  readonly groupId: CustomerSegmentGroupId;
  readonly name: string;
}

/** What the facade needs per customer; `CustomerListItem` rows satisfy it structurally. */
export interface CustomerSegmentSubject {
  readonly counterpartyRef: CounterpartyRef;
  readonly partyId: string;
}

/** Two more attempts, 300 ms then 600 ms apart, for a failure the owner marked transient. */
const transientRetry = Schedule.exponential('300 millis').pipe(Schedule.upTo({ times: 2 }));

/** The owner caps one read at 200 counterparties. */
const READ_BATCH = 200;

const isLater = (candidate: Membership, current: Membership | undefined) =>
  current === undefined ||
  candidate.effectiveFrom > current.effectiveFrom ||
  (candidate.effectiveFrom === current.effectiveFrom && candidate.assignedAt > current.assignedAt);

/** Current segment per party id; customers without a segment are absent from the map. */
export const customerSegmentsFor = Effect.fn('CustomerSegmentsClient.customerSegmentsFor')(
  function* readCustomerSegments(customers: readonly CustomerSegmentSubject[]) {
    const result = new Map<string, CustomerSegment>();
    if (customers.length === 0) {
      return result;
    }
    const batches: (readonly CustomerSegmentSubject[])[] = [];
    for (let start = 0; start < customers.length; start += READ_BATCH) {
      batches.push(customers.slice(start, start + READ_BATCH));
    }
    const pages = yield* Effect.forEach(
      batches,
      (batch) =>
        readMemberships(batch.map(({ counterpartyRef }) => counterpartyRef)).pipe(
          Effect.retry({ schedule: transientRetry, while: (error) => error.retryable }),
        ),
      { concurrency: 2 },
    );
    const segments = new Map<string, CustomerSegment>();
    for (const definition of customerSegmentDefinitions) {
      const group = pages[0]?.groups.find(
        (candidate) => candidate.businessCode === definition.businessCode && candidate.currentState === 'ACTIVE',
      );
      if (group !== undefined) {
        segments.set(group.groupRef.resourceId, {
          code: definition.businessCode,
          groupId: group.groupRef.resourceId,
          name: group.currentDefinition.name,
        });
      }
    }
    const current = new Map<string, Membership>();
    for (const { counterpartyRef, membership } of pages.flatMap(({ items }) => items)) {
      if (membership.state === 'VALID' && segments.has(membership.groupRef.resourceId)) {
        const key = counterpartyRef.resourceId;
        if (isLater(membership, current.get(key))) {
          current.set(key, membership);
        }
      }
    }
    for (const customer of customers) {
      const membership = current.get(customer.counterpartyRef.resourceId);
      const segment = membership === undefined ? undefined : segments.get(membership.groupRef.resourceId);
      if (segment !== undefined) {
        result.set(customer.partyId, segment);
      }
    }
    return result;
  },
);
