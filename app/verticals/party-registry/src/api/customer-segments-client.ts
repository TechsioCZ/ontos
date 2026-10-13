/**
 * Customer segment facade for the sales demo: a customer's "Segment" is its current Commerce Customer
 * Context customer-group membership in one of `customerSegmentDefinitions`.
 *
 * Cross-vertical boundary: commerce-customer-context already depends on party-registry (package and
 * TypeScript project reference), so party-registry cannot import its published client without a cycle.
 * This file therefore mirrors only the wire shapes of the five owner endpoints it calls, through the
 * same governed BFF transport and an audience-bound gateway as the owner's generated clients. Response
 * schemas are deliberately partial: unknown owner fields are ignored, never re-validated here.
 *
 * Owner endpoints used (all POST under the gateway's commerce-customer-context API base):
 *   create-customer-group (replayed: identical definitions return the existing group, `created: false`),
 *   create-counterparty-purchasing-profile (idempotent ensure of the COUNTERPARTY profile),
 *   reads/customer-group-members, assign-customer-group, remove-customer-group.
 *
 * Segment rule: a customer may hold memberships in several segment groups; the current segment is the
 * VALID membership with the latest `effectiveFrom` (ties: latest `assignedAt`). `setCustomerSegment`
 * ends the other segment memberships (best effort) and assigns the target from now.
 */
import { makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import {
  DateTime,
  Duration,
  Effect,
  Encoding,
  Exit,
  Option,
  Random,
  Redacted,
  Result,
  Schedule,
  Schema,
  SchemaGetter,
} from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

import { CounterpartyRefSchema } from '../../shared/resources/counterparty.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { CounterpartyRef } from '../../shared/resources/counterparty.ts';
import { customerSegmentDefinitions } from './customer-segment-definitions.ts';
import type { CustomerSegmentCode, CustomerSegmentDefinition } from './customer-segment-definitions.ts';

export { customerSegmentDefinitions } from './customer-segment-definitions.ts';
export type { CustomerSegmentCode } from './customer-segment-definitions.ts';

const OWNER_MODULE_ID = 'commerce.customer-context';
const OWNER_API_PREFIX = '/commerce-customer-context-api';
const ownerGateway = makeOperationGateway('commerce-customer-context');

// ----- Owner wire contract (partial mirror of commerce-customer-context shared/apis) -----

export const CustomerSegmentGroupIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerSegmentGroupId'),
);
export type CustomerSegmentGroupId = typeof CustomerSegmentGroupIdSchema.Type;
const OwnerTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CustomerSegmentTenantId'));
const ProfileIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('CustomerSegmentProfileId'),
);
const MembershipIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CustomerSegmentMembershipId'));
const canonicalInstant = Schema.makeFilter((value: string) => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
    ? undefined
    : 'timestamp must be one canonical UTC instant with millisecond precision';
});
/** Canonical UTC instant (JSON form), the only timestamp form the owner accepts; same codec as the owner. */
const InstantSchema = Schema.toEncoded(
  Schema.String.check(canonicalInstant).pipe(
    Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
      decode: SchemaGetter.transform(DateTime.makeUnsafe),
      encode: SchemaGetter.transform(DateTime.formatIso),
    }),
  ),
);

