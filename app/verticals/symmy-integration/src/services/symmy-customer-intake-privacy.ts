import { requireModuleOperation } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { OrganizationMembershipSourcePayloadSchema } from '@app/commerce-customer-context/domain/organization-membership-source';
import { OrganizationBusinessUpdateInputSchema } from '@app/party-registry/apis/organization-record-facts';
import {
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingIdentitySchema,
  SymmyCustomerSourceIntakeConsumerModule,
  SymmyCustomerSourceIntakeOperation,
} from '@app/privacy-contracts/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy-contracts/source-processing-eligibility';
import { executeSourceProcessingEligibilityWithAuthorization } from '@app/privacy-contracts/source-processing-eligibility/client';
import { executeAdmitSourceProcessingSubjectWithAuthorization } from '@app/privacy/api/client';
import type { AdmitSourceProcessingSubjectPayloadSchema } from '@app/privacy/api/admit-source-processing-subject-action';
import {
  AdmitSourceProcessingSubjectActionAlreadyCommittedProblemSchema,
  AdmitSourceProcessingSubjectActionConflictProblemSchema,
  AdmitSourceProcessingSubjectActionIneligibleProblemSchema,
} from '@app/privacy/api/admit-source-processing-subject-action';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Array as EffectArray, Crypto, Effect, Match, Option, Predicate, Redacted, Schema } from 'effect';

import type { SymmyPinnedEffect, SymmyPinnedJobPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyPartyCommerceIntentSchema } from '../../shared/domain/symmy-party-commerce-intents.ts';
import type { SymmyPartyCommerceIntent } from '../../shared/domain/symmy-party-commerce-intents.ts';
import { projectSymmyOrganizationAcceptedEffect } from '../../shared/domain/symmy-source-organization-projections.ts';
import { SymmyJobStoreError } from '../persistence/symmy-job-store.ts';
import { symmyPartyCommerceIntentMatchesEffect } from './symmy-party-commerce-adapters.ts';

type Target = NonNullable<SourceProcessingEligibilityRequest['target']>;

const profileTarget = (ref: {
  readonly resourceId: string;
  readonly resourceType: string;
}): NonNullable<AdmitSourceProcessingSubjectPayload['membershipProfile']> => ({
  kind:
    ref.resourceType === 'commerce.customer-context.retail-customer-profile'
      ? 'RETAIL_CUSTOMER_PROFILE'
      : 'COUNTERPARTY_PURCHASING_PROFILE',
  resourceId: ref.resourceId,
});

const partyTarget = (resourceId: string): Target => ({ kind: 'PARTY', resourceId });
const contactTarget = (resourceId: string): Target => ({ kind: 'PARTY_CONTACT_POINT', resourceId });
const target = (kind: Target['kind'], resourceId: string): Target => ({ kind, resourceId });

