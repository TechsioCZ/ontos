import { ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema } from '@app/commerce-customer-context/api/change-organization-customer-profile-ico-action';
import {
  ChangeOrganizationCustomerProfileIcoPayloadSchema,
  ChangeOrganizationCustomerProfileIcoResultSchema,
  OrganizationCustomerProfileIcoRequestSchema,
} from '@app/commerce-customer-context/domain/organization-profile-ico';
import { executeChangeOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/change-organization-customer-profile-ico-action/client';
import { executeOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/organization-customer-profile-ico/client';
import { normalizeOfficialIdentifier } from '@app/party-registry/domain/identifier-contracts';
import { CustomerGroupRefSchema } from '@app/commerce-customer-context/resources/customer-group';
import { OrganizationProfileSourceReceiptSchema } from '@app/commerce-customer-context/domain/organization-profile-source';
import { projectSymmyOrganizationAcceptedEffect } from '../../shared/domain/symmy-source-organization-projections.ts';
import { SymmySourceOrganizationWitnessSchema } from '@app/shared-contracts/symmy/organization-source-witness';
import { AddSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/add-saved-address-action';
import { UpdateSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/update-saved-address-action';
import { RemoveSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/remove-saved-address-action';
import { executeAddSavedAddressWithAuthorization } from '@app/commerce-customer-context/api/add-saved-address-action/client';
import { executeUpdateSavedAddressWithAuthorization } from '@app/commerce-customer-context/api/update-saved-address-action/client';
import { executeRemoveSavedAddressWithAuthorization } from '@app/commerce-customer-context/api/remove-saved-address-action/client';
import type { SavedAddressSourceReceiptResponse } from '@app/commerce-customer-context/api/saved-address-source-receipt';
import { SavedAddressSourceReceiptRequestSchema } from '@app/commerce-customer-context/api/saved-address-source-receipt';
import { executeSavedAddressSourceReceiptWithAuthorization } from '@app/commerce-customer-context/api/saved-address-source-receipt/client';
import { symmyOwnerOperationRequirementKey } from '../../shared/domain/symmy-owner-operation-requirements.ts';
import { RegisteredGatewayRecoverySchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import { computeActionRequestHash, computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  createPartyRequestIdentity,
  matchPartyRequestIdentity,
  updatePartyRequestIdentity,
  correctPartyFactRequestIdentity,
  counterpartyCustomerOnboardRequestIdentity,
  addContactPointRequestIdentity,
  updateContactPointRequestIdentity,
  endContactPointRequestIdentity,
} from '@app/party-registry/api/native-action-request-identity';
import {
  createCustomerGroupRequestIdentity,
  updateCustomerGroupRequestIdentity,
  ensureRetailCustomerProfileRequestIdentity,
  createCounterpartyPurchasingProfileRequestIdentity,
  applyCustomerGroupMembershipSourceRequestIdentity,
  changeCustomerProfileIcoRequestIdentity,
  changeOrganizationCustomerProfileIcoRequestIdentity,
  assignCustomerPriceGroupRequestIdentity,
  assignCounterpartyPriceGroupRequestIdentity,
  addSavedAddressRequestIdentity,
  updateSavedAddressRequestIdentity,
  removeSavedAddressRequestIdentity,
} from '@app/commerce-customer-context/domain/native-action-request-identity';
import type { CreatePartyResultSchema, MatchPartyResultSchema } from '@app/party-registry/api';
import {
  AddContactPointPayloadSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  EndContactPointPayloadSchema,
  UpdateContactPointPayloadSchema,
  CorrectPartyFactPayloadSchema,
  CreatePartyPayloadSchema,
  MatchPartyPayloadSchema,
  ResolvePartyCommandCommitPayloadSchema,
  UpdatePartyPayloadSchema,
} from '@app/party-registry/api';
import {
  addContactPointWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
  endContactPointWithAuthorization,
  updateContactPointWithAuthorization,
  correctPartyFactWithAuthorization,
  createPartyWithAuthorization,
  matchPartyWithAuthorization,
  updatePartyWithAuthorization,
} from '@app/party-registry/api/client';
import { PartySourceEffectReceiptRequestSchema } from '@app/party-registry/apis/party-source-effect-receipt';
import { executePartySourceEffectReceiptWithAuthorization } from '@app/party-registry/apis/party-source-effect-receipt/client';
import { CustomerPriceGroupAssignmentReceiptRequestSchema } from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt';
import type { CustomerPriceGroupAssignmentReceiptResponse } from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt';
import { executeCustomerPriceGroupAssignmentReceiptWithAuthorization } from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt/client';
import { AssignCustomerPriceGroupPayloadSchema } from '@app/commerce-customer-context/api/assign-customer-price-group-action';
import { AssignCounterpartyPriceGroupPayloadSchema } from '@app/commerce-customer-context/api/assign-counterparty-price-group-action';
import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import { ChangeCustomerProfileIcoPayloadSchema } from '@app/commerce-customer-context/api/change-customer-profile-ico-action';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '@app/commerce-customer-context/api/create-counterparty-purchasing-profile-action';
import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { EnsureRetailCustomerProfilePayloadSchema } from '@app/commerce-customer-context/api/ensure-retail-customer-profile-action';
import {
  UpdateCustomerGroupActionIneligibleProblemSchema,
  UpdateCustomerGroupPayloadSchema,
} from '@app/commerce-customer-context/api/update-customer-group-action';
import {
  executeApplyCustomerGroupMembershipSourceWithAuthorization,
  executeAssignCustomerPriceGroupWithAuthorization,
  executeAssignCounterpartyPriceGroupWithAuthorization,
  executeChangeCustomerProfileIcoWithAuthorization,
  executeCreateCounterpartyPurchasingProfileWithAuthorization,
  executeCreateCustomerGroupWithAuthorization,
  executeEnsureRetailCustomerProfileWithAuthorization,
  executeUpdateCustomerGroupWithAuthorization,
} from '@app/commerce-customer-context/api/client';
import { CustomerGroupDefinitionSourceRequestSchema } from '@app/commerce-customer-context/api/customer-group-definition-source';
import { executeCustomerGroupDefinitionSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-group-definition-source/client';
import { CustomerGroupMembershipSourceReceiptRequestSchema } from '@app/commerce-customer-context/api/customer-group-membership-source-receipt';
import { executeCustomerGroupMembershipSourceReceiptWithAuthorization } from '@app/commerce-customer-context/api/customer-group-membership-source-receipt/client';
import { CustomerProfileSourceRequestSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import type { CustomerProfileSourceResponse } from '@app/commerce-customer-context/api/customer-profile-source';
import { executeCustomerProfileSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-source/client';
import { CustomerProfileIcoRequestSchema } from '@app/commerce-customer-context/api/customer-profile-ico';
import type { CustomerProfileIcoResponseSchema } from '@app/commerce-customer-context/api/customer-profile-ico';
import type { CustomerGroupDefinitionSourceResponse } from '@app/commerce-customer-context/api/customer-group-definition-source';
import { executeCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-ico/client';
import {
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingEligibilityResponseSchema,
} from '@app/privacy/api/source-processing-eligibility';
import { executeSourceProcessingEligibilityWithAuthorization } from '@app/privacy/api/client';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { SymmyEffectOutcomeSchema } from '@app/shared-contracts/symmy';
import { Config, Context, Crypto, Effect, Layer, Match, Option, Schema, Struct } from 'effect';

import {
  SymmyPartyCommerceIntentSchema,
  SymmyPartyCommerceOwnerReceiptSchema,
  resolveSymmyRetailProfileParty,
  resolveSymmyCounterpartyOnboardParty,
  resolveSymmyContactPointParty,
  resolveSymmyCounterpartyProfileCounterparty,
  resolveSymmyRetailSavedAddress,
  resolveSymmyCounterpartySavedAddress,
} from '../../shared/domain/symmy-party-commerce-intents.ts';
import type { SymmyPartyCommerceIntent } from '../../shared/domain/symmy-party-commerce-intents.ts';
import { SymmyPinnedEffectSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyEffectAdapter, SymmyEffectAdapterInput } from './symmy-effect-adapters.service.ts';
import { symmyJobWorkerUnavailable } from './symmy-job-worker-error.ts';

const DiagnosticFailureSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,99}$/u))),
  status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 400 }))),
});
const traceProfileStage = Effect.fn('SymmyPartyCommerceAdapters.traceProfileStage')(function* traceProfileStage(
  stage: string,
  detail: Option.Option<typeof DiagnosticFailureSchema.Type> = Option.none(),
) {
  const enabled = yield* Config.Boolean('ONTOS_C14_TRACE_PROBLEMS').pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );
  if (!enabled) {
    return yield* Effect.void;
  }
  if (Option.isSome(detail)) {
    return yield* Effect.logWarning({
      boundary: 'symmy-retail-profile',
      failureTag: detail.value._tag ?? 'unclassified',
      stage,
      status: detail.value.status ?? 0,
    });
  }
  return yield* Effect.logWarning({ boundary: 'symmy-retail-profile', stage });
});

const createPartyActionKey = 'party.registry.create-party';
const party = 'party.registry';
const commerce = 'commerce.customer-context';
const operations = [
  {
    declaration: 'party.registry.party.create',
    entrypointKey: createPartyActionKey,
    moduleId: party,
    tag: 'PartyCreate',
  },
  {
    declaration: 'party.registry.party-match.record',
    entrypointKey: 'party.registry.match-party',
    moduleId: party,
    tag: 'PartyMatch',
  },
  {
    declaration: 'party.registry.party.update',
    entrypointKey: 'party.registry.update-party',
    moduleId: party,
    tag: 'PartyUpdate',
  },
  {
    declaration: 'party.registry.party-fact.correct',
    entrypointKey: 'party.registry.correct-party-fact',
    moduleId: party,
    tag: 'PartyCorrect',
  },
  {
    declaration: 'commerce.customer-context.customer-group.create',
    entrypointKey: 'commerce.customer-context.create-customer-group',
    moduleId: commerce,
    tag: 'CustomerGroupCreate',
  },
  {
    declaration: 'commerce.customer-context.customer-group.update',
    entrypointKey: 'commerce.customer-context.update-customer-group',
    moduleId: commerce,
    tag: 'CustomerGroupUpdate',
  },
  {
    declaration: 'commerce.customer-context.customer-group-membership-source.apply',
    entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
    moduleId: commerce,
    tag: 'CustomerGroupMembership',
  },
  {
    declaration: 'commerce.customer-context.customer-profile-ico.change',
    entrypointKey: 'commerce.customer-context.change-customer-profile-ico',
    moduleId: commerce,
    tag: 'CustomerProfileIco',
  },
  {
    declaration: 'commerce.customer-context.retail-customer-profile.ensure',
    entrypointKey: 'commerce.customer-context.ensure-retail-customer-profile',
    moduleId: commerce,
    tag: 'EnsureRetailProfile',
  },
  {
    declaration: 'commerce.customer-context.counterparty-purchasing-profile.create',
    entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
    moduleId: commerce,
    tag: 'CreateCounterpartyProfile',
  },
  {
    declaration: 'commerce.customer-context.customer-price-group.assign',
    entrypointKey: 'commerce.customer-context.assign-customer-price-group',
    moduleId: commerce,
    tag: 'AssignCustomerPriceGroup',
  },
  {
    declaration: 'commerce.customer-context.counterparty-price-group.assign',
    entrypointKey: 'commerce.customer-context.assign-counterparty-price-group',
    moduleId: commerce,
    tag: 'AssignCounterpartyPriceGroup',
  },

  {
    declaration: 'party.registry.counterparty.onboard',
    entrypointKey: 'party.registry.counterparty-customer-onboard',
    moduleId: party,
    tag: 'OnboardCounterpartyCustomer',
  },
  {
    declaration: 'party.registry.contact-point.add',
    entrypointKey: 'party.registry.add-contact-point',
    moduleId: party,
    tag: 'AddPartyContactPoint',
  },
  {
    declaration: 'party.registry.contact-point.update',
    entrypointKey: 'party.registry.update-contact-point',
    moduleId: party,
    tag: 'UpdatePartyContactPoint',
  },
  {
    declaration: 'party.registry.contact-point.end',
    entrypointKey: 'party.registry.end-contact-point',
    moduleId: party,
    tag: 'EndPartyContactPoint',
  },
  {
    declaration: 'commerce.customer-context.saved-address.add',
    entrypointKey: 'commerce.customer-context.add-saved-address',
    moduleId: commerce,
    tag: 'AddSavedAddress',
  },
  {
    declaration: 'commerce.customer-context.saved-address.update',
    entrypointKey: 'commerce.customer-context.update-saved-address',
    moduleId: commerce,
    tag: 'UpdateSavedAddress',
  },
  {
    declaration: 'commerce.customer-context.saved-address.remove',
    entrypointKey: 'commerce.customer-context.remove-saved-address',
    moduleId: commerce,
    tag: 'RemoveSavedAddress',
  },
  {
    declaration: 'commerce.customer-context.organization-customer-profile-ico.change',
    entrypointKey: 'commerce.customer-context.change-organization-customer-profile-ico',
    moduleId: commerce,
    tag: 'OrganizationCustomerProfileIco',
  },
] as const;

type Operation = (typeof operations)[number];
type IntentScope = Pick<SymmyEffectAdapterInput, 'effect' | 'legalEntityId'>;
type Status = Exclude<(typeof SymmyEffectOutcomeSchema.Type)['status'], 'duplicate' | 'unsupported' | 'unavailable'>;
const outcome = (input: SymmyEffectAdapterInput, status: Status) =>
  Schema.decodeUnknownEffect(SymmyEffectOutcomeSchema)({
    effectId: input.effect.ref.effectId,
    owner: input.effect.ref.operation.moduleId,
    status,
  }).pipe(Effect.mapError(symmyJobWorkerUnavailable));