const GroupRefSchema = Schema.Struct({
  moduleId: Schema.Literal(OWNER_MODULE_ID),
  resourceId: CustomerSegmentGroupIdSchema,
  resourceType: Schema.Literal('commerce.customer-context.customer-group'),
  tenantId: OwnerTenantIdSchema,
});
type GroupRef = typeof GroupRefSchema.Type;
const ProfileRefSchema = Schema.Struct({
  moduleId: Schema.Literal(OWNER_MODULE_ID),
  resourceId: ProfileIdSchema,
  resourceType: Schema.Literal('commerce.customer-context.counterparty-purchasing-profile'),
  tenantId: OwnerTenantIdSchema,
});
const ProfileSubjectSchema = Schema.Struct({
  profileKind: Schema.Literal('COUNTERPARTY'),
  profileRef: ProfileRefSchema,
});
type ProfileSubject = typeof ProfileSubjectSchema.Type;
const MembershipRefSchema = Schema.Struct({
  moduleId: Schema.Literal(OWNER_MODULE_ID),
  resourceId: MembershipIdSchema,
  resourceType: Schema.Literal('commerce.customer-context.customer-group-membership'),
  tenantId: OwnerTenantIdSchema,
});
const MembershipSchema = Schema.Struct({
  assignedAt: InstantSchema,
  effectiveFrom: InstantSchema,
  groupRef: GroupRefSchema,
  membershipRef: MembershipRefSchema,
  profile: Schema.Struct({ profileKind: Schema.String, profileRef: Schema.Struct({ resourceId: ProfileIdSchema }) }),
  state: Schema.String,
});
type Membership = typeof MembershipSchema.Type;

const ownerAction = <const Name extends string, P extends Schema.Top, S extends Schema.Top>(
  name: Name,
  slug: string,
  payload: P,
  success: S,
) =>
  HttpApi.make(`CustomerSegments${name}Api`).add(
    HttpApiGroup.make(name).add(
      HttpApiEndpoint.post('execute', `/commerce-customer-context/actions/${slug}`, {
        // The owner's transient 503 carries `retryable: true`; declaring it keeps that marker for the retry below.
        error: [
          makeProblemDetailsSchema(`${name}ConflictProblem`, 409, { code: Schema.String }),
          makeRetryableProblemDetailsSchema(`${name}UnavailableProblem`, 503, { code: Schema.String }),
        ],
        payload,
        success,
      }),
    ),
  );