const processingTarget = (intent: SymmyPartyCommerceIntent): Target | null =>
  Match.value(intent).pipe(
    Match.tags({
      AddPartyContactPoint: ({ payload }) => partyTarget(payload.partyRef.resourceId),
      AddPartyContactPointFromParty: () => null,
      AddSavedAddress: ({ payload }) => profileTarget(payload.profile.profileRef),
      AddSavedCounterpartyAddressFromOwnerReceipts: () => null,
      AddSavedCounterpartyAddressFromProfileEffect: () => null,
      AddSavedRetailAddressFromOwnerReceipts: () => null,
      AddSavedRetailAddressFromProfileEffect: () => null,
      AssignCounterpartyPriceGroup: ({ payload }) =>
        target('COUNTERPARTY_PURCHASING_PROFILE', payload.profile.resourceId),
      AssignCustomerPriceGroup: ({ payload }) => target('RETAIL_CUSTOMER_PROFILE', payload.profile.resourceId),
      CreateCounterpartyProfile: ({ payload }) => target('COUNTERPARTY', payload.subject.counterpartyRef.resourceId),
      CreateCounterpartyProfileFromCounterparty: () => null,
      CustomerGroupCreate: () => null,
      CustomerGroupMembership: ({ payload }) => profileTarget(payload.profile.profileRef),
      CustomerGroupUpdate: () => null,
      CustomerProfileIco: ({ payload }) => profileTarget(payload.profileRef),
      EndPartyContactPoint: ({ payload }) => contactTarget(payload.contactPointRef.resourceId),
      EnsureRetailProfile: ({ payload }) => partyTarget(payload.subject.partyRef.resourceId),
      EnsureRetailProfileFromParty: () => null,
      OnboardCounterpartyCustomer: ({ payload }) => partyTarget(payload.partyRef.resourceId),
      OnboardCounterpartyCustomerFromParty: () => null,
      OrganizationCustomerProfileIco: ({ payload }) => profileTarget(payload.profileRef),
      OrganizationCustomerProfileIcoFromProfileEffect: () => null,
      PartyCorrect: ({ payload }) =>
        Match.value(payload).pipe(
          Match.when({ factKind: 'RELATIONSHIP' }, () => null),
          Match.orElse((command) => partyTarget(command.partyId)),
        ),
      PartyCreate: () => null,
      PartyMatch: ({ payload }) =>
        payload.priorCaseRef === undefined ? null : target('DUPLICATE_CANDIDATE', payload.priorCaseRef.resourceId),
      PartyUpdate: ({ payload }) => partyTarget(payload.partyRef.resourceId),
      RemoveSavedAddress: ({ payload }) => profileTarget(payload.profile.profileRef),
      UpdatePartyContactPoint: ({ payload }) => contactTarget(payload.contactPointRef.resourceId),
      UpdateSavedAddress: ({ payload }) => profileTarget(payload.profile.profileRef),
    }),
    Match.exhaustive,
  );

const sourcePersonReference = (intent: SymmyPartyCommerceIntent) =>
  Match.value(intent).pipe(
    Match.tags({
      CreateCounterpartyProfile: ({ payload }) => payload.partySourceReference,
      EnsureRetailProfile: ({ payload }) => payload.partySourceReference,
    }),
    Match.orElse(() => null),
  );

type Source = NonNullable<SourceProcessingEligibilityRequest['source']>;
const sourceEquivalent = Schema.toEquivalence(SourceProcessingIdentitySchema);
const flattenSourceReference = (
  reference: Extract<SymmyPartyCommerceIntent, { _tag: 'AddPartyContactPointFromParty' }>['payload']['sourceReference'],
): Source | null =>
  reference === undefined
    ? null
    : { ...reference.source, occurrenceId: reference.occurrenceId, recordId: reference.recordId };

const flattenProfileSource = (
  source: Extract<SymmyPartyCommerceIntent, { _tag: 'EnsureRetailProfileFromParty' }>['payload']['source'],
): Source | null =>
  source === undefined
    ? null
    : {
        issuer: source.issuer,
        namespace: source.namespace,
        occurrenceId: source.occurrenceId,
        recordId: source.recordId,
        recordType: source.recordType,
        routeRef: source.route.id,
      };

const deferredSource = (intent: SymmyPartyCommerceIntent): Source | null | 'DIRECT' =>
  Match.value(intent).pipe(
    Match.tags({
      AddPartyContactPointFromParty: ({ payload }) => flattenSourceReference(payload.sourceReference),
      AddSavedCounterpartyAddressFromOwnerReceipts: ({ payload }) => payload.source?.identity ?? null,
      AddSavedCounterpartyAddressFromProfileEffect: ({ payload }) => payload.source?.identity ?? null,
      AddSavedRetailAddressFromOwnerReceipts: ({ payload }) => payload.source?.identity ?? null,
      AddSavedRetailAddressFromProfileEffect: ({ payload }) => payload.source?.identity ?? null,
      CreateCounterpartyProfileFromCounterparty: ({ payload }) => flattenProfileSource(payload.source),
      EnsureRetailProfileFromParty: ({ payload }) => flattenProfileSource(payload.source),
      OnboardCounterpartyCustomerFromParty: ({ payload }) => flattenSourceReference(payload.sourceReference),
      OrganizationCustomerProfileIcoFromProfileEffect: ({ sourceReference }) => flattenSourceReference(sourceReference),
    }),
    Match.orElse(() => 'DIRECT' as const),
  );