const sourceMatches = (
  input: IntentScope,
  source: {
    readonly issuer: string;
    readonly namespace: string;
    readonly recordType: string;
    readonly routeRef: string;
  },
  recordId: string,
  occurrenceId: string,
) => {
  const original = input.effect.ref.occurrence;
  return (
    source.issuer === original.record.issuerId &&
    source.namespace === original.record.sourceNamespace &&
    source.recordType === original.record.entityKind &&
    source.routeRef === original.record.route.integrationRouteId &&
    recordId === original.record.sourceRecordId &&
    occurrenceId === original.occurrenceId
  );
};

const partyEvidenceMatches = (
  input: IntentScope,
  evidence:
    | readonly {
        readonly kind: string;
        readonly occurrenceId?: string;
        readonly recordId?: string;
        readonly source?: {
          readonly issuer: string;
          readonly namespace: string;
          readonly recordType: string;
          readonly routeRef: string;
        };
      }[]
    | undefined,
) =>
  evidence !== undefined &&
  evidence.length > 0 &&
  evidence.every(
    (item) =>
      item.kind === 'CLIENT_SOURCE_ASSERTION' &&
      item.source !== undefined &&
      item.recordId !== undefined &&
      item.occurrenceId !== undefined &&
      sourceMatches(input, item.source, item.recordId, item.occurrenceId),
  );

const targetMatches = (input: IntentScope, target: { readonly resourceId: string; readonly tenantId: string }) =>
  input.effect.ref.originalTarget !== undefined &&
  input.effect.ref.originalTarget.resourceId === target.resourceId &&
  input.effect.ref.originalTarget.tenantId === target.tenantId &&
  target.tenantId === input.effect.ref.occurrence.record.route.tenantId;

const groupSourceMatches = (
  input: IntentScope,
  source: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerGroupCreate' }>['payload']['source'],
) => {
  const original = input.effect.ref;
  return (
    source !== undefined &&
    source.effectId === original.effectId &&
    source.issuer === original.occurrence.record.issuerId &&
    source.namespace === original.occurrence.record.sourceNamespace &&
    source.recordId === original.occurrence.record.sourceRecordId &&
    source.route.id === original.occurrence.record.route.integrationRouteId &&
    source.route.revision === original.routeRevision &&
    source.mappingRevision === original.mappingVersion
  );
};
const membershipSourceMatches = (
  input: IntentScope,
  payload: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerGroupMembership' }>['payload'],
) => {
  const original = input.effect.ref;
  return (
    payload.source.effectId === original.effectId &&
    payload.source.sourceRecordId === original.occurrence.record.sourceRecordId &&
    payload.source.assertionId === original.occurrence.occurrenceId &&
    payload.manager.tenantId === original.occurrence.record.route.tenantId &&
    payload.manager.issuer === original.occurrence.record.issuerId &&
    payload.manager.sourceNamespace === original.occurrence.record.sourceNamespace &&
    payload.route.id === original.occurrence.record.route.integrationRouteId &&
    payload.route.revision === original.routeRevision
  );
};
const profileSourceMatches = (
  input: IntentScope,
  source: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'EnsureRetailProfile' }>['payload']['source'],
) =>
  source !== undefined &&
  source.effectId === input.effect.ref.effectId &&
  source.mappingRevision === input.effect.ref.mappingVersion &&
  source.route.revision === input.effect.ref.routeRevision &&
  sourceMatches(
    input,
    {
      issuer: source.issuer,
      namespace: source.namespace,
      recordType: source.recordType,
      routeRef: source.route.id,
    },
    source.recordId,
    source.occurrenceId,
  );

const lifecycleSourceMatches = (
  input: IntentScope,
  sourceReference: Extract<
    SymmyPartyCommerceIntent,
    { readonly _tag: 'AddPartyContactPoint' }
  >['payload']['sourceReference'],
) =>
  sourceReference !== undefined &&
  sourceMatches(input, sourceReference.source, sourceReference.recordId, sourceReference.occurrenceId);
const partyCreationTargetMatches = (
  input: IntentScope,
  partyRef: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddPartyContactPoint' }>['payload']['partyRef'],
) =>
  partyRef.tenantId === input.effect.ref.occurrence.record.route.tenantId &&
  (input.effect.ref.originalTarget === undefined || targetMatches(input, partyRef));

const addressSourceMatches = (
  input: IntentScope,
  source: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddSavedAddress' }>['payload']['source'],
) => {
  if (source === undefined || source.identity === null) {
    return false;
  }
  return (
    sourceMatches(input, source.identity, source.identity.recordId, source.identity.occurrenceId) &&
    source.effectId === input.effect.ref.effectId &&
    source.mappingRevision === input.effect.ref.mappingVersion &&
    source.routeRevision === input.effect.ref.routeRevision
  );
};

/** Reject mismatched evidence before acquiring any owner credential or invoking a business Action. */
export const symmyPartyCommerceIntentMatchesEffect = (input: IntentScope, intent: SymmyPartyCommerceIntent): boolean =>
  Match.value(intent).pipe(
    Match.tags({
      AddPartyContactPoint: ({ payload }) =>
        lifecycleSourceMatches(input, payload.sourceReference) && partyCreationTargetMatches(input, payload.partyRef),
      AddPartyContactPointFromParty: () => false,
      AddSavedAddress: ({ payload }) =>
        input.effect.ref.originalTarget === undefined &&
        addressSourceMatches(input, payload.source) &&
        payload.profile.profileRef.tenantId === input.effect.ref.occurrence.record.route.tenantId,
      AddSavedCounterpartyAddressFromOwnerReceipts: () => false,
      AddSavedRetailAddressFromOwnerReceipts: () => false,
      AssignCounterpartyPriceGroup: ({ authorizationSubject, payload }) =>
        targetMatches(input, payload.profile) &&
        profileSourceMatches(input, payload.source) &&
        payload.priceGroupRef.tenantId === input.effect.ref.occurrence.record.route.tenantId &&
        authorizationSubject.kind === 'COUNTERPARTY' &&
        authorizationSubject.counterpartyRef.resourceId === payload.counterpartyRef.resourceId &&
        authorizationSubject.counterpartyRef.tenantId === payload.profile.tenantId,
      AssignCustomerPriceGroup: ({ authorizationSubject, payload }) =>
        targetMatches(input, payload.profile) &&
        profileSourceMatches(input, payload.source) &&
        payload.priceGroupRef.tenantId === input.effect.ref.occurrence.record.route.tenantId &&
        authorizationSubject.kind === 'RETAIL',
      CreateCounterpartyProfile: ({ payload }) =>
        input.effect.ref.originalTarget === undefined &&
        profileSourceMatches(input, payload.source) &&
        payload.trigger === 'AUTHORIZED_ONBOARDING' &&
        payload.subject.counterpartyRef.tenantId === input.effect.ref.occurrence.record.route.tenantId &&
        payload.subject.sellingLegalEntityRef?.resourceId === input.legalEntityId,
      CreateCounterpartyProfileFromCounterparty: () => false,
      CustomerGroupCreate: ({ payload }) =>
        input.effect.ref.originalTarget === undefined && groupSourceMatches(input, payload.source),
      CustomerGroupMembership: ({ payload }) =>
        targetMatches(input, payload.profile.profileRef) && membershipSourceMatches(input, payload),
      CustomerGroupUpdate: ({ payload }) =>
        targetMatches(input, payload.groupRef) && groupSourceMatches(input, payload.source),
      CustomerProfileIco: ({ payload }) =>
        payload.provenance.sourceContext !== null &&
        payload.effectId === input.effect.ref.effectId &&
        sourceMatches(
          input,
          payload.provenance.sourceContext,
          payload.provenance.sourceContext.recordId,
          payload.provenance.sourceContext.occurrenceId,
        ) &&
        targetMatches(input, payload.profileRef),
      EndPartyContactPoint: ({ payload }) =>
        lifecycleSourceMatches(input, payload.sourceReference) && targetMatches(input, payload.contactPointRef),
      EnsureRetailProfile: ({ payload }) =>
        input.effect.ref.originalTarget === undefined &&
        profileSourceMatches(input, payload.source) &&
        payload.trigger === 'AUTHORIZED_ONBOARDING' &&
        payload.subject.partyRef.tenantId === input.effect.ref.occurrence.record.route.tenantId &&
        payload.subject.sellingLegalEntityRef.resourceId === input.legalEntityId,
      EnsureRetailProfileFromParty: () => false,
      OnboardCounterpartyCustomer: ({ payload }) =>
        lifecycleSourceMatches(input, payload.sourceReference) &&
        partyCreationTargetMatches(input, payload.partyRef) &&
        input.legalEntityId !== undefined,
      OnboardCounterpartyCustomerFromParty: () => false,
      OrganizationCustomerProfileIco: ({ payload, sourceReference }) =>
        payload.effectId === input.effect.ref.effectId &&
        targetMatches(input, payload.profileRef) &&
        input.effect.ref.originalTarget?.moduleId === payload.profileRef.moduleId &&
        input.effect.ref.originalTarget.resourceType === payload.profileRef.resourceType &&
        sourceMatches(input, sourceReference.source, sourceReference.recordId, sourceReference.occurrenceId),
      PartyCorrect: ({ payload }) =>
        Match.value(payload).pipe(
          Match.when({ factKind: 'RELATIONSHIP' }, () => false),
          Match.orElse(
            (command) =>
              command.factKind !== 'OFFICIAL_IDENTIFIER' &&
              input.effect.ref.originalTarget?.resourceId === command.partyId &&
              partyEvidenceMatches(input, command.subjectEvidence),
          ),
        ),
      PartyCreate: ({ payload }) =>
        input.effect.ref.originalTarget === undefined &&
        payload.candidate.officialIdentifiers.every((identifier) => identifier.identifierType !== 'ICO') &&
        partyEvidenceMatches(input, payload.candidate.subjectEvidence),
      PartyMatch: ({ payload }) =>
        input.effect.ref.originalTarget === undefined &&
        payload.candidate.officialIdentifiers.every((identifier) => identifier.identifierType !== 'ICO') &&
        partyEvidenceMatches(input, payload.candidate.subjectEvidence),
      PartyUpdate: ({ payload }) =>
        targetMatches(input, payload.partyRef) && partyEvidenceMatches(input, payload.subjectEvidence),
      RemoveSavedAddress: ({ payload }) =>
        targetMatches(input, payload.savedAddressRef) && addressSourceMatches(input, payload.source),
      UpdatePartyContactPoint: ({ payload }) =>
        lifecycleSourceMatches(input, payload.sourceReference) && targetMatches(input, payload.contactPointRef),
      UpdateSavedAddress: ({ payload }) =>
        targetMatches(input, payload.savedAddressRef) && addressSourceMatches(input, payload.source),
    }),
    Match.exhaustive,
  );

const invocationErrorSchema = Schema.Struct({
  invocationId: ResolvePartyCommandCommitPayloadSchema.fields.invocationId,
});
const ownerFailureSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Number),
});
const ownerFailure = Effect.fn('SymmyPartyCommerceAdapters.ownerFailure')(function* ownerFailure(
  input: SymmyEffectAdapterInput,
  cause: unknown,
) {
  if (
    Schema.is(UpdateCustomerGroupActionIneligibleProblemSchema)(cause) &&
    cause.code === 'customer_group_definition_change_requires_new_group'
  ) {
    return yield* outcome(input, 'conflict');
  }
  if (Schema.is(ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema)(cause)) {
    if (Schema.is(Schema.Literals(['MIGRATION_REQUIRED', 'AUTHORITY_NOT_FENCED']))(cause.code)) {
      return yield* Schema.decodeUnknownEffect(SymmyEffectOutcomeSchema)({
        owner: commerce,
        reason: 'missing_context',
        status: 'unsupported',
      }).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    }
    return yield* outcome(input, cause.code === 'INVALID_TRANSITION' ? 'conflict' : 'denied');
  }
  const invocation = Schema.decodeUnknownOption(invocationErrorSchema)(cause);
  if (Option.isSome(invocation)) {
    yield* input.recordInvocationId(invocation.value.invocationId);
    return yield* symmyJobWorkerUnavailable(cause);
  }
  const failure = Schema.decodeUnknownOption(ownerFailureSchema)(cause);
  if (Option.isSome(failure)) {
    const { code, status } = failure.value;
    if (status === 401 || status === 403) {
      return yield* outcome(input, 'denied');
    }
    if (status === 404) {
      return yield* outcome(input, 'unresolved');
    }
    if (code === 'SOURCE_STALE' || code === 'customer_group_source_stale') {
      return yield* outcome(input, 'stale');
    }
    if (status === 409) {
      return yield* outcome(input, 'conflict');
    }
  }
  return yield* symmyJobWorkerUnavailable(cause);
});