const CreateGroupApi = ownerAction(
  'CreateCustomerGroupAction',
  'create-customer-group',
  Schema.Struct({
    businessCode: Schema.String,
    description: Schema.String,
    initialState: Schema.Literal('ACTIVE'),
    meaningKey: Schema.String,
    membershipCriteria: Schema.String,
    name: Schema.String,
    purpose: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({
    group: Schema.Struct({
      businessCode: Schema.String,
      currentDefinition: Schema.Struct({ name: Schema.String }),
      currentState: Schema.String,
      groupRef: GroupRefSchema,
    }),
  }),
);
const EnsureProfileApi = ownerAction(
  'CreateCounterpartyPurchasingProfileAction',
  'create-counterparty-purchasing-profile',
  Schema.Struct({
    effectiveAt: InstantSchema,
    subject: Schema.Struct({ counterpartyRef: CounterpartyRefSchema, kind: Schema.Literal('COUNTERPARTY') }),
    trigger: Schema.Literal('AUTHORIZED_ONBOARDING'),
  }),
  Schema.Struct({ profileRef: ProfileRefSchema, state: Schema.String }),
);
const AssignApi = ownerAction(
  'AssignCustomerGroupAction',
  'assign-customer-group',
  Schema.Struct({
    effectiveFrom: InstantSchema,
    groupRef: GroupRefSchema,
    profile: ProfileSubjectSchema,
    reason: Schema.String,
  }),
  Schema.Struct({ created: Schema.Boolean }),
);
const RemoveApi = ownerAction(
  'RemoveCustomerGroupAction',
  'remove-customer-group',
  Schema.Struct({
    effectiveAt: InstantSchema,
    groupRef: GroupRefSchema,
    membershipRef: MembershipRefSchema,
    profile: ProfileSubjectSchema,
    reason: Schema.String,
  }),
  Schema.Struct({ changed: Schema.Boolean }),
);
const MembersApi = HttpApi.make('CustomerSegmentsMembersApi').add(
  HttpApiGroup.make('customerGroupMembers').add(
    HttpApiEndpoint.post('execute', '/reads/customer-group-members', {
      payload: Schema.Struct({
        cursor: Schema.optionalKey(Schema.String),
        groupRef: GroupRefSchema,
        limit: Schema.optionalKey(Schema.Finite),
        profileKind: Schema.Literal('COUNTERPARTY'),
      }),
      success: Schema.Struct({
        items: Schema.Array(MembershipSchema),
        nextCursor: Schema.OptionFromNullOr(Schema.String),
      }),
    }),
  ),
);

// ----- Transport -----

/** Any owner transport, authorization or problem failure, reduced to the owner's problem detail. */
export class CustomerSegmentsError extends Schema.TaggedError<CustomerSegmentsError>()('CustomerSegmentsError', {
  /** The owner answered 403: this role may not run the call, so asking again in this page lifetime cannot help. */
  forbidden: Schema.Boolean,
  reason: Schema.String,
  /** The owner marked the failure transient (`retryable: true`), so asking again may succeed. */
  retryable: Schema.Boolean,
}) {}

const ProblemDetailSchema = Schema.Struct({ detail: Schema.String });
const isRetryableProblem = Schema.is(Schema.Struct({ retryable: Schema.Literal(true) }));
const isForbiddenProblem = Schema.is(Schema.Struct({ status: Schema.Literal(403) }));
const isSegmentsError = Schema.is(CustomerSegmentsError);
const toSegmentsError = (cause: unknown) =>
  isSegmentsError(cause)
    ? cause
    : new CustomerSegmentsError({
        forbidden: isForbiddenProblem(cause),
        reason: Schema.is(ProblemDetailSchema)(cause) ? cause.detail : String(cause),
        retryable: isRetryableProblem(cause),
      });

/**
 * The module cache below starts empty on every full page load, so without a memo each load replays the four
 * create-customer-group Actions, and a role without the create permission gets a 403 each time. Both outcomes are
 * therefore kept in sessionStorage, keyed by the principal and tenant named in the gateway assertion: the refusal,
 * and the resolved groups. A later load with the same identity skips the create requests. Another account or tenant
 * in the same tab has a different key, so it still asks the owner.
 */
const refusedCreateStorageKey = (principalKey: string) => `party-registry.segments.create-refused:${principalKey}`;
const resolvedGroupsStorageKey = (principalKey: string) => `party-registry.segments.groups:${principalKey}`;
const AssertionClaimsSchema = Schema.fromJsonString(
  Schema.Struct({ principal: Schema.Struct({ principalId: Schema.String, tenantId: Schema.String }) }),
);
const decodeAssertionClaims = Schema.decodeUnknownOption(AssertionClaimsSchema);
/** `principalId:tenantId` read from the unverified payload of a `Bearer <jwt>` credential, if it has one. */
const principalKeyOf = (credential: Redacted.Redacted): string | undefined => {
  const [, payload] = Redacted.value(credential)
    .replace(/^Bearer /u, '')
    .split('.');
  const json = payload === undefined ? undefined : Result.getOrUndefined(Encoding.decodeBase64UrlString(payload));
  const claims = json === undefined ? Option.none() : decodeAssertionClaims(json);
  return Option.isSome(claims) ? `${claims.value.principal.principalId}:${claims.value.principal.tenantId}` : undefined;
};
const sessionStorageOrUndefined = (): Storage | undefined =>
  'sessionStorage' in globalThis ? globalThis.sessionStorage : undefined;
const createWasRefused = (principalKey: string | undefined): boolean => {
  if (principalKey === undefined) {
    return false;
  }
  try {
    return sessionStorageOrUndefined()?.getItem(refusedCreateStorageKey(principalKey)) === '1';
  } catch {
    return false;
  }
};
/** Stores `value` under `key`; `null` removes the item. */
const writeSessionItem = (key: string, value: string | null) =>
  Effect.sync(() => {
    try {
      if (value === null) {
        sessionStorageOrUndefined()?.removeItem(key);
      } else {
        sessionStorageOrUndefined()?.setItem(key, value);
      }
    } catch {
      // Storage is full or blocked: the next full page load asks the owner again.
    }
  });
const rememberCreateRefusal = (principalKey: string | undefined) =>
  principalKey === undefined ? Effect.void : writeSessionItem(refusedCreateStorageKey(principalKey), '1');

const correlation = (operation: string) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `party-registry:customer-segments:${operation}:${first}:${second}`),
  );