const unavailable = (cause?: unknown) => {
  const error = new SymmyJobStoreError({ code: 'unavailable' });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: Redacted.make(cause) });
};
const denied = () => new SymmyJobStoreError({ code: 'route_denied' });

const rejectExtraFields = { onExcessProperty: 'error' } as const;
const organizationBusinessUse = (
  intent: SymmyPartyCommerceIntent,
): NonNullable<SourceProcessingEligibilityRequest['organizationBusinessUse']> | null => {
  if (Option.isNone(Schema.decodeUnknownOption(SymmyPartyCommerceIntentSchema, rejectExtraFields)(intent))) {
    return null;
  }
  return Match.value(intent).pipe(
    Match.tags({
      AssignCounterpartyPriceGroup: ({ payload }) =>
        payload.processingKind === 'ORGANIZATION_BUSINESS' ? ('PRICE_GROUP_ASSIGNMENT' as const) : null,
      CustomerGroupMembership: ({ payload }) =>
        Option.isSome(Schema.decodeUnknownOption(OrganizationMembershipSourcePayloadSchema, rejectExtraFields)(payload))
          ? ('GROUP_MEMBERSHIP' as const)
          : null,
      OrganizationCustomerProfileIco: () => 'COMPANY_ICO' as const,
      PartyUpdate: ({ payload }) =>
        Option.isSome(Schema.decodeUnknownOption(OrganizationBusinessUpdateInputSchema, rejectExtraFields)(payload))
          ? ('COMPANY_NAME' as const)
          : null,
    }),
    Match.orElse(() => null),
  );
};

const customerIntakeRequest = Effect.fn('SymmyCustomerIntakePrivacy.request')(function* projectRequest(
  plan: SymmyPinnedJobPlan,
  effect: SymmyPinnedEffect,
  scope: OperationalScope,
) {
  if (!Schema.is(SymmyPartyCommerceIntentSchema)(effect.intent)) {
    return Option.none<SourceProcessingEligibilityRequest>();
  }
  if (Option.isSome(yield* projectSymmyOrganizationAcceptedEffect(plan, effect))) {
    return Option.none<SourceProcessingEligibilityRequest>();
  }
  if (scope.legalEntityId === undefined) {
    return yield* unavailable();
  }
  const { occurrenceId, record } = effect.ref.occurrence;
  const source = {
    issuer: record.issuerId,
    namespace: record.sourceNamespace,
    occurrenceId,
    recordId: record.sourceRecordId,
    recordType: record.entityKind,
    routeRef: record.route.integrationRouteId,
  };
  const deferred = deferredSource(effect.intent);
  const matches =
    deferred === 'DIRECT'
      ? symmyPartyCommerceIntentMatchesEffect({ effect, legalEntityId: scope.legalEntityId }, effect.intent)
      : deferred !== null && sourceEquivalent(source, deferred);
  if (!matches) {
    return yield* denied();
  }
  if (
    record.entityKind === 'CUSTOMER_GROUP' &&
    Match.value(effect.intent).pipe(
      Match.tag('CustomerGroupCreate', 'CustomerGroupUpdate', () => true),
      Match.orElse(() => false),
    )
  ) {
    return Option.none<SourceProcessingEligibilityRequest>();
  }
  const reference = sourcePersonReference(effect.intent);
  const request = {
    consumerModuleId: SymmyCustomerSourceIntakeConsumerModule,
    operation: SymmyCustomerSourceIntakeOperation,
    source,
    target: processingTarget(effect.intent),
  };
  if (reference !== null && reference !== undefined) {
    Object.assign(request, { partySourceReference: reference });
  }
  const businessUse = organizationBusinessUse(effect.intent);
  if (businessUse !== null) {
    Object.assign(request, { organizationBusinessUse: businessUse });
  }
  return yield* Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema)(request).pipe(
    Effect.mapError(unavailable),
    Effect.map(Option.some),
  );
});

const requestEquivalent = Schema.toEquivalence(SourceProcessingEligibilityRequestSchema);
const customerIntakePrivacyRequirement = 'integration.symmy.requirement.customer-intake-privacy';
const customerIntakeAdmissionRequirement = 'integration.symmy.requirement.customer-intake-subject-admission';