export const SymmyPartyCommerceRequestScopeSchema = Schema.Struct({
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
export type SymmyPartyCommerceRequestScope = typeof SymmyPartyCommerceRequestScopeSchema.Encoded;
const nativeIdentityForIntent = (intent: SymmyPartyCommerceIntent) =>
  Match.value(intent).pipe(
    Match.tags({
      AddPartyContactPoint: (selected) => addContactPointRequestIdentity(selected.payload),
      AddPartyContactPointFromParty: () => Effect.fail(symmyJobWorkerUnavailable()),
      AddSavedAddress: (selected) => addSavedAddressRequestIdentity(selected.payload),
      AddSavedCounterpartyAddressFromOwnerReceipts: () => Effect.fail(symmyJobWorkerUnavailable()),
      AddSavedRetailAddressFromOwnerReceipts: () => Effect.fail(symmyJobWorkerUnavailable()),
      AssignCounterpartyPriceGroup: (selected) => assignCounterpartyPriceGroupRequestIdentity(selected.payload),
      AssignCustomerPriceGroup: (selected) => assignCustomerPriceGroupRequestIdentity(selected.payload),
      CreateCounterpartyProfile: (selected) => createCounterpartyPurchasingProfileRequestIdentity(selected.payload),
      CreateCounterpartyProfileFromCounterparty: () => Effect.fail(symmyJobWorkerUnavailable()),
      CustomerGroupCreate: (selected) => createCustomerGroupRequestIdentity(selected.payload),
      CustomerGroupMembership: (selected) => applyCustomerGroupMembershipSourceRequestIdentity(selected.payload),
      CustomerGroupUpdate: (selected) => updateCustomerGroupRequestIdentity(selected.payload),
      CustomerProfileIco: (selected) => changeCustomerProfileIcoRequestIdentity(selected.payload),
      EndPartyContactPoint: (selected) => endContactPointRequestIdentity(selected.payload),
      EnsureRetailProfile: (selected) => ensureRetailCustomerProfileRequestIdentity(selected.payload),
      EnsureRetailProfileFromParty: () => Effect.fail(symmyJobWorkerUnavailable()),
      OnboardCounterpartyCustomer: (selected) => counterpartyCustomerOnboardRequestIdentity(selected.payload),
      OnboardCounterpartyCustomerFromParty: () => Effect.fail(symmyJobWorkerUnavailable()),
      OrganizationCustomerProfileIco: (selected) =>
        changeOrganizationCustomerProfileIcoRequestIdentity(selected.payload),
      PartyCorrect: (selected) => correctPartyFactRequestIdentity(selected.payload),
      PartyCreate: (selected) => createPartyRequestIdentity(selected.payload),
      PartyMatch: (selected) => matchPartyRequestIdentity(selected.payload),
      PartyUpdate: (selected) => updatePartyRequestIdentity(selected.payload),
      RemoveSavedAddress: (selected) => removeSavedAddressRequestIdentity(selected.payload),
      UpdatePartyContactPoint: (selected) => updateContactPointRequestIdentity(selected.payload),
      UpdateSavedAddress: (selected) => updateSavedAddressRequestIdentity(selected.payload),
    }),
    Match.exhaustive,
  );

/** Uses the provider's actual native normalization/target and Core's canonical hash; no authority is created. */
export const prepareSymmyPartyCommerceRequestHash = Effect.fn('SymmyPartyCommerceAdapters.prepareNativeHash')(
  function* prepareSymmyPartyCommerceRequestHash(
    intent: SymmyPartyCommerceIntent,
    scope: SymmyPartyCommerceRequestScope,
  ) {
    const identity = yield* nativeIdentityForIntent(intent).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const principal = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceRequestScopeSchema)(scope).pipe(
      Effect.mapError(symmyJobWorkerUnavailable),
    );
    return yield* Effect.try({
      catch: symmyJobWorkerUnavailable,
      try: () => computeActionRequestHash({ ...identity, principal }),
    });
  },
);

interface RegisteredSubjectContext {
  declarationKey: string;
  expectedPrincipalId?: string;
  legalEntityId?: string;
  operationRequirementKey: string;
}
const freshOwnerContext = Effect.fn('SymmyPartyCommerceAdapters.freshContext')(function* freshOwnerContext(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  declarationKey: string,
  moduleId: string,
  write: boolean,
  intent?: SymmyPartyCommerceIntent,
  providerEntrypointKey?: string,
) {
  if (moduleId === commerce && input.legalEntityId === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const common: RegisteredSubjectContext = {
    declarationKey,
    operationRequirementKey: symmyOwnerOperationRequirementKey(
      input.context === undefined ? 'admission' : 'worker',
      providerEntrypointKey ?? input.effect.ref.operation.entrypointKey,
    ),
  };
  if (input.legalEntityId !== undefined) {
    common.legalEntityId = input.legalEntityId;
  }
  if (write && input.originalExecutorPrincipalId !== undefined) {
    common.expectedPrincipalId = input.originalExecutorPrincipalId;
  }
  const subject =
    input.context === undefined
      ? { ...input.admission, ...common, _tag: 'RegisteredAdmission' as const }
      : { ...common, _tag: 'RegisteredWorkload' as const, context: input.context };
  const granted = yield* acquireDelegatedGatewayContext(
    {
      audience: moduleId === party ? 'party-registry' : 'commerce-customer-context',
      legalEntityScope: input.legalEntityId === undefined ? 'tenant' : 'subject',
      requestCorrelation,
      subject,
    },
    crypto,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  if (granted.machineContext === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  let requestHash: string | undefined;
  if (write) {
    if (intent === undefined) {
      return yield* symmyJobWorkerUnavailable();
    }
    yield* input.recordExecutorPrincipal(granted.machineContext.principalId);
    const factualScope: SymmyPartyCommerceRequestScope = {
      principalId: granted.machineContext.principalId,
      tenantId: input.effect.ref.occurrence.record.route.tenantId,
    };
    const scope =
      input.legalEntityId === undefined ? factualScope : { ...factualScope, legalEntityId: input.legalEntityId };
    requestHash = yield* prepareSymmyPartyCommerceRequestHash(intent, scope);
    if (input.originalRequestHash !== undefined && input.originalRequestHash !== requestHash) {
      return yield* symmyJobWorkerUnavailable();
    }
    yield* input.recordOriginalRequestHash(requestHash, granted.machineContext.authContextRef);
  }
  return {
    authContextRef: granted.machineContext.authContextRef,
    authorization: granted.authorization,
    executorPrincipalId: granted.machineContext.principalId,
    options: {
      baseUrl: granted.apiBaseUrl,
      compositionRevision: granted.compositionRevision,
      idempotencyKey: input.effect.ref.effectId,
    },
    partyOptions: {
      baseUrl: granted.apiBaseUrl,
      compositionRevision: granted.compositionRevision,
      correlationId: requestCorrelation,
      idempotencyKey: input.effect.ref.effectId,
    },
    requestCorrelation,
    requestHash,
  };
});

const readRequestHash = Effect.fn('SymmyPartyCommerceAdapters.readRequestHash')(function* readRequestHash<
  Decoded,
  Encoded,
>(schema: Schema.Codec<Decoded, Encoded>, request: Decoded) {
  const decoded = yield* Schema.decodeUnknownEffect(Schema.toType(schema))(request).pipe(
    Effect.mapError(symmyJobWorkerUnavailable),
  );
  return yield* Effect.try({ catch: symmyJobWorkerUnavailable, try: () => computeCanonicalValueHash(decoded) });
});
const freshRecoveryContext = Effect.fn('SymmyPartyCommerceAdapters.recoveryContext')(function* freshRecoveryContext(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  declarationKey: string,
  moduleId: string,
  providerEntrypointKey: string,
  requestHash: string,
) {
  if (
    input.originalExecutorPrincipalId === undefined ||
    input.originalRequestHash === undefined ||
    input.originalAuthContextRef === undefined
  ) {
    return Option.none();
  }
  const original = yield* input.readOriginalActionInvocation({
    actionKey: input.effect.ref.operation.entrypointKey,
    idempotencyKey: input.effect.ref.effectId,
    originalPrincipalId: input.originalExecutorPrincipalId,
    requestHash: input.originalRequestHash,
  });
  if (
    Option.isNone(original) ||
    original.value.status !== 'succeeded' ||
    (input.originalInvocationId !== undefined && input.originalInvocationId !== original.value.actionInvocationId)
  ) {
    return Option.none();
  }
  yield* input.recordInvocationId(original.value.actionInvocationId);
  type RecoverySubject = Extract<GatewayDelegationSubject, { readonly _tag: 'RegisteredRecovery' }>;
  let source: RecoverySubject['source'] =
    input.context === undefined
      ? { ...input.admission, _tag: 'Admission' }
      : { _tag: 'Worker', context: input.context };
  if (input.legalEntityId !== undefined) {
    source = { ...source, legalEntityId: input.legalEntityId };
  }
  const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const context = yield* acquireDelegatedGatewayContext(
    {
      audience: moduleId === party ? 'party-registry' : 'commerce-customer-context',
      legalEntityScope: input.legalEntityId === undefined ? 'tenant' : 'subject',
      requestCorrelation,
      subject: {
        _tag: 'RegisteredRecovery',
        declarationKey,
        operationRequirementKey: symmyOwnerOperationRequirementKey(
          input.context === undefined ? 'admission' : 'worker',
          providerEntrypointKey,
        ),
        originalActionKey: input.effect.ref.operation.entrypointKey,
        originalIdempotencyKey: input.effect.ref.effectId,
        originalPrincipalId: input.originalExecutorPrincipalId,
        originalRequestHash: input.originalRequestHash,
        requestHash,
        source,
      },
    },
    crypto,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const { recovery } = context;
  if (recovery === undefined) {
    return Option.none();
  }
  const expected = yield* Schema.decodeUnknownEffect(RegisteredGatewayRecoverySchema)({
    originalActionInvocationId: original.value.actionInvocationId,
    originalActionKey: input.effect.ref.operation.entrypointKey,
    originalAuthContextRef: input.originalAuthContextRef,
    originalIdempotencyKey: input.effect.ref.effectId,
    originalPrincipalId: input.originalExecutorPrincipalId,
    originalRequestHash: input.originalRequestHash,
    requestHash,
  }).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  if (!Schema.toEquivalence(RegisteredGatewayRecoverySchema)(expected, recovery)) {
    return Option.none();
  }
  return Option.some({
    authorization: context.authorization,
    options: { baseUrl: context.apiBaseUrl, compositionRevision: context.compositionRevision },
    originalActionInvocationId: original.value.actionInvocationId,
    requestCorrelation,
  });
});

const assignmentPrivacy = Effect.fn('SymmyPartyCommerceAdapters.assignmentPrivacy')(function* assignmentPrivacy(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: Extract<
    SymmyPartyCommerceIntent,
    { readonly _tag: 'AssignCustomerPriceGroup' | 'AssignCounterpartyPriceGroup' }
  >,
) {
  if (input.legalEntityId === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  const original = input.effect.ref;
  const request = yield* Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema)({
    consumerModuleId: commerce,
    operation: 'PRICE_GROUP_ASSIGN',
    source: {
      issuer: original.occurrence.record.issuerId,
      namespace: original.occurrence.record.sourceNamespace,
      occurrenceId: original.occurrence.occurrenceId,
      recordId: original.occurrence.record.sourceRecordId,
      recordType: original.occurrence.record.entityKind,
      routeRef: original.occurrence.record.route.integrationRouteId,
    },
    target: {
      kind: intent.payload.profile.kind === 'RETAIL' ? 'RETAIL_CUSTOMER_PROFILE' : 'COUNTERPARTY_PURCHASING_PROFILE',
      resourceId: intent.payload.profile.resourceId,
    },
  });
  const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const common: RegisteredSubjectContext = {
    declarationKey: 'privacy.core.source-processing-eligibility.read',
    legalEntityId: input.legalEntityId,
    operationRequirementKey: symmyOwnerOperationRequirementKey(
      input.context === undefined ? 'admission' : 'worker',
      'privacy.core.api.source-processing-eligibility',
    ),
  };
  const subject =
    input.context === undefined
      ? { ...input.admission, ...common, _tag: 'RegisteredAdmission' as const }
      : { ...common, _tag: 'RegisteredWorkload' as const, context: input.context };
  const context = yield* acquireDelegatedGatewayContext(
    { audience: 'privacy', legalEntityScope: 'subject', requestCorrelation, subject },
    crypto,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const decision = yield* executeSourceProcessingEligibilityWithAuthorization(
    request,
    context.authorization,
    requestCorrelation,
    { baseUrl: context.apiBaseUrl, compositionRevision: context.compositionRevision },
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const checked = yield* Schema.decodeUnknownEffect(SourceProcessingEligibilityResponseSchema)(decision).pipe(
    Effect.mapError(symmyJobWorkerUnavailable),
  );
  return checked.outcome === 'ALLOWED';
});
const currentIntentPrivacy = (
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: SymmyPartyCommerceIntent,
) =>
  Match.value(intent).pipe(
    Match.tag('AssignCustomerPriceGroup', (selected) => assignmentPrivacy(crypto, input, selected)),
    Match.tag('AssignCounterpartyPriceGroup', (selected) =>
      selected.payload.processingKind === 'ORGANIZATION_BUSINESS'
        ? Effect.succeed(true)
        : assignmentPrivacy(crypto, input, selected),
    ),
    Match.orElse(() => Effect.succeed(true)),
  );

const operationForIntent = (intent: SymmyPartyCommerceIntent) =>
  Match.value(intent).pipe(
    Match.tags({
      AddPartyContactPoint: () => operations[13],
      AddPartyContactPointFromParty: () => operations[13],
      AddSavedAddress: () => operations[16],
      AddSavedCounterpartyAddressFromOwnerReceipts: () => operations[16],
      AddSavedRetailAddressFromOwnerReceipts: () => operations[16],
      AssignCounterpartyPriceGroup: () => operations[11],
      AssignCustomerPriceGroup: () => operations[10],
      CreateCounterpartyProfile: () => operations[9],
      CreateCounterpartyProfileFromCounterparty: () => operations[9],
      CustomerGroupCreate: () => operations[4],
      CustomerGroupMembership: () => operations[6],
      CustomerGroupUpdate: () => operations[5],
      CustomerProfileIco: () => operations[7],
      EndPartyContactPoint: () => operations[15],
      EnsureRetailProfile: () => operations[8],
      EnsureRetailProfileFromParty: () => operations[8],
      OnboardCounterpartyCustomer: () => operations[12],
      OnboardCounterpartyCustomerFromParty: () => operations[12],
      OrganizationCustomerProfileIco: () => operations[19],
      PartyCorrect: () => operations[3],
      PartyCreate: () => operations[0],
      PartyMatch: () => operations[1],
      PartyUpdate: () => operations[2],
      RemoveSavedAddress: () => operations[18],
      UpdatePartyContactPoint: () => operations[14],
      UpdateSavedAddress: () => operations[17],
    }),
    Match.exhaustive,
  );

const decodeIntent = (input: SymmyEffectAdapterInput, operation: Operation) =>
  Schema.decodeUnknownEffect(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })(input.effect.intent).pipe(
    Effect.mapError(symmyJobWorkerUnavailable),
    Effect.flatMap((intent) =>
      operationForIntent(intent).entrypointKey === operation.entrypointKey &&
      symmyPartyCommerceIntentMatchesEffect(input, intent)
        ? Effect.succeed(intent)
        : Effect.fail(symmyJobWorkerUnavailable()),
    ),
  );

const unavailableRecovery = { status: 'unavailable' as const };
const changedStatus = (changed: boolean): Status => (changed ? 'accepted_change' : 'accepted_no_change');
const createdPartyStatus = (value: 'CREATED' | 'MATCHED_EXISTING' | 'AMBIGUOUS'): Status =>
  Match.value(value).pipe(
    Match.when('CREATED', () => 'accepted_change' as const),
    Match.when('MATCHED_EXISTING', () => 'accepted_no_change' as const),
    Match.when('AMBIGUOUS', () => 'ambiguous' as const),
    Match.exhaustive,
  );
const matchedPartyStatus = (value: 'MATCHED' | 'NO_MATCH' | 'AMBIGUOUS'): Status =>
  Match.value(value).pipe(
    Match.when('MATCHED', () => 'accepted_no_change' as const),
    Match.when('NO_MATCH', () => 'unresolved' as const),
    Match.when('AMBIGUOUS', () => 'ambiguous' as const),
    Match.exhaustive,
  );
const membershipChanged = (value: { readonly items: readonly { readonly outcome: string }[] }) =>
  value.items.some((item) => item.outcome === 'ASSIGNED' || item.outcome === 'ENDED');

type PartyCreatedReceipt = Extract<
  typeof SymmyPartyCommerceOwnerReceiptSchema.Encoded,
  { readonly _tag: 'PartyCreated' }
>;
type PartyMatchedReceipt = Extract<
  typeof SymmyPartyCommerceOwnerReceiptSchema.Encoded,
  { readonly _tag: 'PartyMatched' }
>;
const ownerReceiptMatchesTenant = (receipt: typeof SymmyPartyCommerceOwnerReceiptSchema.Type, tenantId: string) =>
  Match.value(receipt).pipe(
    Match.tags({
      CounterpartyCustomerOnboarded: (value) =>
        value.partyRef.tenantId === tenantId &&
        value.counterpartyRef.tenantId === tenantId &&
        (value.legalEntityRef === undefined || value.legalEntityRef.tenantId === tenantId) &&
        (value.rolePeriodRef === undefined || value.rolePeriodRef.tenantId === tenantId),
      CounterpartyProfileCreated: (value) =>
        value.profileRef.tenantId === tenantId && value.counterpartyRef.tenantId === tenantId,
      PartyContactPointAdded: (value) =>
        value.partyRef.tenantId === tenantId && value.contactPointRef.tenantId === tenantId,
      PartyCreated: (value) => value.partyRef.tenantId === tenantId,
      PartyMatched: (value) => value.partyRef.tenantId === tenantId,
      RetailProfileEnsured: (value) => value.profileRef.tenantId === tenantId && value.partyRef.tenantId === tenantId,
    }),
    Match.exhaustive,
  );

const saveOwnerReceipt = Effect.fn('SymmyPartyCommerceAdapters.saveReceipt')(function* saveOwnerReceipt(
  input: SymmyEffectAdapterInput,
  receipt: typeof SymmyPartyCommerceOwnerReceiptSchema.Encoded,
) {
  const original = input.originalOwnerReceipt;
  const retainedReceipt = Match.value({ original, receipt }).pipe(
    Match.when(
      { original: { _tag: 'CounterpartyCustomerOnboarded' }, receipt: { _tag: 'CounterpartyCustomerOnboarded' } },
      (value) => {
        let restored: typeof value.receipt = Struct.omit(value.receipt, ['legalEntityRef', 'rolePeriodRef']);
        if (value.original.legalEntityRef !== undefined) {
          restored = { ...restored, legalEntityRef: value.original.legalEntityRef };
        }
        if (value.original.rolePeriodRef !== undefined) {
          restored = { ...restored, rolePeriodRef: value.original.rolePeriodRef };
        }
        return restored;
      },
    ),
    Match.orElse((value) => value.receipt),
  );
  const decoded = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceOwnerReceiptSchema)(retainedReceipt).pipe(
    Effect.mapError(symmyJobWorkerUnavailable),
  );
  const sameTenant = ownerReceiptMatchesTenant(decoded, input.effect.ref.occurrence.record.route.tenantId);
  if (!sameTenant) {
    return yield* symmyJobWorkerUnavailable();
  }
  return yield* input.recordOwnerReceipt(decoded);
});

const recordCreatedParty = (
  input: SymmyEffectAdapterInput,
  result: typeof CreatePartyResultSchema.Type,
  actionInvocationId?: string,
) =>
  Match.value(result).pipe(
    Match.when({ outcome: 'CREATED' }, (created) => {
      const receipt: PartyCreatedReceipt = { _tag: 'PartyCreated', partyRef: created.partyRef };
      return saveOwnerReceipt(input, actionInvocationId === undefined ? receipt : { ...receipt, actionInvocationId });
    }),
    Match.when({ outcome: 'MATCHED_EXISTING' }, (matched) => {
      const receipt: PartyMatchedReceipt = { _tag: 'PartyMatched', partyRef: matched.partyRef };
      return saveOwnerReceipt(input, actionInvocationId === undefined ? receipt : { ...receipt, actionInvocationId });
    }),
    Match.orElse(() => Effect.void),
  );
const recordMatchedParty = Effect.fn('SymmyPartyCommerceAdapters.recordMatchedParty')(function* recordMatchedParty(
  input: SymmyEffectAdapterInput,
  result: typeof MatchPartyResultSchema.Type,
  actionInvocationId?: string,
) {
  if (result.outcome !== 'MATCHED') {
    return yield* Effect.void;
  }
  const [partyRef] = result.candidateParties;
  if (result.candidateParties.length !== 1 || partyRef === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  const receipt: PartyMatchedReceipt = { _tag: 'PartyMatched', partyRef };
  return yield* saveOwnerReceipt(
    input,
    actionInvocationId === undefined ? receipt : { ...receipt, actionInvocationId },
  );
});

const recoverParty = Effect.fn('SymmyPartyCommerceAdapters.recoverParty')(function* recoverParty(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  operation: (typeof PartySourceEffectReceiptRequestSchema.Type)['operation'],
  intent: SymmyPartyCommerceIntent,
) {
  const request = yield* Schema.decodeUnknownEffect(PartySourceEffectReceiptRequestSchema)({
    operation,
    payload: intent.payload,
  });
  const requestHash = yield* readRequestHash(PartySourceEffectReceiptRequestSchema, request);
  const authorized = yield* freshRecoveryContext(
    crypto,
    input,
    'party.registry.party-source-effect-receipt.read',
    party,
    'party.registry.api.party-source-effect-receipt',
    requestHash,
  );
  if (Option.isNone(authorized)) {
    return unavailableRecovery;
  }
  const context = authorized.value;
  const receipt = yield* executePartySourceEffectReceiptWithAuthorization(
    request,
    context.authorization,
    context.requestCorrelation,
    context.options,
  );
  if (receipt.outcome !== 'COMMITTED' || receipt.operation !== operation) {
    return unavailableRecovery;
  }
  yield* Match.value(receipt).pipe(
    Match.when({ operation: 'CREATE' }, (original) =>
      recordCreatedParty(input, original.result, original.actionInvocationId),
    ),
    Match.when({ operation: 'MATCH' }, (original) =>
      recordMatchedParty(input, original.result, original.actionInvocationId),
    ),
    Match.when({ operation: 'ONBOARD_COUNTERPARTY_CUSTOMER' }, (original) =>
      saveOwnerReceipt(input, {
        _tag: 'CounterpartyCustomerOnboarded',
        actionInvocationId: original.actionInvocationId,
        counterpartyRef: original.result.counterpartyRef,
        legalEntityRef: original.result.legalEntityRef,
        partyRef: original.result.partyRef,
        rolePeriodRef: original.result.rolePeriodRef,
      }),
    ),
    Match.when({ operation: 'ADD_CONTACT_POINT' }, (original) =>
      saveOwnerReceipt(input, {
        _tag: 'PartyContactPointAdded',
        actionInvocationId: original.actionInvocationId,
        contactPointRef: original.result.contactPointRef,
        partyRef: original.result.partyRef,
        revision: original.result.revision,
      }),
    ),
    Match.orElse(() => Effect.void),
  );
  const status = Match.value(receipt).pipe(
    Match.when({ operation: 'CREATE' }, (created) => createdPartyStatus(created.result.outcome)),
    Match.when({ operation: 'MATCH' }, (matched) => matchedPartyStatus(matched.result.outcome)),
    Match.when({ operation: 'ONBOARD_COUNTERPARTY_CUSTOMER' }, (original) =>
      changedStatus(original.result.counterpartyCreated || original.result.rolePeriodCreated),
    ),
    Match.when({ operation: 'ADD_CONTACT_POINT' }, (original) => changedStatus(original.result.changed)),
    Match.when({ operation: 'UPDATE_CONTACT_POINT' }, (original) => changedStatus(original.result.changed)),
    Match.when({ operation: 'END_CONTACT_POINT' }, (original) => changedStatus(original.result.changed)),
    Match.orElse(() => 'accepted_change' as const),
  );
  return { outcome: yield* outcome(input, status), status: 'settled' as const };
});

const contactReceiptAfterAcknowledgement = Effect.fn('SymmyPartyCommerceAdapters.contactReceiptAfterAcknowledgement')(
  function* contactReceiptAfterAcknowledgement(
    crypto: Crypto.Crypto,
    input: SymmyEffectAdapterInput,
    operation: (typeof PartySourceEffectReceiptRequestSchema.Type)['operation'],
    intent: SymmyPartyCommerceIntent,
  ) {
    const recovered = yield* recoverParty(crypto, input, operation, intent).pipe(
      Effect.mapError(symmyJobWorkerUnavailable),
    );
    if (recovered.status !== 'settled') {
      return yield* symmyJobWorkerUnavailable();
    }
    return recovered.outcome;
  },
);

const dependencyReceipt = Effect.fn('SymmyPartyCommerceAdapters.dependencyReceipt')(function* dependencyReceipt(
  input: SymmyEffectAdapterInput,
  reference: { readonly effectKey: string; readonly itemKey: string },
) {
  const parents = input.dependencies.filter(
    (parent) => parent.itemKey === reference.itemKey && parent.effect.effectKey === reference.effectKey,
  );
  const [parent] = parents;
  if (
    parents.length !== 1 ||
    parent === undefined ||
    parent.state !== 'settled' ||
    Option.isNone(parent.outcome) ||
    !Schema.is(Schema.Literals(['accepted_change', 'accepted_no_change', 'duplicate']))(parent.outcome.value.status) ||
    parent.effect.ref.occurrence.record.route.tenantId !== input.effect.ref.occurrence.record.route.tenantId ||
    !('effectId' in parent.outcome.value) ||
    parent.outcome.value.effectId !== parent.effect.ref.effectId ||
    parent.outcome.value.owner !== parent.effect.ref.operation.moduleId ||
    parent.effect.ref.operation.schemaVersion !== '1' ||
    !(input.effect.dependsOn ?? []).some((dependency) =>
      Schema.is(Schema.String)(dependency)
        ? dependency === reference.effectKey && parent.effect.itemId === input.effect.itemId
        : dependency.effectKey === reference.effectKey && dependency.itemKey === reference.itemKey,
    )
  ) {
    return yield* symmyJobWorkerUnavailable();
  }
  const receipt = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceOwnerReceiptSchema)(
    Option.getOrUndefined(parent.ownerReceipt ?? Option.none()),
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const expectedOperation = Match.value(receipt).pipe(
    Match.tags({
      CounterpartyCustomerOnboarded: () => 'party.registry.counterparty-customer-onboard',
      CounterpartyProfileCreated: () => 'commerce.customer-context.create-counterparty-purchasing-profile',
      PartyContactPointAdded: () => 'party.registry.add-contact-point',
      PartyCreated: () => createPartyActionKey,
      PartyMatched: () =>
        parent.effect.ref.operation.entrypointKey === createPartyActionKey
          ? createPartyActionKey
          : 'party.registry.match-party',
      RetailProfileEnsured: () => 'commerce.customer-context.ensure-retail-customer-profile',
    }),
    Match.exhaustive,
  );
  if (
    parent.effect.ref.operation.entrypointKey !== expectedOperation ||
    !ownerReceiptMatchesTenant(receipt, input.effect.ref.occurrence.record.route.tenantId)
  ) {
    return yield* symmyJobWorkerUnavailable();
  }
  return receipt;
});
const partyDependencyReceipt = Effect.fn('SymmyPartyCommerceAdapters.partyDependency')(function* partyDependency(
  input: SymmyEffectAdapterInput,
  reference: { readonly effectKey: string; readonly itemKey: string },
) {
  const receipt = yield* dependencyReceipt(input, reference);
  return yield* Match.value(receipt).pipe(
    Match.tag('PartyCreated', 'PartyMatched', (value) => Effect.succeed(value)),
    Match.orElse(() => Effect.fail(symmyJobWorkerUnavailable())),
  );
});
const contactDependencyReceipt = Effect.fn('SymmyPartyCommerceAdapters.contactDependency')(function* contactDependency(
  input: SymmyEffectAdapterInput,
  reference: { readonly effectKey: string; readonly itemKey: string },
) {
  const receipt = yield* dependencyReceipt(input, reference);
  return yield* Match.value(receipt).pipe(
    Match.tag('PartyContactPointAdded', (value) => Effect.succeed(value)),
    Match.orElse(() => Effect.fail(symmyJobWorkerUnavailable())),
  );
});
const counterpartyDependencyReceipt = Effect.fn('SymmyPartyCommerceAdapters.counterpartyDependency')(
  function* counterpartyDependency(
    input: SymmyEffectAdapterInput,
    reference: { readonly effectKey: string; readonly itemKey: string },
  ) {
    const receipt = yield* dependencyReceipt(input, reference);
    return yield* Match.value(receipt).pipe(
      Match.tag('CounterpartyCustomerOnboarded', (value) => Effect.succeed(value)),
      Match.orElse(() => Effect.fail(symmyJobWorkerUnavailable())),
    );
  },
);
const organizationResolvedIntent = Effect.fn('SymmyPartyCommerceAdapters.organizationResolvedIntent')(
  function* organizationResolvedIntent(input: SymmyEffectAdapterInput, resolved: SymmyPartyCommerceIntent) {
    const native = Match.value(resolved).pipe(
      Match.tag('OnboardCounterpartyCustomer', 'CreateCounterpartyProfile', (value) => Option.some(value)),
      Match.orElse(() => Option.none()),
    );
    if (input.acceptedPlan === undefined || Option.isNone(native)) {
      return resolved;
    }
    const projection = yield* projectSymmyOrganizationAcceptedEffect(input.acceptedPlan, input.effect);
    if (Option.isNone(projection)) {
      return resolved;
    }
    const originalAdmissionInvocationId = input.context?.originatorInvocationId ?? input.admission?.actionInvocationId;
    const witness = yield* Schema.decodeUnknownEffect(SymmySourceOrganizationWitnessSchema)({
      effectId: input.effect.ref.effectId,
      originalAdmissionInvocationId,
      semanticInputDigest: projection.value.inputDigest,
      semanticProjectionVersion: projection.value.projectionVersion,
    }).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    return { ...native.value, payload: { ...native.value.payload, sourceOrganizationWitness: witness } };
  },
);
const resolveDependencies = Effect.fn('SymmyPartyCommerceAdapters.resolveDependencies')(function* resolveDependencies(
  input: SymmyEffectAdapterInput,
) {
  const intent = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })(
    input.effect.intent,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const resolved = yield* Match.value(intent).pipe(
    Match.tags({
      AddPartyContactPointFromParty: Effect.fn('SymmyPartyCommerceAdapters.resolveContact')(
        function* resolveContact(pending) {
          return Option.some<SymmyPartyCommerceIntent>(
            resolveSymmyContactPointParty(pending, yield* partyDependencyReceipt(input, pending.fromPartyEffect)),
          );
        },
      ),
      AddSavedCounterpartyAddressFromOwnerReceipts: Effect.fn('SymmyPartyCommerceAdapters.resolveCounterpartyAddress')(
        function* resolveCounterpartyAddress(pending) {
          const found = yield* dependencyReceipt(input, pending.fromProfileEffect);
          const profile = yield* Match.value(found).pipe(
            Match.tag('CounterpartyProfileCreated', (value) => Effect.succeed(value)),
            Match.orElse(() => Effect.fail(symmyJobWorkerUnavailable())),
          );
          const resolvedAddress = resolveSymmyCounterpartySavedAddress(
            pending,
            profile,
            yield* contactDependencyReceipt(input, pending.fromContactPointEffect),
            yield* counterpartyDependencyReceipt(input, pending.fromCounterpartyEffect),
          );
          if (Option.isNone(resolvedAddress)) {
            return yield* symmyJobWorkerUnavailable();
          }
          return Option.some<SymmyPartyCommerceIntent>(resolvedAddress.value);
        },
      ),
      AddSavedRetailAddressFromOwnerReceipts: Effect.fn('SymmyPartyCommerceAdapters.resolveRetailAddress')(
        function* resolveRetailAddress(pending) {
          const found = yield* dependencyReceipt(input, pending.fromProfileEffect);
          const profile = yield* Match.value(found).pipe(
            Match.tag('RetailProfileEnsured', (value) => Effect.succeed(value)),
            Match.orElse(() => Effect.fail(symmyJobWorkerUnavailable())),
          );
          const resolvedAddress = resolveSymmyRetailSavedAddress(
            pending,
            profile,
            yield* contactDependencyReceipt(input, pending.fromContactPointEffect),
          );
          if (Option.isNone(resolvedAddress)) {
            return yield* symmyJobWorkerUnavailable();
          }
          return Option.some<SymmyPartyCommerceIntent>(resolvedAddress.value);
        },
      ),
      CreateCounterpartyProfileFromCounterparty: Effect.fn('SymmyPartyCommerceAdapters.resolveCounterpartyProfile')(
        function* resolveCounterpartyProfile(pending) {
          return Option.some<SymmyPartyCommerceIntent>(
            resolveSymmyCounterpartyProfileCounterparty(
              pending,
              yield* counterpartyDependencyReceipt(input, pending.fromCounterpartyEffect),
            ),
          );
        },
      ),
      EnsureRetailProfileFromParty: Effect.fn('SymmyPartyCommerceAdapters.resolveRetail')(
        function* resolveRetail(pending) {
          return Option.some<SymmyPartyCommerceIntent>(
            resolveSymmyRetailProfileParty(pending, yield* partyDependencyReceipt(input, pending.fromPartyEffect)),
          );
        },
      ),
      OnboardCounterpartyCustomerFromParty: Effect.fn('SymmyPartyCommerceAdapters.resolveOnboard')(
        function* resolveOnboard(pending) {
          return Option.some<SymmyPartyCommerceIntent>(
            resolveSymmyCounterpartyOnboardParty(
              pending,
              yield* partyDependencyReceipt(input, pending.fromPartyEffect),
            ),
          );
        },
      ),
    }),
    Match.orElse(() => Effect.succeed(Option.none<SymmyPartyCommerceIntent>())),
  );
  if (Option.isNone(resolved)) {
    return input;
  }
  if (
    !input.canExecuteNewEffects ||
    input.originalExecutorPrincipalId !== undefined ||
    input.originalInvocationId !== undefined ||
    input.originalRequestHash !== undefined ||
    input.effect.ref.originalTarget !== undefined
  ) {
    return yield* symmyJobWorkerUnavailable();
  }
  const effect = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
    ...input.effect,
    intent: yield* organizationResolvedIntent(input, resolved.value),
  }).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  if (
    !symmyPartyCommerceIntentMatchesEffect(
      { ...input, effect },
      effect.intent === undefined
        ? resolved.value
        : yield* Schema.decodeUnknownEffect(SymmyPartyCommerceIntentSchema)(effect.intent).pipe(
            Effect.mapError(symmyJobWorkerUnavailable),
          ),
    )
  ) {
    return yield* symmyJobWorkerUnavailable();
  }
  yield* input.recordResolvedEffect(effect);
  return { ...input, effect };
});

const captureAcknowledgedNativeInvocation = Effect.fn('SymmyPartyCommerceAdapters.captureAcknowledgedInvocation')(
  function* captureAcknowledged(input: SymmyEffectAdapterInput, result: typeof SymmyEffectOutcomeSchema.Type) {
    if (
      !Schema.is(Schema.Literals(['accepted_change', 'accepted_no_change', 'duplicate', 'ambiguous', 'unresolved']))(
        result.status,
      )
    ) {
      return result;
    }
    if (
      input.originalExecutorPrincipalId === undefined ||
      input.originalRequestHash === undefined ||
      input.originalAuthContextRef === undefined
    ) {
      return yield* symmyJobWorkerUnavailable();
    }
    yield* traceProfileStage('native-fact-enter');
    const original = yield* input
      .readOriginalActionInvocation({
        actionKey: input.effect.ref.operation.entrypointKey,
        idempotencyKey: input.effect.ref.effectId,
        originalPrincipalId: input.originalExecutorPrincipalId,
        requestHash: input.originalRequestHash,
      })
      .pipe(Effect.mapError(symmyJobWorkerUnavailable));
    if (Option.isNone(original) || original.value.status !== 'succeeded') {
      yield* traceProfileStage('native-fact-not-succeeded');
      return yield* symmyJobWorkerUnavailable();
    }
    if (input.originalInvocationId !== undefined && input.originalInvocationId !== original.value.actionInvocationId) {
      return yield* symmyJobWorkerUnavailable();
    }
    yield* input.recordInvocationId(original.value.actionInvocationId).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    yield* traceProfileStage('native-fact-recorded');
    return result;
  },
);

const currentOrganizationIcoTarget = Effect.fn('SymmyPartyCommerceAdapters.currentOrganizationIcoTarget')(
  function* currentOrganizationIcoTarget(
    crypto: Crypto.Crypto,
    input: SymmyEffectAdapterInput,
    intent: SymmyPartyCommerceIntent,
  ) {
    const organization = Match.value(intent).pipe(
      Match.tag('OrganizationCustomerProfileIco', (value) => Option.some(value)),
      Match.orElse(() => Option.none()),
    );
    if (Option.isNone(organization)) {
      return yield* Effect.void;
    }
    if (input.legalEntityId === undefined) {
      return yield* symmyJobWorkerUnavailable();
    }
    const { payload, sourceReference } = organization.value;
    const request = yield* Schema.decodeUnknownEffect(CustomerProfileSourceRequestSchema)({
      issuer: sourceReference.source.issuer,
      mappingRevision: input.effect.ref.mappingVersion,
      mode: 'CURRENT',
      namespace: sourceReference.source.namespace,
      recordId: sourceReference.recordId,
      recordType: sourceReference.source.recordType,
      route: { id: sourceReference.source.routeRef, revision: input.effect.ref.routeRevision },
    }).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const context = yield* freshOwnerContext(
      crypto,
      input,
      'commerce.customer-context.customer-profile-source.read',
      commerce,
      false,
      undefined,
      'commerce.customer-context.api.customer-profile-source',
    );
    const current = yield* executeCustomerProfileSourceWithAuthorization(
      request,
      context.authorization,
      context.requestCorrelation,
      context.options,
    ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const valid = Match.value(current).pipe(
      Match.tag(
        'CURRENT',
        (value) =>
          value.item.icoAuthority === 'ORGANIZATION' &&
          value.item.partyRef.tenantId === payload.profileRef.tenantId &&
          value.item.profile.subject.kind === 'COUNTERPARTY' &&
          value.item.profile.profileRef.kind === 'COUNTERPARTY' &&
          value.item.profile.profileRef.resourceId === payload.profileRef.resourceId &&
          value.item.profile.profileRef.tenantId === payload.profileRef.tenantId &&
          value.item.source.issuer === request.issuer &&
          value.item.source.namespace === request.namespace &&
          value.item.source.recordType === request.recordType &&
          value.item.source.recordId === sourceReference.recordId &&
          value.item.source.mappingRevision === request.mappingRevision &&
          value.item.source.route.id === request.route.id &&
          value.item.source.route.revision === request.route.revision,
      ),
      Match.orElse(() => false),
    );
    if (!valid) {
      return yield* symmyJobWorkerUnavailable();
    }
    return yield* Effect.void;
  },
);
const currentMembershipDefinition = Effect.fn('SymmyPartyCommerceAdapters.currentMembershipDefinition')(
  function* currentMembershipDefinition(
    crypto: Crypto.Crypto,
    input: SymmyEffectAdapterInput,
    intent: SymmyPartyCommerceIntent,
  ) {
    const membership = Match.value(intent).pipe(
      Match.tag('CustomerGroupMembership', (value) => Option.some(value)),
      Match.orElse(() => Option.none()),
    );
    if (Option.isNone(membership)) {
      return yield* Effect.void;
    }
    if (input.routeKey === 'customersBatch') {
      return yield* Effect.void;
    }
    if (input.routeKey !== 'customerGroupCustomersBatch') {
      return yield* symmyJobWorkerUnavailable();
    }
    const { selector } = input;
    const { ref } = input.effect;
    if (
      selector === undefined ||
      selector.kind !== 'CUSTOMER_GROUP' ||
      selector.target === undefined ||
      input.legalEntityId === undefined ||
      selector.source.entityKind !== 'CUSTOMER_GROUP' ||
      selector.source.route.tenantId !== ref.occurrence.record.route.tenantId ||
      selector.source.route.integrationRouteId !== ref.occurrence.record.route.integrationRouteId
    ) {
      return yield* symmyJobWorkerUnavailable();
    }
    const target = yield* Schema.decodeUnknownEffect(CustomerGroupRefSchema)(selector.target).pipe(
      Effect.mapError(symmyJobWorkerUnavailable),
    );
    if (target.tenantId !== selector.source.route.tenantId) {
      return yield* symmyJobWorkerUnavailable();
    }
    const payload = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)(
      membership.value.payload,
    ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    if (payload.operation === 'COMPLETE') {
      return yield* symmyJobWorkerUnavailable();
    }
    const groups = Match.value(payload).pipe(
      Match.when({ operation: 'ASSIGN' }, (value) => [value.groupRef]),
      Match.when({ operation: 'REMOVE' }, (value) => [value.groupRef]),
      Match.orElse((value) => value.groupRefs),
    );
    if (groups.length !== 1 || !groups.every((group) => Schema.toEquivalence(CustomerGroupRefSchema)(group, target))) {
      return yield* symmyJobWorkerUnavailable();
    }
    const request = yield* Schema.decodeUnknownEffect(CustomerGroupDefinitionSourceRequestSchema)({
      issuer: selector.source.issuerId,
      mappingRevision: ref.mappingVersion,
      mode: 'CURRENT',
      namespace: selector.source.sourceNamespace,
      recordId: selector.source.sourceRecordId,
      route: { id: selector.source.route.integrationRouteId, revision: ref.routeRevision },
    }).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const context = yield* freshOwnerContext(
      crypto,
      input,
      'commerce.customer-context.customer-group-definition-source.read',
      commerce,
      false,
      undefined,
      'commerce.customer-context.api.customer-group-definition-source',
    );
    const current = yield* executeCustomerGroupDefinitionSourceWithAuthorization(
      request,
      context.authorization,
      context.requestCorrelation,
      context.options,
    ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const valid = Match.value(current).pipe(
      Match.tag(
        'CURRENT',
        (value) =>
          Schema.toEquivalence(CustomerGroupRefSchema)(value.group.groupRef, target) &&
          value.source.issuer === request.issuer &&
          value.source.namespace === request.namespace &&
          value.source.recordId === selector.source.sourceRecordId &&
          value.source.mappingRevision === request.mappingRevision &&
          value.source.route.id === request.route.id &&
          value.source.route.revision === request.route.revision,
      ),
      Match.orElse(() => false),
    );
    if (!valid) {
      return yield* symmyJobWorkerUnavailable();
    }
    return yield* Effect.void;
  },
);
const executeIntent = Effect.fn('SymmyPartyCommerceAdapters.execute')(
  function* executeIntent(crypto: Crypto.Crypto, operation: Operation, originalInput: SymmyEffectAdapterInput) {
    const input = yield* resolveDependencies(originalInput);
    if (!input.canExecuteNewEffects) {
      return yield* symmyJobWorkerUnavailable();
    }
    const normalizedIntent = yield* decodeIntent(input, operation);
    const processingAllowed = yield* currentIntentPrivacy(crypto, input, normalizedIntent);
    if (!processingAllowed) {
      return yield* outcome(input, 'denied');
    }
    const unsupportedSelectedComplete =
      input.routeKey === 'customerGroupCustomersBatch' &&
      Match.value(normalizedIntent).pipe(
        Match.tag('CustomerGroupMembership', (value) => value.payload.operation === 'COMPLETE'),
        Match.orElse(() => false),
      );
    if (
      unsupportedSelectedComplete &&
      input.originalExecutorPrincipalId === undefined &&
      input.originalInvocationId === undefined &&
      input.originalRequestHash === undefined &&
      input.originalAuthContextRef === undefined &&
      input.originalOwnerReceipt === undefined
    ) {
      return yield* Schema.decodeUnknownEffect(SymmyEffectOutcomeSchema)({
        owner: commerce,
        reason: 'missing_context',
        status: 'unsupported',
      }).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    }
    yield* currentMembershipDefinition(crypto, input, normalizedIntent);
    yield* currentOrganizationIcoTarget(crypto, input, normalizedIntent);
    const selected = operationForIntent(normalizedIntent);
    const context = yield* freshOwnerContext(
      crypto,
      input,
      selected.declaration,
      selected.moduleId,
      true,
      normalizedIntent,
    );
    if (context.requestHash === undefined) {
      return yield* symmyJobWorkerUnavailable();
    }
    const acknowledgedInput: SymmyEffectAdapterInput = {
      ...input,
      originalAuthContextRef: context.authContextRef,
      originalExecutorPrincipalId: context.executorPrincipalId,
      originalRequestHash: context.requestHash,
    };
    return yield* Match.value(normalizedIntent).pipe(
      Match.tags({
        AddPartyContactPoint: Effect.fn('SymmyPartyCommerceAdapters.AddPartyContactPoint')(function* invokeAddContact(
          intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddPartyContactPoint' }>,
        ) {
          const payload = yield* Schema.decodeUnknownEffect(AddContactPointPayloadSchema)(intent.payload);
          const result = yield* addContactPointWithAuthorization(payload, context.authorization, context.partyOptions);
          yield* saveOwnerReceipt(input, {
            _tag: 'PartyContactPointAdded',
            contactPointRef: result.contactPointRef,
            partyRef: result.partyRef,
            revision: result.revision,
          });
          return yield* contactReceiptAfterAcknowledgement(crypto, acknowledgedInput, 'ADD_CONTACT_POINT', intent);
        }),
        AddPartyContactPointFromParty: () => Effect.fail(symmyJobWorkerUnavailable()),
        AddSavedAddress: Effect.fn('SymmyPartyCommerceAdapters.AddSavedAddress')(function* invokeAddSavedAddress(
          intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddSavedAddress' }>,
        ) {
          const payload = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema)(intent.payload);
          const result = yield* executeAddSavedAddressWithAuthorization(
            payload,
            context.authorization,
            context.requestCorrelation,
            context.options,
          );
          return yield* outcome(input, 'outcome' in result ? changedStatus(result.outcome === 'ADDED') : 'denied');
        }),
        AddSavedCounterpartyAddressFromOwnerReceipts: () => Effect.fail(symmyJobWorkerUnavailable()),
        AddSavedRetailAddressFromOwnerReceipts: () => Effect.fail(symmyJobWorkerUnavailable()),
        AssignCounterpartyPriceGroup: Effect.fn('SymmyPartyCommerceAdapters.AssignCounterpartyPriceGroup')(
          function* invokeCounterpartyPriceGroup(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AssignCounterpartyPriceGroup' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(AssignCounterpartyPriceGroupPayloadSchema)(
              intent.payload,
            );
            const result = yield* executeAssignCounterpartyPriceGroupWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            return yield* outcome(input, 'assignment' in result ? changedStatus(result.changed) : 'denied');
          },
        ),
        AssignCustomerPriceGroup: Effect.fn('SymmyPartyCommerceAdapters.AssignCustomerPriceGroup')(
          function* invokeCustomerPriceGroup(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AssignCustomerPriceGroup' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(AssignCustomerPriceGroupPayloadSchema)(intent.payload);
            const result = yield* executeAssignCustomerPriceGroupWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            return yield* outcome(input, 'assignment' in result ? changedStatus(result.changed) : 'denied');
          },
        ),
        CreateCounterpartyProfile: Effect.fn('SymmyPartyCommerceAdapters.CreateCounterpartyProfile')(
          function* invokeCreateCounterpartyProfile(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CreateCounterpartyProfile' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema)(
              intent.payload,
            );
            const result = yield* executeCreateCounterpartyPurchasingProfileWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            if ('profileRef' in result) {
              yield* saveOwnerReceipt(input, {
                _tag: 'CounterpartyProfileCreated',
                counterpartyRef: payload.subject.counterpartyRef,
                profileRef: result.profileRef,
              });
            }
            return yield* outcome(
              input,
              'outcome' in result ? changedStatus(result.outcome === 'PROFILE_CREATED') : 'denied',
            );
          },
        ),
        CreateCounterpartyProfileFromCounterparty: () => Effect.fail(symmyJobWorkerUnavailable()),
        CustomerGroupCreate: Effect.fn('SymmyPartyCommerceAdapters.CustomerGroupCreate')(
          function* invokeCustomerGroupCreate(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerGroupCreate' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)(intent.payload);
            const result = yield* executeCreateCustomerGroupWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            return yield* outcome(input, 'group' in result ? changedStatus(result.created) : 'denied');
          },
        ),
        CustomerGroupMembership: Effect.fn('SymmyPartyCommerceAdapters.CustomerGroupMembership')(
          function* invokeCustomerGroupMembership(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerGroupMembership' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)(
              intent.payload,
            );
            const result = yield* executeApplyCustomerGroupMembershipSourceWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            return yield* outcome(input, 'items' in result ? changedStatus(membershipChanged(result)) : 'denied');
          },
        ),
        CustomerGroupUpdate: Effect.fn('SymmyPartyCommerceAdapters.CustomerGroupUpdate')(
          function* invokeCustomerGroupUpdate(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerGroupUpdate' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(UpdateCustomerGroupPayloadSchema)(intent.payload);
            const result = yield* executeUpdateCustomerGroupWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            return yield* outcome(input, 'group' in result ? changedStatus(result.changed) : 'denied');
          },
        ),
        CustomerProfileIco: Effect.fn('SymmyPartyCommerceAdapters.CustomerProfileIco')(
          function* invokeCustomerProfileIco(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerProfileIco' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(ChangeCustomerProfileIcoPayloadSchema)(intent.payload);
            const result = yield* executeChangeCustomerProfileIcoWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            return yield* outcome(input, 'outcome' in result ? 'accepted_change' : 'denied');
          },
        ),
        EndPartyContactPoint: Effect.fn('SymmyPartyCommerceAdapters.EndPartyContactPoint')(function* invokeEndContact(
          intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'EndPartyContactPoint' }>,
        ) {
          const payload = yield* Schema.decodeUnknownEffect(EndContactPointPayloadSchema)(intent.payload);
          yield* endContactPointWithAuthorization(payload, context.authorization, context.partyOptions);
          return yield* contactReceiptAfterAcknowledgement(crypto, acknowledgedInput, 'END_CONTACT_POINT', intent);
        }),
        EnsureRetailProfile: Effect.fn('SymmyPartyCommerceAdapters.EnsureRetailProfile')(
          function* invokeEnsureRetailProfile(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'EnsureRetailProfile' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(EnsureRetailCustomerProfilePayloadSchema)(intent.payload);
            yield* traceProfileStage('native-call');
            const result = yield* executeEnsureRetailCustomerProfileWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            ).pipe(
              Effect.tapError((failure) =>
                traceProfileStage('native-client-failed', Schema.decodeUnknownOption(DiagnosticFailureSchema)(failure)),
              ),
            );
            yield* traceProfileStage('native-ack-decoded');
            if ('profileRef' in result) {
              yield* traceProfileStage('private-receipt-enter');
              yield* saveOwnerReceipt(input, {
                _tag: 'RetailProfileEnsured',
                partyRef: payload.subject.partyRef,
                profileRef: result.profileRef,
              }).pipe(
                Effect.tapError((failure) =>
                  traceProfileStage(
                    'private-receipt-failed',
                    Schema.decodeUnknownOption(DiagnosticFailureSchema)(failure),
                  ),
                ),
              );
              yield* traceProfileStage('private-receipt-recorded');
            }
            yield* traceProfileStage('safe-outcome-project');
            return yield* outcome(
              input,
              'outcome' in result ? changedStatus(result.outcome === 'PROFILE_CREATED') : 'denied',
            );
          },
        ),
        EnsureRetailProfileFromParty: () => Effect.fail(symmyJobWorkerUnavailable()),
        OnboardCounterpartyCustomer: Effect.fn('SymmyPartyCommerceAdapters.OnboardCounterpartyCustomer')(
          function* invokeOnboard(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'OnboardCounterpartyCustomer' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)(intent.payload);
            const result = yield* counterpartyCustomerOnboardWithAuthorization(
              payload,
              context.authorization,
              context.partyOptions,
            );
            yield* saveOwnerReceipt(input, {
              _tag: 'CounterpartyCustomerOnboarded',
              counterpartyRef: result.counterpartyRef,
              legalEntityRef: result.legalEntityRef,
              partyRef: result.partyRef,
              rolePeriodRef: result.rolePeriodRef,
            });
            return yield* outcome(input, changedStatus(result.counterpartyCreated || result.rolePeriodCreated));
          },
        ),
        OnboardCounterpartyCustomerFromParty: () => Effect.fail(symmyJobWorkerUnavailable()),
        OrganizationCustomerProfileIco: Effect.fn('SymmyPartyCommerceAdapters.OrganizationCustomerProfileIco')(
          function* invokeOrganizationIco(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'OrganizationCustomerProfileIco' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)(
              intent.payload,
            );
            const result = yield* executeChangeOrganizationCustomerProfileIcoWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            const acknowledged = Schema.decodeUnknownOption(ChangeOrganizationCustomerProfileIcoResultSchema)(result);
            return yield* outcome(input, Option.isSome(acknowledged) ? 'accepted_change' : 'denied');
          },
        ),
        PartyCorrect: Effect.fn('SymmyPartyCommerceAdapters.PartyCorrect')(function* invokePartyCorrect(
          intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'PartyCorrect' }>,
        ) {
          const payload = yield* Schema.decodeUnknownEffect(CorrectPartyFactPayloadSchema)(intent.payload);
          yield* correctPartyFactWithAuthorization(payload, context.authorization, context.partyOptions);
          return yield* outcome(input, 'accepted_change');
        }),
        PartyCreate: Effect.fn('SymmyPartyCommerceAdapters.PartyCreate')(function* invokePartyCreate(
          intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'PartyCreate' }>,
        ) {
          const payload = yield* Schema.decodeUnknownEffect(CreatePartyPayloadSchema)(intent.payload);
          const result = yield* createPartyWithAuthorization(payload, context.authorization, context.partyOptions);
          yield* recordCreatedParty(input, result);
          return yield* outcome(input, createdPartyStatus(result.outcome));
        }),
        PartyMatch: Effect.fn('SymmyPartyCommerceAdapters.PartyMatch')(function* invokePartyMatch(
          intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'PartyMatch' }>,
        ) {
          const payload = yield* Schema.decodeUnknownEffect(MatchPartyPayloadSchema)(intent.payload);
          const result = yield* matchPartyWithAuthorization(payload, context.authorization, context.partyOptions);
          yield* recordMatchedParty(input, result);
          return yield* outcome(input, matchedPartyStatus(result.outcome));
        }),
        PartyUpdate: Effect.fn('SymmyPartyCommerceAdapters.PartyUpdate')(function* invokePartyUpdate(
          intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'PartyUpdate' }>,
        ) {
          const payload = yield* Schema.decodeUnknownEffect(UpdatePartyPayloadSchema)(intent.payload);
          yield* updatePartyWithAuthorization(payload, context.authorization, context.partyOptions);
          return yield* outcome(input, 'accepted_change');
        }),
        RemoveSavedAddress: Effect.fn('SymmyPartyCommerceAdapters.RemoveSavedAddress')(
          function* invokeRemoveSavedAddress(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'RemoveSavedAddress' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(RemoveSavedAddressPayloadSchema)(intent.payload);
            const result = yield* executeRemoveSavedAddressWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            return yield* outcome(input, 'outcome' in result ? changedStatus(result.outcome === 'REMOVED') : 'denied');
          },
        ),
        UpdatePartyContactPoint: Effect.fn('SymmyPartyCommerceAdapters.UpdatePartyContactPoint')(
          function* invokeUpdateContact(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'UpdatePartyContactPoint' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(UpdateContactPointPayloadSchema)(intent.payload);
            yield* updateContactPointWithAuthorization(payload, context.authorization, context.partyOptions);
            return yield* contactReceiptAfterAcknowledgement(crypto, acknowledgedInput, 'UPDATE_CONTACT_POINT', intent);
          },
        ),
        UpdateSavedAddress: Effect.fn('SymmyPartyCommerceAdapters.UpdateSavedAddress')(
          function* invokeUpdateSavedAddress(
            intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'UpdateSavedAddress' }>,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(UpdateSavedAddressPayloadSchema)(intent.payload);
            const result = yield* executeUpdateSavedAddressWithAuthorization(
              payload,
              context.authorization,
              context.requestCorrelation,
              context.options,
            );
            return yield* outcome(input, 'outcome' in result ? changedStatus(result.outcome === 'UPDATED') : 'denied');
          },
        ),
      }),
      Match.exhaustive,
      Effect.flatMap((result) => captureAcknowledgedNativeInvocation(acknowledgedInput, result)),
    );
  },
  (effect, _crypto, _operation, input) =>
    effect.pipe(Effect.matchEffect({ onFailure: (error) => ownerFailure(input, error), onSuccess: Effect.succeed })),
);