interface OwnerTransport {
  readonly config: {
    readonly credential: Redacted.Redacted;
    readonly defaultApiPrefix: string;
    readonly idempotencyKey?: string;
    readonly requestCorrelation: string;
  };
  readonly options: { readonly baseUrl: string; readonly compositionRevision: string };
}

/** One owner call with a fresh audience-bound gateway assertion (and idempotency key for Actions). */
const viaOwner = <A, E>(
  operation: string,
  kind: 'action' | 'read',
  call: (transport: OwnerTransport) => Effect.Effect<A, E>,
): Effect.Effect<A, CustomerSegmentsError> =>
  Effect.all([correlation(operation), correlation(`${operation}-key`)], { concurrency: 1 }).pipe(
    Effect.flatMap(([requestCorrelation, idempotencyKey]) =>
      ownerGateway.invoke((credential, { apiBaseUrl, compositionRevision }) => {
        const config = {
          credential: Redacted.make(credential),
          defaultApiPrefix: OWNER_API_PREFIX,
          requestCorrelation,
        };
        return call({
          config: kind === 'action' ? { ...config, idempotencyKey } : config,
          options: { baseUrl: apiBaseUrl, compositionRevision },
        });
      }),
    ),
    Effect.mapError(toSegmentsError),
  );

const nowIso = DateTime.now.pipe(
  Effect.map(DateTime.formatIso),
  Effect.flatMap(Schema.decodeEffect(InstantSchema)),
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

export interface CustomerSegmentChange {
  readonly outcome: 'assigned' | 'unchanged' | 'failed';
  readonly partyId: string;
  readonly reason?: string;
}

interface SegmentGroup {
  readonly ref: GroupRef;
  readonly segment: CustomerSegment;
}

/** Stored form of the resolved groups: the owner's group ref and current name per segment code. */
const StoredSegmentGroupsSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ code: Schema.String, name: Schema.String, ref: GroupRefSchema })),
);
const decodeStoredSegmentGroups = Schema.decodeUnknownOption(StoredSegmentGroupsSchema);
const encodeStoredSegmentGroups = Schema.encodeOption(StoredSegmentGroupsSchema);

/** Groups resolved earlier in this browser session, when every stored code is still one of the definitions. */
const storedSegmentGroups = (principalKey: string): readonly SegmentGroup[] | undefined => {
  let raw: string | null | undefined;
  try {
    raw = sessionStorageOrUndefined()?.getItem(resolvedGroupsStorageKey(principalKey));
  } catch {
    return undefined;
  }
  const stored = raw === null || raw === undefined ? Option.none() : decodeStoredSegmentGroups(raw);
  if (Option.isNone(stored)) {
    return undefined;
  }
  const groups: SegmentGroup[] = [];
  for (const { code, name, ref } of stored.value) {
    const definition = customerSegmentDefinitions.find((candidate) => candidate.businessCode === code);
    if (definition === undefined) {
      return undefined;
    }
    groups.push({ ref, segment: { code: definition.businessCode, groupId: ref.resourceId, name } });
  }
  return groups;
};
/** Stores the resolved groups, or removes them with `null`. */
const rememberSegmentGroups = (principalKey: string | undefined, groups: readonly SegmentGroup[] | null) => {
  if (principalKey === undefined) {
    return Effect.void;
  }
  const encoded =
    groups === null
      ? Option.none<string>()
      : encodeStoredSegmentGroups(groups.map(({ ref, segment }) => ({ code: segment.code, name: segment.name, ref })));
  return writeSessionItem(resolvedGroupsStorageKey(principalKey), Option.getOrNull(encoded));
};

/**
 * The `principalId:tenantId` of the signed-in user, read from a fresh owner-audience gateway assertion. The
 * assertion is never sent to the owner; it only keys the session memos before any owner request is made.
 */