type Item = SymmyPinnedJobPlan['items'][number];
type AdmitSourceProcessingSubjectPayload = typeof AdmitSourceProcessingSubjectPayloadSchema.Type;
type AdmittedSource = AdmitSourceProcessingSubjectPayload['source'];
const admissionAlreadyCommitted = Schema.is(AdmitSourceProcessingSubjectActionAlreadyCommittedProblemSchema);

const itemSource = (item: Item): AdmittedSource => {
  const { record } = item.effects[0].ref.occurrence;
  return {
    issuer: record.issuerId,
    namespace: record.sourceNamespace,
    recordId: record.sourceRecordId,
    recordType: record.entityKind,
    routeRef: record.route.integrationRouteId,
  };
};

const parentItemKeys = (item: Item): readonly string[] => [
  ...new Set(
    item.effects.flatMap((effect) =>
      (effect.dependsOn ?? []).flatMap((dependency) =>
        Predicate.isString(dependency) || dependency.itemKey === item.itemKey ? [] : [dependency.itemKey],
      ),
    ),
  ),
];

const itemsByKey = (plan: SymmyPinnedJobPlan) => new Map<string, Item>(plan.items.map((item) => [item.itemKey, item]));

/** Every prerequisite must reach one customer root. Array order never chooses which person an item describes. */
const rootItemOf = Effect.fn('SymmyCustomerIntakePrivacy.rootItem')(function* rootItem(
  byKey: ReadonlyMap<string, Item>,
  item: Item,
  seen: ReadonlySet<string> = new Set(),
): Effect.fn.Return<Item, SymmyJobStoreError> {
  if (seen.has(item.itemKey)) {
    return yield* denied();
  }
  const parents = parentItemKeys(item);
  if (parents.length === 0) {
    return item;
  }
  const visited = new Set([...seen, item.itemKey]);
  const roots = yield* Effect.forEach(
    parents,
    (key) => {
      const parent = byKey.get(key);
      return parent === undefined ? Effect.fail(denied()) : rootItemOf(byKey, parent, visited);
    },
    { concurrency: 1 },
  );
  const [root] = roots;
  if (root === undefined || roots.some((candidate) => candidate.itemKey !== root.itemKey)) {
    return yield* denied();
  }
  return root;
});

const sameSource = (left: AdmittedSource, right: AdmittedSource) =>
  computeCanonicalValueHash(left) === computeCanonicalValueHash(right);

/**
 * One admission per customer record: its own source and the child records (contacts, addresses) built on it. Two
 * customers never share a subject; a child always belongs to the root record it depends on.
 */
export const projectSymmyCustomerIntakeAdmissions = Effect.fn('SymmyCustomerIntakePrivacy.admissions')(
  function* admissions(plan: SymmyPinnedJobPlan, personalItemKeys: ReadonlySet<string>) {
    const byKey = itemsByKey(plan);
    const groups = new Map<string, { readonly children: Map<string, AdmittedSource>; readonly root: Item }>();
    yield* Effect.forEach(
      plan.items.filter(({ itemKey }) => personalItemKeys.has(itemKey)),
      Effect.fnUntraced(function* groupItem(item) {
        const root = yield* rootItemOf(byKey, item);
        const group = groups.get(root.itemKey) ?? { children: new Map<string, AdmittedSource>(), root };
        groups.set(root.itemKey, group);
        const source = itemSource(item);
        if (!sameSource(source, itemSource(root))) {
          group.children.set(computeCanonicalValueHash(source), source);
        }
      }),
      { concurrency: 1, discard: true },
    );
    return [...groups.values()].map(({ children, root }) => {
      const source = itemSource(root);
      const profiles = root.effects.flatMap(({ intent }) =>
        Schema.is(SymmyPartyCommerceIntentSchema)(intent)
          ? Match.value(intent).pipe(
              Match.tag('CustomerGroupMembership', (membership) => [
                profileTarget(membership.payload.profile.profileRef),
              ]),
              Match.orElse(() => []),
            )
          : [],
      );
      const payload: AdmitSourceProcessingSubjectPayload = { childSources: [...children.values()], source };
      if (source.recordType === 'CUSTOMER_GROUP_MEMBERSHIP' && profiles[0] !== undefined) {
        Object.assign(payload, { membershipProfile: profiles[0] });
      }
      return { occurrenceId: root.effects[0].ref.occurrence.occurrenceId, payload };
    });
  },
);