const recoverGroup = Effect.fn('SymmyPartyCommerceAdapters.recoverGroup')(function* recoverGroup(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerGroupCreate' | 'CustomerGroupUpdate' }>,
) {
  const { source } = intent.payload;
  if (source === undefined) {
    return unavailableRecovery;
  }
  const expectedOperation = 'groupRef' in intent.payload ? 'UPDATE' : 'CREATE';
  const request = yield* Schema.decodeUnknownEffect(CustomerGroupDefinitionSourceRequestSchema)({
    effectId: source.effectId,
    expectedIntent: intent.payload,
    expectedOperation,
    issuer: source.issuer,
    mappingRevision: source.mappingRevision,
    mode: 'RECEIPT',
    namespace: source.namespace,
    route: source.route,
  });
  const requestHash = yield* readRequestHash(CustomerGroupDefinitionSourceRequestSchema, request);
  const authorized = yield* freshRecoveryContext(
    crypto,
    input,
    'commerce.customer-context.customer-group-definition-source.read',
    commerce,
    'commerce.customer-context.api.customer-group-definition-source',
    requestHash,
  );
  if (Option.isNone(authorized)) {
    return unavailableRecovery;
  }
  const context = authorized.value;
  const receipt = yield* executeCustomerGroupDefinitionSourceWithAuthorization(
    request,
    context.authorization,
    context.requestCorrelation,
    context.options,
  );
  return yield* Match.value(receipt).pipe(
    Match.tag(
      'RECEIPT',
      Effect.fn('SymmyPartyCommerceAdapters.groupReceipt')(function* recoveredGroup(
        found: Extract<CustomerGroupDefinitionSourceResponse, { readonly _tag: 'RECEIPT' }>,
      ) {
        if (found.source.effectId !== input.effect.ref.effectId || found.operation !== expectedOperation) {
          return unavailableRecovery;
        }
        const changed = Match.value(found).pipe(
          Match.when({ operation: 'CREATE' }, (original) => original.created),
          Match.orElse((original) => original.changed),
        );
        return { outcome: yield* outcome(input, changedStatus(changed)), status: 'settled' as const };
      }),
    ),
    Match.orElse(() => Effect.succeed(unavailableRecovery)),
  );
});

