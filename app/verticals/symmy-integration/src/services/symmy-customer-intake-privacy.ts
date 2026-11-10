import { requireModuleOperation } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingIdentitySchema,
  SymmyCustomerSourceIntakeConsumerModule,
  SymmyCustomerSourceIntakeOperation,
} from '@app/privacy/api/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy/api/source-processing-eligibility';
import { executeSourceProcessingEligibilityWithAuthorization } from '@app/privacy/api/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Array as EffectArray, Crypto, Effect, Match, Option, Redacted, Schema } from 'effect';

import type { SymmyPinnedEffect, SymmyPinnedJobPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyPartyCommerceIntentSchema } from '../../shared/domain/symmy-party-commerce-intents.ts';
import type { SymmyPartyCommerceIntent } from '../../shared/domain/symmy-party-commerce-intents.ts';
import { projectSymmyOrganizationAcceptedEffect } from '../../shared/domain/symmy-source-organization-projections.ts';
import { SymmyJobStoreError } from '../persistence/symmy-job-store.ts';
import { symmyPartyCommerceIntentMatchesEffect } from './symmy-party-commerce-adapters.ts';

type Target = NonNullable<SourceProcessingEligibilityRequest['target']>;

const profileTarget = (ref: { readonly resourceId: string; readonly resourceType: string }): Target => ({
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
      AddSavedRetailAddressFromOwnerReceipts: () => null,
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
      AddSavedRetailAddressFromOwnerReceipts: ({ payload }) => payload.source?.identity ?? null,
      CreateCounterpartyProfileFromCounterparty: ({ payload }) => flattenProfileSource(payload.source),
      EnsureRetailProfileFromParty: ({ payload }) => flattenProfileSource(payload.source),
      OnboardCounterpartyCustomerFromParty: ({ payload }) => flattenSourceReference(payload.sourceReference),
    }),
    Match.orElse(() => 'DIRECT' as const),
  );

const unavailable = (cause?: unknown) => {
  const error = new SymmyJobStoreError({ code: 'unavailable' });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: Redacted.make(cause) });
};
const denied = () => new SymmyJobStoreError({ code: 'route_denied' });

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
  return yield* Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema)(request).pipe(
    Effect.mapError(unavailable),
    Effect.map(Option.some),
  );
});

const requestEquivalent = Schema.toEquivalence(SourceProcessingEligibilityRequestSchema);
const customerIntakePrivacyRequirement = 'integration.symmy.requirement.customer-intake-privacy';

/** The eligible source and owner target are the only input facts handed to Privacy. */
export const projectSymmyCustomerIntakeRequests = Effect.fn('SymmyCustomerIntakePrivacy.requests')(function* requests(
  scope: OperationalScope,
  plan: SymmyPinnedJobPlan,
) {
  const candidates = yield* Effect.forEach(
    plan.items.flatMap((item) => item.effects),
    (effect) => customerIntakeRequest(plan, effect, scope),
    { concurrency: 1 },
  );
  return EffectArray.dedupeWith(EffectArray.getSomes(candidates), requestEquivalent);
});

/** Checks the exact current use before C14 writes any new personal input. Native owners still recheck at dispatch. */
export const requireSymmyCustomerIntakePrivacy = Effect.fn('SymmyCustomerIntakePrivacy.require')(
  function* requirePrivacy(scope: OperationalScope, plan: SymmyPinnedJobPlan) {
    const requests = yield* projectSymmyCustomerIntakeRequests(scope, plan);
    if (requests.length === 0) {
      return yield* Effect.void;
    }
    if (scope.authMethod !== 'api_key' || scope.legalEntityId === undefined) {
      return yield* unavailable();
    }
    yield* requireModuleOperation(customerIntakePrivacyRequirement).pipe(Effect.mapError(unavailable));
    const crypto = yield* Crypto.Crypto;
    return yield* Effect.forEach(
      requests,
      Effect.fn('SymmyCustomerIntakePrivacy.check')(function* check(request) {
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
      { concurrency: 1, discard: true },
    );
  },
);