type Admission = Effect.Success<ReturnType<typeof projectSymmyCustomerIntakeAdmissions>>[number];

/** One governed Privacy admission. A replay of the job repeats the same admission; a new job is a new use. */
const admitSubject = Effect.fn('SymmyCustomerIntakePrivacy.admitSubject')(function* admitSubject(
  scope: OperationalScope,
  payload: AdmitSourceProcessingSubjectPayload,
  idempotencyKey: string,
  crypto: Crypto.Crypto,
) {
  const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
  const gateway = yield* acquireDelegatedGatewayContext(
    {
      audience: 'privacy',
      legalEntityScope: 'subject',
      requestCorrelation,
      subject: { _tag: 'Assertion', scope },
    },
    crypto,
  ).pipe(Effect.mapError(unavailable));
  return yield* executeAdmitSourceProcessingSubjectWithAuthorization(
    payload,
    gateway.authorization,
    requestCorrelation,
    {
      baseUrl: gateway.apiBaseUrl,
      compositionRevision: gateway.compositionRevision,
      idempotencyKey,
    },
  ).pipe(
    Effect.asVoid,
    Effect.catchIf(admissionAlreadyCommitted, () => Effect.void),
    Effect.mapError((cause) =>
      Schema.is(AdmitSourceProcessingSubjectActionConflictProblemSchema)(cause) ||
      Schema.is(AdmitSourceProcessingSubjectActionIneligibleProblemSchema)(cause)
        ? denied()
        : unavailable(cause),
    ),
  );
});

/** The two governed Privacy calls of one intake: the subject admission Action and the eligibility Read. */
export interface SymmyCustomerIntakePrivacyCalls {
  readonly admit: (
    payload: AdmitSourceProcessingSubjectPayload,
    idempotencyKey: string,
  ) => Effect.Effect<void, SymmyJobStoreError>;
  readonly check: (request: SourceProcessingEligibilityRequest) => Effect.Effect<void, SymmyJobStoreError>;
}

/**
 * The order that keeps a refused plan from leaving a binding behind:
 * 1. first contact creates or finds the Privacy subject of each customer record itself and binds no other record to it;
 * 2. Privacy checks every use of the plan, with the bindings of the plan only proposed;
 * 3. the immutable bindings (a contact, an address or a membership to its customer) are committed once every use is
 *    allowed. A replay of the job repeats the same admissions; a new job is a new use.
 */
export const settleSymmyCustomerIntake = Effect.fn('SymmyCustomerIntakePrivacy.settle')(function* settle(
  intake: {
    readonly admissions: readonly Admission[];
    readonly requests: readonly SourceProcessingEligibilityRequest[];
  },
  privacy: SymmyCustomerIntakePrivacyCalls,
) {
  yield* Effect.forEach(
    intake.admissions.filter(({ payload }) => payload.membershipProfile === undefined),
    ({ occurrenceId, payload }) =>
      privacy.admit({ childSources: [], source: payload.source }, `privacy-source-admission:${occurrenceId}:subject`),
    { concurrency: 1, discard: true },
  );
  yield* Effect.forEach(intake.requests, privacy.check, { concurrency: 1, discard: true });
  return yield* Effect.forEach(
    intake.admissions.filter(
      ({ payload }) => payload.membershipProfile !== undefined || payload.childSources.length > 0,
    ),
    ({ occurrenceId, payload }) => privacy.admit(payload, `privacy-source-admission:${occurrenceId}:records`),
    { concurrency: 1, discard: true },
  );
});

const itemRequests = Effect.fn('SymmyCustomerIntakePrivacy.itemRequests')(function* itemRequests(
  scope: OperationalScope,
  plan: SymmyPinnedJobPlan,
) {
  return yield* Effect.forEach(
    plan.items,
    (item) =>
      Effect.forEach(item.effects, (effect) => customerIntakeRequest(plan, effect, scope), { concurrency: 1 }).pipe(
        Effect.map((candidates) => ({ item, requests: EffectArray.getSomes(candidates) })),
      ),
    { concurrency: 1 },
  );
});