const recoverMembership = Effect.fn('SymmyPartyCommerceAdapters.recoverMembership')(function* recoverMembership(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerGroupMembership' }>,
) {
  const payload = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)(intent.payload);
  const request = yield* Schema.decodeUnknownEffect(CustomerGroupMembershipSourceReceiptRequestSchema)({
    effectId: payload.source.effectId,
    manager: payload.manager,
    profile: payload.profile,
    route: payload.route,
  });
  const requestHash = yield* readRequestHash(CustomerGroupMembershipSourceReceiptRequestSchema, request);
  const authorized = yield* freshRecoveryContext(
    crypto,
    input,
    'commerce.customer-context.customer-group-membership-source-receipt.read',
    commerce,
    'commerce.customer-context.api.customer-group-membership-source-receipt',
    requestHash,
  );
  if (Option.isNone(authorized)) {
    return unavailableRecovery;
  }
  const context = authorized.value;
  const receipt = yield* executeCustomerGroupMembershipSourceReceiptWithAuthorization(
    request,
    context.authorization,
    context.requestCorrelation,
    context.options,
  );
  if (
    receipt.source.effectId !== payload.source.effectId ||
    receipt.source.assertionId !== payload.source.assertionId
  ) {
    return unavailableRecovery;
  }
  return { outcome: yield* outcome(input, changedStatus(membershipChanged(receipt))), status: 'settled' as const };
});