const currentPrincipalKey = ownerGateway
  .invoke((credential) => Effect.succeed(principalKeyOf(Redacted.make(credential))))
  .pipe(Effect.mapError(toSegmentsError));

const resolveSegment = (
  definition: CustomerSegmentDefinition & { readonly businessCode: CustomerSegmentCode },
  principalKey: string | undefined,
) =>
  viaOwner('segment', 'action', ({ config, options }) =>
    makeGovernedEffectBffClient({ api: CreateGroupApi, ...config }, options).pipe(
      Effect.flatMap((client) =>
        client.CreateCustomerGroupAction.execute({
          payload: {
            businessCode: definition.businessCode,
            description: definition.description,
            initialState: 'ACTIVE',
            meaningKey: definition.meaningKey,
            membershipCriteria: definition.membershipCriteria,
            name: definition.name,
            purpose: definition.purpose,
            reason: 'Načtení segmentů zákazníků',
          },
        }),
      ),
      Effect.tapError((cause) => (isForbiddenProblem(cause) ? rememberCreateRefusal(principalKey) : Effect.void)),
    ),
  ).pipe(
    Effect.map(({ group }): SegmentGroup | undefined =>
      group.currentState === 'ACTIVE'
        ? {
            ref: group.groupRef,
            segment: {
              code: definition.businessCode,
              groupId: group.groupRef.resourceId,
              name: group.currentDefinition.name,
            },
          }
        : undefined,
    ),
  );

/** Two more attempts, 300 ms then 600 ms apart, for a failure the owner marked transient. */
const transientRetry = Schedule.exponential('300 millis').pipe(Schedule.upTo({ times: 2 }));

/**
 * Groups resolved earlier in this browser session come from sessionStorage without an owner request, and a role
 * refused earlier fails at once. Otherwise definitions resolve one at a time and the first failure stops the
 * rest, so an owner that refuses the call costs one request instead of four. Only a transient owner 503 (several
 * list pages replaying the same create at once) is asked again, each time with a fresh gateway assertion and
 * idempotency key. Resolved groups are stored for the next page load.
 */
const resolveSegmentGroups = Effect.gen(function* resolveSegmentGroups() {
  const principalKey = yield* currentPrincipalKey;
  if (createWasRefused(principalKey)) {
    return yield* new CustomerSegmentsError({
      forbidden: true,
      reason: 'create-customer-group was refused earlier in this browser session',
      retryable: false,
    });
  }
  const stored = principalKey === undefined ? undefined : storedSegmentGroups(principalKey);
  if (stored !== undefined) {
    return stored;
  }
  const resolved = yield* Effect.forEach(
    customerSegmentDefinitions,
    (definition) =>
      resolveSegment(definition, principalKey).pipe(
        Effect.retry({ schedule: transientRetry, while: (error) => error.retryable }),
      ),
    { concurrency: 1 },
  );
  const groups = resolved.filter((group) => group !== undefined);
  yield* rememberSegmentGroups(principalKey, groups);
  return groups;
});

/**
 * A stored group the owner no longer knows (a demo reset recreates the groups) fails the member reads, so any
 * failure that is not a refusal drops the stored groups and the next load resolves them again.
 */
const forgetStoredSegmentGroups = currentPrincipalKey.pipe(
  Effect.flatMap((principalKey) => rememberSegmentGroups(principalKey, null)),
  Effect.ignore,
);

/**
 * The seeded groups never change while the page is open, so the replayed create-customer-group Actions run once
 * per module lifetime instead of on every list load. Concurrent callers share one resolution. A failure drops the
 * cache, so the next call asks the owner again, except a 403: a read-only role (the accountant) may not run the
 * create Action, so its refusal is kept and later list loads hide the segment column without another request.
 */
const [cachedSegmentGroups, invalidateSegmentGroups] = browserRuntime.runSync(
  Effect.cachedInvalidateWithTTL(resolveSegmentGroups, Duration.infinity),
);
const segmentGroups = cachedSegmentGroups.pipe(
  Effect.tapError(({ forbidden }) => (forbidden ? Effect.void : invalidateSegmentGroups)),
);