/** A canonical organization business intent keeps its exact Privacy context; only personal uses fall under the route. */
const isPersonalUse = (request: SourceProcessingEligibilityRequest) => request.organizationBusinessUse === undefined;

/**
 * The uses and admissions of one plan. A personal use of a contact or an address names the customer record it
 * describes, so Privacy evaluates it for that customer before the binding of the record is committed.
 */
export const projectSymmyCustomerIntake = Effect.fn('SymmyCustomerIntakePrivacy.project')(function* project(
  scope: OperationalScope,
  plan: SymmyPinnedJobPlan,
) {
  const items = yield* itemRequests(scope, plan);
  const byKey = itemsByKey(plan);
  const describedUses = yield* Effect.forEach(
    items,
    ({ item, requests: uses }) => {
      if (!uses.some(isPersonalUse)) {
        return Effect.succeed(uses);
      }
      return rootItemOf(byKey, item).pipe(
        Effect.map((root) => {
          const source = itemSource(item);
          const customer = itemSource(root);
          return uses.map((request) =>
            isPersonalUse(request) && !sameSource(source, customer)
              ? { ...request, describedSubjectSource: customer }
              : request,
          );
        }),
      );
    },
    { concurrency: 1 },
  );
  const requests = yield* Effect.forEach(
    describedUses.flat(),
    (request) =>
      Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema)(request).pipe(Effect.mapError(unavailable)),
    { concurrency: 1 },
  );
  return {
    admissions: yield* projectSymmyCustomerIntakeAdmissions(
      plan,
      new Set(items.flatMap(({ item, requests: uses }) => (uses.some(isPersonalUse) ? [item.itemKey] : []))),
    ),
    requests: EffectArray.dedupeWith(requests, requestEquivalent),
  };
});

/** The eligible source, the customer record it describes and the owner target are the only facts handed to Privacy. */
export const projectSymmyCustomerIntakeRequests = (scope: OperationalScope, plan: SymmyPinnedJobPlan) =>
  projectSymmyCustomerIntake(scope, plan).pipe(Effect.map(({ requests }) => requests));

/**
 * Admits each customer under the route's standing authorization and checks every exact use before C14 writes any new
 * personal input. Native owners still recheck at dispatch.
 */
export const requireSymmyCustomerIntakePrivacy = Effect.fn('SymmyCustomerIntakePrivacy.require')(
  function* requirePrivacy(scope: OperationalScope, plan: SymmyPinnedJobPlan) {
    const intake = yield* projectSymmyCustomerIntake(scope, plan);
    if (intake.requests.length === 0) {
      return yield* Effect.void;
    }
    if (scope.authMethod !== 'api_key' || scope.legalEntityId === undefined) {
      return yield* unavailable();
    }
    yield* requireModuleOperation(customerIntakePrivacyRequirement).pipe(Effect.mapError(unavailable));
    if (intake.admissions.length > 0) {
      yield* requireModuleOperation(customerIntakeAdmissionRequirement).pipe(Effect.mapError(unavailable));
    }
    const crypto = yield* Crypto.Crypto;
    return yield* settleSymmyCustomerIntake(intake, {
      admit: (payload, idempotencyKey) => admitSubject(scope, payload, idempotencyKey, crypto),
      check: Effect.fn('SymmyCustomerIntakePrivacy.check')(function* check(request) {
        const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
        const gateway = yield* acquireDelegatedGatewayContext(
          {
            audience: 'privacy',
            legalEntityScope: 'subject',
            requestCorrelation,
            subject: { _tag: 'Assertion', scope },
          },
          crypto,
        ).pipe(Effect.mapError(unavailable));
        const outcome = yield* executeSourceProcessingEligibilityWithAuthorization(
          request,
          gateway.authorization,
          requestCorrelation,
          { baseUrl: gateway.apiBaseUrl, compositionRevision: gateway.compositionRevision },
        ).pipe(Effect.mapError(unavailable));
        if (outcome.outcome === 'DENIED') {
          return yield* outcome.reason === 'AUTHORITY_NOT_CURRENT' ? unavailable() : denied();
        }
        return yield* Effect.void;
      }),
    });
  },
);