const recoverOrganizationIco = Effect.fn('SymmyPartyCommerceAdapters.recoverOrganizationIco')(
  function* recoverOrganizationIco(
    crypto: Crypto.Crypto,
    input: SymmyEffectAdapterInput,
    intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'OrganizationCustomerProfileIco' }>,
  ) {
    const payload = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)(
      intent.payload,
    );
    if (input.originalExecutorPrincipalId === undefined || input.originalRequestHash === undefined) {
      return unavailableRecovery;
    }
    const original = yield* input.readOriginalActionInvocation({
      actionKey: input.effect.ref.operation.entrypointKey,
      idempotencyKey: input.effect.ref.effectId,
      originalPrincipalId: input.originalExecutorPrincipalId,
      requestHash: input.originalRequestHash,
    });
    if (
      Option.isNone(original) ||
      original.value.status !== 'succeeded' ||
      (input.originalInvocationId !== undefined && input.originalInvocationId !== original.value.actionInvocationId)
    ) {
      return unavailableRecovery;
    }
    const request = yield* Schema.decodeUnknownEffect(OrganizationCustomerProfileIcoRequestSchema)({
      actionInvocationId: original.value.actionInvocationId,
      profileRef: payload.profileRef,
    });
    const requestHash = yield* readRequestHash(OrganizationCustomerProfileIcoRequestSchema, request);
    const authorized = yield* freshRecoveryContext(
      crypto,
      input,
      'commerce.customer-context.organization-customer-profile-ico.read',
      commerce,
      'commerce.customer-context.api.organization-customer-profile-ico',
      requestHash,
    );
    if (Option.isNone(authorized)) {
      return unavailableRecovery;
    }
    const context = authorized.value;
    const response = yield* executeOrganizationCustomerProfileIcoWithAuthorization(
      request,
      context.authorization,
      context.requestCorrelation,
      context.options,
    );
    const found = Match.value(response).pipe(
      Match.tag('RECEIPT', (value) => Option.some(value.assertion)),
      Match.orElse(() => Option.none()),
    );
    if (Option.isNone(found)) {
      return unavailableRecovery;
    }
    const assertion = found.value;
    const ownerInvocation = Match.value(assertion.provenance.ownerReceiptRef).pipe(
      Match.when({ _tag: 'CORE_ACTION_INVOCATION' }, (value) => Option.some(value.actionInvocationId)),
      Match.orElse(() => Option.none<string>()),
    );
    if (
      Option.isNone(ownerInvocation) ||
      ownerInvocation.value !== original.value.actionInvocationId ||
      assertion.profileRef.resourceId !== payload.profileRef.resourceId ||
      assertion.profileRef.tenantId !== payload.profileRef.tenantId ||
      assertion.operation !== payload.operation ||
      assertion.revision !== payload.expectedRevision + 1 ||
      assertion.effectiveAt !== payload.effectiveAt
    ) {
      return unavailableRecovery;
    }
    const numeric = Match.value(payload).pipe(
      Match.when({ operation: 'END' }, () => assertion.normalizedValue === null),
      Match.orElse(
        (value) =>
          assertion.originalInput.kind === 'KNOWN' &&
          assertion.originalInput.digits === value.originalInput &&
          assertion.normalizedValue === normalizeOfficialIdentifier(value.identifier).normalizedValue,
      ),
    );
    if (!numeric) {
      return unavailableRecovery;
    }
    return { outcome: yield* outcome(input, 'accepted_change'), status: 'settled' as const };
  },
);
const sameIcoIntent = Schema.toEquivalence(ChangeCustomerProfileIcoPayloadSchema);
const recoverIco = Effect.fn('SymmyPartyCommerceAdapters.recoverIco')(function* recoverIco(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CustomerProfileIco' }>,
) {
  const payload = yield* Schema.decodeUnknownEffect(ChangeCustomerProfileIcoPayloadSchema)(intent.payload);
  const request = yield* Schema.decodeUnknownEffect(CustomerProfileIcoRequestSchema)({
    authorizationSubject: payload.authorizationSubject,
    effectId: payload.effectId,
    profileRef: payload.profileRef,
  });
  const requestHash = yield* readRequestHash(CustomerProfileIcoRequestSchema, request);
  const authorized = yield* freshRecoveryContext(
    crypto,
    input,
    'commerce.customer-context.customer-profile-ico.read',
    commerce,
    'commerce.customer-context.api.customer-profile-ico',
    requestHash,
  );
  if (Option.isNone(authorized)) {
    return unavailableRecovery;
  }
  const context = authorized.value;
  const receipt = yield* executeCustomerProfileIcoWithAuthorization(
    request,
    context.authorization,
    context.requestCorrelation,
    context.options,
  );
  return yield* Match.value(receipt).pipe(
    Match.tag(
      'RECEIPT',
      Effect.fn('SymmyPartyCommerceAdapters.icoReceipt')(function* recoveredIco(
        found: Extract<typeof CustomerProfileIcoResponseSchema.Type, { readonly _tag: 'RECEIPT' }>,
      ) {
        const { assertion } = found;
        if (assertion.effectId !== payload.effectId || assertion.operation !== payload.operation) {
          return unavailableRecovery;
        }
        const restored = {
          ...payload,
          effectiveAt: assertion.effectiveAt,
          expectedRevision: assertion.revision - 1,
          operation: assertion.operation,
          provenance: assertion.provenance,
          reason: assertion.reason,
        };
        if (restored.operation !== 'END' && 'originalInput' in restored) {
          restored.originalInput = assertion.originalInput ?? '';
        }
        const recoveredPayload = yield* Schema.decodeUnknownEffect(ChangeCustomerProfileIcoPayloadSchema)(restored);
        if (!sameIcoIntent(payload, recoveredPayload)) {
          return unavailableRecovery;
        }
        return { outcome: yield* outcome(input, 'accepted_change'), status: 'settled' as const };
      }),
    ),
    Match.orElse(() => Effect.succeed(unavailableRecovery)),
  );
});