/** The demo segments in definition order: [{ code, groupId, name }]. */
export const listCustomerSegments = segmentGroups.pipe(Effect.map((groups) => groups.map(({ segment }) => segment)));

const ensureProfile = (counterpartyRef: CounterpartyRef) =>
  nowIso.pipe(
    Effect.flatMap((effectiveAt) =>
      viaOwner('profile', 'action', ({ config, options }) =>
        makeGovernedEffectBffClient({ api: EnsureProfileApi, ...config }, options).pipe(
          Effect.flatMap((client) =>
            client.CreateCounterpartyPurchasingProfileAction.execute({
              payload: {
                effectiveAt,
                subject: { counterpartyRef, kind: 'COUNTERPARTY' },
                trigger: 'AUTHORIZED_ONBOARDING',
              },
            }),
          ),
        ),
      ),
    ),
    Effect.map(({ profileRef }): ProfileSubject => ({ profileKind: 'COUNTERPARTY', profileRef })),
  );

const groupMembers = (groupRef: GroupRef) => {
  const page = (cursor?: string): Effect.Effect<readonly Membership[], CustomerSegmentsError> =>
    viaOwner('members', 'read', ({ config, options }) =>
      makeGovernedEffectBffClient({ api: MembersApi, ...config }, options).pipe(
        Effect.flatMap((client) =>
          client.customerGroupMembers.execute({
            payload:
              cursor === undefined
                ? { groupRef, limit: 100, profileKind: 'COUNTERPARTY' }
                : { cursor, groupRef, limit: 100, profileKind: 'COUNTERPARTY' },
          }),
        ),
      ),
    ).pipe(
      Effect.flatMap(({ items, nextCursor }) =>
        Option.isNone(nextCursor)
          ? Effect.succeed(items)
          : page(nextCursor.value).pipe(Effect.map((rest) => [...items, ...rest])),
      ),
    );
  return page();
};

const isLater = (candidate: Membership, current: Membership | undefined) =>
  current === undefined ||
  candidate.effectiveFrom > current.effectiveFrom ||
  (candidate.effectiveFrom === current.effectiveFrom && candidate.assignedAt > current.assignedAt);

const currentOf = (memberships: readonly Membership[]) => {
  let current: Membership | undefined;
  for (const candidate of memberships) {
    if (isLater(candidate, current)) {
      current = candidate;
    }
  }
  return current;
};

/** VALID memberships per profile id across the demo segments, plus the segments by group id. */
const segmentMemberships = Effect.gen(function* segmentMemberships() {
  const groups = yield* segmentGroups;
  const members = yield* Effect.forEach(groups, ({ ref }) => groupMembers(ref), { concurrency: 4 }).pipe(
    Effect.tapError(({ forbidden }) =>
      forbidden ? Effect.void : Effect.andThen(invalidateSegmentGroups, forgetStoredSegmentGroups),
    ),
  );
  const byProfile = new Map<string, readonly Membership[]>();
  for (const membership of members.flat()) {
    if (membership.state === 'VALID') {
      const key = membership.profile.profileRef.resourceId;
      byProfile.set(key, [...(byProfile.get(key) ?? []), membership]);
    }
  }
  const segments = new Map<string, SegmentGroup>(groups.map((group) => [group.ref.resourceId, group]));
  return { byProfile, segments };
});

/** Current segment per party id; customers without a segment are absent from the map. */
export const customerSegmentsFor = Effect.fn('CustomerSegmentsClient.customerSegmentsFor')(
  function* readCustomerSegments(customers: readonly CustomerSegmentSubject[]) {
    const result = new Map<string, CustomerSegment>();
    if (customers.length === 0) {
      return result;
    }
    const { byProfile, segments } = yield* segmentMemberships;
    const profiles = yield* Effect.forEach(customers, ({ counterpartyRef }) => ensureProfile(counterpartyRef), {
      concurrency: 6,
    });
    for (const [index, customer] of customers.entries()) {
      const profileId = profiles[index]?.profileRef.resourceId ?? '';
      const current = currentOf(byProfile.get(profileId) ?? []);
      const segment = current === undefined ? undefined : segments.get(current.groupRef.resourceId)?.segment;
      if (segment !== undefined) {
        result.set(customer.partyId, segment);
      }
    }
    return result;
  },
);