const profilePayloadSchema = Schema.Union([
  EnsureRetailCustomerProfilePayloadSchema,
  CreateCounterpartyPurchasingProfilePayloadSchema,
]);
const sameProfileIntent = Schema.toEquivalence(profilePayloadSchema);
const recoverProfileMode = Effect.fn('SymmyPartyCommerceAdapters.recoverProfileMode')(function* recoverProfileMode(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'EnsureRetailProfile' | 'CreateCounterpartyProfile' }>,
  mode: 'RECEIPT' | 'MINIMAL_RECEIPT' | 'ORG_RECEIPT',
) {
  const expected = yield* Schema.decodeUnknownEffect(profilePayloadSchema)(intent.payload);
  const { source } = expected;
  if (source === undefined) {
    return unavailableRecovery;
  }
  const request = yield* Schema.decodeUnknownEffect(CustomerProfileSourceRequestSchema)({
    effectId: source.effectId,
    issuer: source.issuer,
    mappingRevision: source.mappingRevision,
    mode,
    namespace: source.namespace,
    recordType: source.recordType,
    route: source.route,
  });
  const requestHash = yield* readRequestHash(CustomerProfileSourceRequestSchema, request);
  const authorized = yield* freshRecoveryContext(
    crypto,
    input,
    'commerce.customer-context.customer-profile-source.read',
    commerce,
    'commerce.customer-context.api.customer-profile-source',
    requestHash,
  );
  if (Option.isNone(authorized)) {
    return unavailableRecovery;
  }
  const context = authorized.value;
  const result = yield* executeCustomerProfileSourceWithAuthorization(
    request,
    context.authorization,
    context.requestCorrelation,
    context.options,
  );
  if (mode === 'ORG_RECEIPT') {
    return yield* Match.value(result).pipe(
      Match.tag(
        'ORG_RECEIPT',
        Effect.fn('SymmyPartyCommerceAdapters.organizationProfileReceipt')(function* organizationProfileReceipt(found: {
          readonly _tag: 'ORG_RECEIPT';
          readonly receipt: typeof OrganizationProfileSourceReceiptSchema.Type;
        }) {
          const target = Match.value(intent).pipe(
            Match.tag('CreateCounterpartyProfile', (value) => Option.some(value.payload.subject)),
            Match.orElse(() => Option.none()),
          );
          if (Option.isNone(target)) {
            return unavailableRecovery;
          }
          const projected = yield* Schema.decodeUnknownEffect(OrganizationProfileSourceReceiptSchema.fields.intent)({
            effectiveAt: expected.effectiveAt,
            partySourceReference: expected.partySourceReference,
            source: expected.source,
            subject: { counterpartyRef: target.value.counterpartyRef, kind: 'COUNTERPARTY' },
            trigger: expected.trigger,
          });
          if (
            !Schema.toEquivalence(OrganizationProfileSourceReceiptSchema.fields.intent)(projected, found.receipt.intent)
          ) {
            return unavailableRecovery;
          }
          yield* saveOwnerReceipt(input, {
            _tag: 'CounterpartyProfileCreated',
            actionInvocationId: found.receipt.actionInvocationId,
            counterpartyRef: found.receipt.intent.subject.counterpartyRef,
            profileRef: found.receipt.result.profileRef,
          });
          return {
            outcome: yield* outcome(input, changedStatus(found.receipt.result.outcome === 'PROFILE_CREATED')),
            status: 'settled' as const,
          };
        }),
      ),
      Match.orElse(() => Effect.succeed(unavailableRecovery)),
    );
  }
  return yield* Match.value(result).pipe(
    Match.tag(
      'RECEIPT',
      'MINIMAL_RECEIPT',
      Effect.fn('SymmyPartyCommerceAdapters.profileReceipt')(function* recoveredProfile(
        found: Extract<CustomerProfileSourceResponse, { readonly _tag: 'RECEIPT' | 'MINIMAL_RECEIPT' }>,
      ) {
        if (!sameProfileIntent(expected, found.receipt.intent)) {
          return unavailableRecovery;
        }
        yield* Match.value(found.receipt).pipe(
          Match.when({ profileKind: 'RETAIL' }, (original) =>
            saveOwnerReceipt(input, {
              _tag: 'RetailProfileEnsured',
              actionInvocationId: original.actionInvocationId,
              partyRef: original.intent.subject.partyRef,
              profileRef: original.result.profileRef,
            }),
          ),
          Match.orElse((original) =>
            saveOwnerReceipt(input, {
              _tag: 'CounterpartyProfileCreated',
              actionInvocationId: original.actionInvocationId,
              counterpartyRef: original.intent.subject.counterpartyRef,
              profileRef: original.result.profileRef,
            }),
          ),
        );
        return {
          outcome: yield* outcome(input, changedStatus(found.receipt.result.outcome === 'PROFILE_CREATED')),
          status: 'settled' as const,
        };
      }),
    ),
    Match.orElse(() => Effect.succeed(unavailableRecovery)),
  );
});

const recoverProfile = Effect.fn('SymmyPartyCommerceAdapters.recoverProfile')(function* recoverProfile(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'EnsureRetailProfile' | 'CreateCounterpartyProfile' }>,
) {
  const organization = Match.value(intent).pipe(
    Match.tag('CreateCounterpartyProfile', (value) => value.payload.sourceOrganizationWitness !== undefined),
    Match.orElse(() => false),
  );
  if (organization) {
    return yield* recoverProfileMode(crypto, input, intent, 'ORG_RECEIPT');
  }
  return yield* recoverProfileMode(crypto, input, intent, 'RECEIPT').pipe(
    Effect.catchTag('CustomerProfileSourceForbiddenProblem', (cause) =>
      Match.value(intent).pipe(
        Match.tag('EnsureRetailProfile', (selected) => recoverProfileMode(crypto, input, selected, 'MINIMAL_RECEIPT')),
        Match.orElse(() => Effect.fail(cause)),
      ),
    ),
  );
});

const recoverAssignment = Effect.fn('SymmyPartyCommerceAdapters.recoverAssignment')(function* recoverAssignment(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: Extract<
    SymmyPartyCommerceIntent,
    { readonly _tag: 'AssignCustomerPriceGroup' | 'AssignCounterpartyPriceGroup' }
  >,
) {
  if (input.originalExecutorPrincipalId === undefined || input.originalRequestHash === undefined) {
    return unavailableRecovery;
  }
  const original = yield* input.readOriginalActionInvocation({
    actionKey: input.effect.ref.operation.entrypointKey,
    idempotencyKey: input.effect.ref.effectId,
    originalPrincipalId: input.originalExecutorPrincipalId,
    requestHash: input.originalRequestHash,
  });
  if (Option.isNone(original) || original.value.status !== 'succeeded') {
    return unavailableRecovery;
  }
  if (input.originalInvocationId !== undefined && input.originalInvocationId !== original.value.actionInvocationId) {
    return unavailableRecovery;
  }
  // The receiving owner derives current recovery Privacy from its immutable original source.
  const originalCommand = Match.value(intent).pipe(
    Match.tag('AssignCustomerPriceGroup', (selected) => ({ _tag: 'RETAIL' as const, payload: selected.payload })),
    Match.tag('AssignCounterpartyPriceGroup', (selected) => ({
      _tag: 'COUNTERPARTY' as const,
      payload: selected.payload,
    })),
    Match.exhaustive,
  );
  const request = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)({
    actionInvocationId: original.value.actionInvocationId,
    authorizationSubject: intent.authorizationSubject,
    originalCommand,
    profile: intent.payload.profile,
  });
  const requestHash = yield* readRequestHash(CustomerPriceGroupAssignmentReceiptRequestSchema, request);
  const authorized = yield* freshRecoveryContext(
    crypto,
    input,
    'commerce.customer-context.customer-price-group-assignment-receipt.read',
    commerce,
    'commerce.customer-context.api.customer-price-group-assignment-receipt',
    requestHash,
  );
  if (Option.isNone(authorized)) {
    return unavailableRecovery;
  }
  const context = authorized.value;
  const result = yield* executeCustomerPriceGroupAssignmentReceiptWithAuthorization(
    request,
    context.authorization,
    context.requestCorrelation,
    context.options,
  );
  return yield* Match.value(result).pipe(
    Match.tag(
      'COMMITTED',
      Effect.fn('SymmyPartyCommerceAdapters.assignmentReceipt')(function* recoveredAssignment(
        found: Extract<CustomerPriceGroupAssignmentReceiptResponse, { readonly _tag: 'COMMITTED' }>,
      ) {
        if (found.receipt.actionInvocationId !== original.value.actionInvocationId) {
          return unavailableRecovery;
        }
        return { outcome: yield* outcome(input, changedStatus(found.receipt.changed)), status: 'settled' as const };
      }),
    ),
    Match.tag('INDETERMINATE', () => Effect.succeed(unavailableRecovery)),
    Match.exhaustive,
  );
});

const recoverSavedAddress = Effect.fn('SymmyPartyCommerceAdapters.recoverSavedAddress')(function* recoverSavedAddress(
  crypto: Crypto.Crypto,
  input: SymmyEffectAdapterInput,
  intent: Extract<
    SymmyPartyCommerceIntent,
    { readonly _tag: 'AddSavedAddress' | 'UpdateSavedAddress' | 'RemoveSavedAddress' }
  >,
) {
  const { profile, source } = intent.payload;
  if (source === undefined || input.originalInvocationId === undefined || input.originalRequestHash === undefined) {
    return unavailableRecovery;
  }
  const request = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
    actionInvocationId: input.originalInvocationId,
    actionKey: input.effect.ref.operation.entrypointKey,
    mode: 'RECEIPT',
    profile,
    requestHash: input.originalRequestHash,
    source,
  });
  const hash = yield* readRequestHash(SavedAddressSourceReceiptRequestSchema, request);
  const authorized = yield* freshRecoveryContext(
    crypto,
    input,
    'commerce.customer-context.saved-address-source-receipt.read',
    commerce,
    'commerce.customer-context.api.saved-address-source-receipt',
    hash,
  );
  if (Option.isNone(authorized)) {
    return unavailableRecovery;
  }
  const context = authorized.value;
  const result = yield* executeSavedAddressSourceReceiptWithAuthorization(
    request,
    context.authorization,
    context.requestCorrelation,
    context.options,
  );
  return yield* Match.value(result).pipe(
    Match.tag(
      'RECEIPT',
      Effect.fn('SymmyPartyCommerceAdapters.savedAddressReceipt')(function* recoveredSavedAddress(
        found: Extract<SavedAddressSourceReceiptResponse, { readonly _tag: 'RECEIPT' }>,
      ) {
        const expectedOperation = Match.value(intent).pipe(
          Match.tags({
            AddSavedAddress: () => 'ADD',
            RemoveSavedAddress: () => 'REMOVE',
            UpdateSavedAddress: () => 'UPDATE',
          }),
          Match.exhaustive,
        );
        const originalProfile = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema.fields.profile)(
          intent.payload.profile,
        );
        if (
          found.receipt.actionInvocationId !== input.originalInvocationId ||
          found.receipt.requestHash !== input.originalRequestHash ||
          found.receipt.operation !== expectedOperation ||
          !Schema.toEquivalence(AddSavedAddressPayloadSchema.fields.profile)(found.receipt.profile, originalProfile) ||
          ('savedAddressRef' in intent.payload &&
            (found.receipt.savedAddressRef.resourceId !== intent.payload.savedAddressRef.resourceId ||
              found.receipt.savedAddressRef.tenantId !== intent.payload.savedAddressRef.tenantId))
        ) {
          return unavailableRecovery;
        }
        const changed = Schema.is(Schema.Literals(['ADDED', 'UPDATED', 'REMOVED']))(found.receipt.outcome);
        return { outcome: yield* outcome(input, changedStatus(changed)), status: 'settled' as const };
      }),
    ),
    Match.orElse(() => Effect.succeed(unavailableRecovery)),
  );
});

const recoverIntent = Effect.fn('SymmyPartyCommerceAdapters.recover')(function* recoverIntent(
  crypto: Crypto.Crypto,
  operation: Operation,
  input: SymmyEffectAdapterInput,
) {
  const normalizedIntent = yield* decodeIntent(input, operation);
  return yield* Match.value(normalizedIntent).pipe(
    Match.tags({
      AddPartyContactPoint: (selected) => recoverParty(crypto, input, 'ADD_CONTACT_POINT', selected),
      AddPartyContactPointFromParty: () => Effect.succeed(unavailableRecovery),
      AddSavedAddress: (selected) => recoverSavedAddress(crypto, input, selected),
      AddSavedCounterpartyAddressFromOwnerReceipts: () => Effect.succeed(unavailableRecovery),
      AddSavedRetailAddressFromOwnerReceipts: () => Effect.succeed(unavailableRecovery),
      AssignCounterpartyPriceGroup: (selected) => recoverAssignment(crypto, input, selected),
      AssignCustomerPriceGroup: (selected) => recoverAssignment(crypto, input, selected),
      CreateCounterpartyProfile: (selected) => recoverProfile(crypto, input, selected),
      CreateCounterpartyProfileFromCounterparty: () => Effect.succeed(unavailableRecovery),
      CustomerGroupCreate: (selected) => recoverGroup(crypto, input, selected),
      CustomerGroupMembership: (selected) => recoverMembership(crypto, input, selected),
      CustomerGroupUpdate: (selected) => recoverGroup(crypto, input, selected),
      CustomerProfileIco: (selected) => recoverIco(crypto, input, selected),
      EndPartyContactPoint: (selected) => recoverParty(crypto, input, 'END_CONTACT_POINT', selected),
      EnsureRetailProfile: (selected) => recoverProfile(crypto, input, selected),
      EnsureRetailProfileFromParty: () => Effect.succeed(unavailableRecovery),
      OnboardCounterpartyCustomer: (selected) => recoverParty(crypto, input, 'ONBOARD_COUNTERPARTY_CUSTOMER', selected),
      OnboardCounterpartyCustomerFromParty: () => Effect.succeed(unavailableRecovery),
      OrganizationCustomerProfileIco: (selected) => recoverOrganizationIco(crypto, input, selected),
      PartyCorrect: (selected) => recoverParty(crypto, input, 'CORRECTION', selected),
      PartyCreate: (selected) => recoverParty(crypto, input, 'CREATE', selected),
      PartyMatch: (selected) => recoverParty(crypto, input, 'MATCH', selected),
      PartyUpdate: (selected) => recoverParty(crypto, input, 'UPDATE', selected),
      RemoveSavedAddress: (selected) => recoverSavedAddress(crypto, input, selected),
      UpdatePartyContactPoint: (selected) => recoverParty(crypto, input, 'UPDATE_CONTACT_POINT', selected),
      UpdateSavedAddress: (selected) => recoverSavedAddress(crypto, input, selected),
    }),
    Match.exhaustive,
  );
}, Effect.mapError(symmyJobWorkerUnavailable));

const recoverWithOriginalCommand = Effect.fn('SymmyPartyCommerceAdapters.recoverOriginalCommand')(
  function* recoverWithOriginalCommand(
    crypto: Crypto.Crypto,
    operation: Operation,
    originalInput: SymmyEffectAdapterInput,
  ) {
    const input = yield* resolveDependencies(originalInput);
    if (
      input.originalExecutorPrincipalId === undefined ||
      input.originalRequestHash === undefined ||
      input.originalAuthContextRef === undefined
    ) {
      return unavailableRecovery;
    }
    const original = yield* input.readOriginalActionInvocation({
      actionKey: input.effect.ref.operation.entrypointKey,
      idempotencyKey: input.effect.ref.effectId,
      originalPrincipalId: input.originalExecutorPrincipalId,
      requestHash: input.originalRequestHash,
    });
    if (Option.isSome(original)) {
      if (
        input.originalInvocationId !== undefined &&
        input.originalInvocationId !== original.value.actionInvocationId
      ) {
        return unavailableRecovery;
      }
      yield* input.recordInvocationId(original.value.actionInvocationId);
      if (original.value.status !== 'succeeded') {
        return unavailableRecovery;
      }
      // A known committed invocation is reconciled through authorized Reads only, even when they fail.
      return yield* recoverIntent(crypto, operation, {
        ...input,
        originalInvocationId: original.value.actionInvocationId,
      });
    }
    if (input.originalInvocationId !== undefined || !input.canExecuteNewEffects) {
      return unavailableRecovery;
    }
    // An absent observation does not prove rollback. The exact original actor, body and Core key still
    // serialize any overlapping old request; no replacement actor, target or key is introduced.
    const retried = yield* executeIntent(crypto, operation, input);
    if (
      retried.status !== 'accepted_change' &&
      retried.status !== 'accepted_no_change' &&
      retried.status !== 'ambiguous' &&
      retried.status !== 'unresolved'
    ) {
      return unavailableRecovery;
    }
    return { outcome: retried, status: 'settled' as const };
  },
);

export const makeSymmyPartyCommerceAdapters = Effect.gen(function* partyCommerceAdapters() {
  const crypto = yield* Crypto.Crypto;
  return operations.map((operation): SymmyEffectAdapter => ({
    execute: (input) => executeIntent(crypto, operation, input),
    operation: { entrypointKey: operation.entrypointKey, moduleId: operation.moduleId, schemaVersion: '1' },
    recover: (input) => recoverWithOriginalCommand(crypto, operation, input),
  }));
});

export class SymmyPartyCommerceAdapters extends Context.Service<
  SymmyPartyCommerceAdapters,
  {
    readonly adapters: readonly SymmyEffectAdapter[];
  }
>()('@app/symmy-integration/services/symmy-party-commerce-adapters/SymmyPartyCommerceAdapters') {}
export const SymmyPartyCommerceAdaptersLive = Layer.effect(
  SymmyPartyCommerceAdapters,
  makeSymmyPartyCommerceAdapters.pipe(Effect.map((adapters) => ({ adapters }))),
);