const REASON = 'Změna segmentu zákazníka';

const changeSegment = Effect.fn('CustomerSegmentsClient.changeSegment')(
  function* changeOne(
    customer: CustomerSegmentSubject,
    target: SegmentGroup,
    byProfile: ReadonlyMap<string, readonly Membership[]>,
  ) {
    const profile = yield* ensureProfile(customer.counterpartyRef);
    const memberships = byProfile.get(profile.profileRef.resourceId) ?? [];
    if (currentOf(memberships)?.groupRef.resourceId === target.ref.resourceId) {
      return { outcome: 'unchanged', partyId: customer.partyId } satisfies CustomerSegmentChange;
    }
    const effectiveAt = yield* nowIso;
    // End the other segment memberships first. One the user may not write stays VALID; a new, later
    // target membership still outranks it, but an older VALID target membership cannot.
    const others = memberships.filter((membership) => membership.groupRef.resourceId !== target.ref.resourceId);
    const removed = yield* Effect.forEach(
      others,
      (membership) =>
        viaOwner('remove', 'action', ({ config, options }) =>
          makeGovernedEffectBffClient({ api: RemoveApi, ...config }, options).pipe(
            Effect.flatMap((client) =>
              client.RemoveCustomerGroupAction.execute({
                payload: {
                  effectiveAt,
                  groupRef: membership.groupRef,
                  membershipRef: membership.membershipRef,
                  profile,
                  reason: REASON,
                },
              }),
            ),
          ),
        ).pipe(Effect.exit),
      { concurrency: 1 },
    );
    if (others.length < memberships.length) {
      return removed.every(Exit.isSuccess)
        ? ({ outcome: 'assigned', partyId: customer.partyId } satisfies CustomerSegmentChange)
        : ({
            outcome: 'failed',
            partyId: customer.partyId,
            reason: 'Původní segment nelze ukončit',
          } satisfies CustomerSegmentChange);
    }
    yield* viaOwner('assign', 'action', ({ config, options }) =>
      makeGovernedEffectBffClient({ api: AssignApi, ...config }, options).pipe(
        Effect.flatMap((client) =>
          client.AssignCustomerGroupAction.execute({
            payload: { effectiveFrom: effectiveAt, groupRef: target.ref, profile, reason: REASON },
          }),
        ),
      ),
    );
    return { outcome: 'assigned', partyId: customer.partyId } satisfies CustomerSegmentChange;
  },
  (effect, customer) =>
    effect.pipe(
      Effect.catchTag('CustomerSegmentsError', ({ reason }) =>
        Effect.succeed({ outcome: 'failed', partyId: customer.partyId, reason } satisfies CustomerSegmentChange),
      ),
    ),
);

/**
 * Moves each customer to the segment `groupId`, one customer at a time. Fails only when the segment
 * catalogue cannot be read; otherwise every customer gets its own `assigned | unchanged | failed` result
 * (failed carries the owner's problem detail).
 */
export const setCustomerSegment = Effect.fn('CustomerSegmentsClient.setCustomerSegment')(
  function* changeCustomerSegments(customers: readonly CustomerSegmentSubject[], groupId: CustomerSegmentGroupId) {
    const { byProfile, segments } = yield* segmentMemberships;
    const target = segments.get(groupId);
    if (target === undefined) {
      return customers.map(({ partyId }): CustomerSegmentChange => ({
        outcome: 'failed',
        partyId,
        reason: 'Neznámý segment',
      }));
    }
    return yield* Effect.forEach(customers, (customer) => changeSegment(customer, target, byProfile), {
      concurrency: 1,
    });
  },
);
