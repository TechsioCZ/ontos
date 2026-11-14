import { AssignCounterpartyPriceGroupResultSchema } from '@app/commerce-customer-context/actions/assign-counterparty-price-group';
import { AssignCounterpartyPriceGroupActionForbiddenProblemSchema } from '@app/commerce-customer-context/api/assign-counterparty-price-group-action';
import { ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema } from '@app/commerce-customer-context/api/change-organization-customer-profile-ico-action';
import { OrganizationCustomerProfileIcoForbiddenProblemSchema } from '@app/commerce-customer-context/api/organization-customer-profile-ico';
import {
  ChangeOrganizationCustomerProfileIcoResultSchema,
  OrganizationCustomerProfileIcoResponseSchema,
} from '@app/commerce-customer-context/domain/organization-profile-ico';
import type { executeChangeOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/change-organization-customer-profile-ico-action/client';
import type { executeOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/organization-customer-profile-ico/client';
import {
  CustomerGroupDefinitionSourceResponseSchema,
  CustomerGroupDefinitionSourceUnavailableProblemSchema,
} from '@app/commerce-customer-context/api/customer-group-definition-source';
import type { executeCustomerGroupDefinitionSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-group-definition-source/client';
import type { executeCustomerGroupMembershipSourceReceiptWithAuthorization } from '@app/commerce-customer-context/api/customer-group-membership-source-receipt/client';
import { ApplyCustomerGroupMembershipSourceResultSchema } from '@app/commerce-customer-context/actions/apply-customer-group-membership-source';
import {
  OrganizationBusinessSourceStatement,
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessCustomerRoleReason,
  OrganizationBusinessOnboardTemplateProjectionVersion,
} from '@app/party-registry/apis/organization-record-facts';
import { UpdateCustomerGroupActionIneligibleProblemSchema } from '@app/commerce-customer-context/api/update-customer-group-action';
import type {
  executeUpdateCustomerGroupWithAuthorization,
  executeApplyCustomerGroupMembershipSourceWithAuthorization,
  executeAssignCounterpartyPriceGroupWithAuthorization,
  executeEnsureRetailCustomerProfileWithAuthorization,
  executeAssignCustomerPriceGroupWithAuthorization,
} from '@app/commerce-customer-context/api/client';
import type { executeCustomerProfileSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-source/client';
import {
  CustomerProfileSourceResponseSchema,
  CustomerProfileSourceForbiddenProblemSchema,
  CustomerProfileSourceUnavailableProblemSchema,
} from '@app/commerce-customer-context/api/customer-profile-source';
import type { executeAddSavedAddressWithAuthorization } from '@app/commerce-customer-context/api/add-saved-address-action/client';
import type { executeSavedAddressSourceReceiptWithAuthorization } from '@app/commerce-customer-context/api/saved-address-source-receipt/client';
import { SavedAddressSourceReceiptResponseSchema } from '@app/commerce-customer-context/api/saved-address-source-receipt';
import { AddSavedAddressResultSchema } from '@app/commerce-customer-context/actions/add-saved-address';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { EnsureRetailCustomerProfileResultSchema } from '@app/commerce-customer-context/actions/ensure-retail-customer-profile';
import type { executeSourceProcessingEligibilityWithAuthorization } from '@app/privacy/api/client';
import type { executeCustomerPriceGroupAssignmentReceiptWithAuthorization } from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt/client';
import { SourceProcessingEligibilityResponseSchema } from '@app/privacy/api/source-processing-eligibility';
import { CustomerPriceGroupAssignmentReceiptForbiddenProblemSchema } from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt';
import { AssignCustomerPriceGroupResultSchema } from '@app/commerce-customer-context/actions/assign-customer-price-group';
import type {
  createPartyWithAuthorization,
  endContactPointWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
} from '@app/party-registry/api/client';
import type { executePartySourceEffectReceiptWithAuthorization } from '@app/party-registry/apis/party-source-effect-receipt/client';
import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';
import {
  CreatePartyResultSchema,
  CounterpartyCustomerOnboardResultSchema,
  PartyCommandCommitIndeterminateProblemSchema,
  EndContactPointResultSchema,
} from '@app/party-registry/api';
import {
  PartySourceEffectReceiptResponseSchema,
  PartySourceEffectReceiptForbiddenProblemSchema,
} from '@app/party-registry/apis/party-source-effect-receipt';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Effect, Match, Option, Result, Schema } from 'effect';
import { describe, expect, it, rs } from 'effect-rstest';

import {
  SymmyPartyCommerceOwnerReceiptSchema,
  SymmyPartyCommerceIntentSchema,
} from '../../shared/domain/symmy-party-commerce-intents.ts';
import { SymmyPinnedJobPlanSchema, SymmyPinnedEffectSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyEffectAdapterInput } from '../../src/services/symmy-effect-adapters.service.ts';
import {
  makeSymmyPartyCommerceAdapters,
  prepareSymmyPartyCommerceRequestHash,
} from '../../src/services/symmy-party-commerce-adapters.ts';
import { symmyJobWorkerUnavailable } from '../../src/services/symmy-job-worker-error.ts';

const executorPrincipalId = '10000000-0000-4000-8000-000000000008';
const fixtureAuthContextRef = 'job:integration.symmy.execute-symmy-job:run:10000000-0000-4000-8000-000000000010';
type CreatePartyClient = typeof createPartyWithAuthorization;
type ReceiptClient = typeof executePartySourceEffectReceiptWithAuthorization;
interface AdapterCalls {
  address: ReturnType<typeof rs.fn<typeof executeAddSavedAddressWithAuthorization>>;
  addressReceipt: ReturnType<typeof rs.fn<typeof executeSavedAddressSourceReceiptWithAuthorization>>;
  assignment: ReturnType<typeof rs.fn<typeof executeAssignCustomerPriceGroupWithAuthorization>>;
  assignmentReceipt: ReturnType<typeof rs.fn<typeof executeCustomerPriceGroupAssignmentReceiptWithAuthorization>>;
  counterpartyAssignment: ReturnType<typeof rs.fn<typeof executeAssignCounterpartyPriceGroupWithAuthorization>>;
  create: ReturnType<typeof rs.fn<CreatePartyClient>>;
  endContact: ReturnType<typeof rs.fn<typeof endContactPointWithAuthorization>>;
  exposeCommittedAckFact: boolean;
  fact: { actionInvocationId: string; status: string } | null;
  factReads: number;
  gateway: GatewayDelegationRequest[];
  groupDefinition: ReturnType<typeof rs.fn<typeof executeCustomerGroupDefinitionSourceWithAuthorization>>;
  hashes: { authContextRef: string; hash: string }[];
  membership: ReturnType<typeof rs.fn<typeof executeApplyCustomerGroupMembershipSourceWithAuthorization>>;
  membershipReceipt: ReturnType<typeof rs.fn<typeof executeCustomerGroupMembershipSourceReceiptWithAuthorization>>;
  onboard: ReturnType<typeof rs.fn<typeof counterpartyCustomerOnboardWithAuthorization>>;
  order: string[];
  organizationIco: ReturnType<typeof rs.fn<typeof executeChangeOrganizationCustomerProfileIcoWithAuthorization>>;
  organizationIcoRead: ReturnType<typeof rs.fn<typeof executeOrganizationCustomerProfileIcoWithAuthorization>>;
  privacy: ReturnType<typeof rs.fn<typeof executeSourceProcessingEligibilityWithAuthorization>>;
  profileReceipt: ReturnType<typeof rs.fn<typeof executeCustomerProfileSourceWithAuthorization>>;
  receipt: ReturnType<typeof rs.fn<ReceiptClient>>;
  retail: ReturnType<typeof rs.fn<typeof executeEnsureRetailCustomerProfileWithAuthorization>>;
  updateGroup: ReturnType<typeof rs.fn<typeof executeUpdateCustomerGroupWithAuthorization>>;
}
const calls = rs.hoisted((): AdapterCalls => ({
  address: rs.fn<typeof executeAddSavedAddressWithAuthorization>(),
  addressReceipt: rs.fn<typeof executeSavedAddressSourceReceiptWithAuthorization>(),
  assignment: rs.fn<typeof executeAssignCustomerPriceGroupWithAuthorization>(),
  assignmentReceipt: rs.fn<typeof executeCustomerPriceGroupAssignmentReceiptWithAuthorization>(),
  counterpartyAssignment: rs.fn<typeof executeAssignCounterpartyPriceGroupWithAuthorization>(),
  create: rs.fn<CreatePartyClient>(),
  endContact: rs.fn<typeof endContactPointWithAuthorization>(),
  exposeCommittedAckFact: true,
  fact: null,
  factReads: 0,
  gateway: [],
  groupDefinition: rs.fn<typeof executeCustomerGroupDefinitionSourceWithAuthorization>(),
  hashes: [],
  membership: rs.fn<typeof executeApplyCustomerGroupMembershipSourceWithAuthorization>(),
  membershipReceipt: rs.fn<typeof executeCustomerGroupMembershipSourceReceiptWithAuthorization>(),
  onboard: rs.fn<typeof counterpartyCustomerOnboardWithAuthorization>(),
  order: [],
  organizationIco: rs.fn<typeof executeChangeOrganizationCustomerProfileIcoWithAuthorization>(),
  organizationIcoRead: rs.fn<typeof executeOrganizationCustomerProfileIcoWithAuthorization>(),
  privacy: rs.fn<typeof executeSourceProcessingEligibilityWithAuthorization>(),
  profileReceipt: rs.fn<typeof executeCustomerProfileSourceWithAuthorization>(),
  receipt: rs.fn<ReceiptClient>(),
  retail: rs.fn<typeof executeEnsureRetailCustomerProfileWithAuthorization>(),
  updateGroup: rs.fn<typeof executeUpdateCustomerGroupWithAuthorization>(),
}));
const invocationId = '10000000-0000-4000-8000-000000000009';
// Published client successes model the native Core commit separately from its DTO; production reads real facts.
const fixtureCommittedAck = Effect.sync(() => {
  if (calls.exposeCommittedAckFact && calls.fact === null) {
    calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
  }
});
rs.mock('@app/commerce-customer-context/api/add-saved-address-action/client', () => ({
  executeAddSavedAddressWithAuthorization: (...args: Parameters<typeof executeAddSavedAddressWithAuthorization>) =>
    calls.address(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
}));
rs.mock('@app/commerce-customer-context/api/saved-address-source-receipt/client', () => ({
  executeSavedAddressSourceReceiptWithAuthorization: calls.addressReceipt,
}));
rs.mock('@app/commerce-customer-context/api/customer-profile-source/client', () => ({
  executeCustomerProfileSourceWithAuthorization: calls.profileReceipt,
}));
rs.mock('@app/commerce-customer-context/api/customer-group-definition-source/client', () => ({
  executeCustomerGroupDefinitionSourceWithAuthorization: calls.groupDefinition,
}));
rs.mock('@app/commerce-customer-context/api/customer-group-membership-source-receipt/client', () => ({
  executeCustomerGroupMembershipSourceReceiptWithAuthorization: calls.membershipReceipt,
}));
rs.mock('@app/commerce-customer-context/api/change-organization-customer-profile-ico-action/client', () => ({
  executeChangeOrganizationCustomerProfileIcoWithAuthorization: (
    ...args: Parameters<typeof executeChangeOrganizationCustomerProfileIcoWithAuthorization>
  ) => calls.organizationIco(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
}));
rs.mock('@app/commerce-customer-context/api/organization-customer-profile-ico/client', () => ({
  executeOrganizationCustomerProfileIcoWithAuthorization: calls.organizationIcoRead,
}));
rs.mock('@app/privacy/api/client', () => ({ executeSourceProcessingEligibilityWithAuthorization: calls.privacy }));
rs.mock('@app/commerce-customer-context/api/customer-price-group-assignment-receipt/client', () => ({
  executeCustomerPriceGroupAssignmentReceiptWithAuthorization: calls.assignmentReceipt,
}));
rs.mock('@app/commerce-customer-context/api/client', () => ({
  executeApplyCustomerGroupMembershipSourceWithAuthorization: (
    ...args: Parameters<typeof executeApplyCustomerGroupMembershipSourceWithAuthorization>
  ) => calls.membership(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
  executeAssignCounterpartyPriceGroupWithAuthorization: (
    ...args: Parameters<typeof executeAssignCounterpartyPriceGroupWithAuthorization>
  ) => calls.counterpartyAssignment(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
  executeAssignCustomerPriceGroupWithAuthorization: (
    ...args: Parameters<typeof executeAssignCustomerPriceGroupWithAuthorization>
  ) => calls.assignment(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
  executeChangeCustomerProfileIcoWithAuthorization: rs.fn(),
  executeCreateCounterpartyPurchasingProfileWithAuthorization: rs.fn(),
  executeCreateCustomerGroupWithAuthorization: rs.fn(),
  executeEnsureRetailCustomerProfileWithAuthorization: (
    ...args: Parameters<typeof executeEnsureRetailCustomerProfileWithAuthorization>
  ) => calls.retail(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
  executeUpdateCustomerGroupWithAuthorization: (
    ...args: Parameters<typeof executeUpdateCustomerGroupWithAuthorization>
  ) => calls.updateGroup(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
}));
rs.mock('@app/party-registry/api/client', () => ({
  addContactPointWithAuthorization: rs.fn(),
  correctPartyFactWithAuthorization: rs.fn(),
  counterpartyCustomerOnboardWithAuthorization: (
    ...args: Parameters<typeof counterpartyCustomerOnboardWithAuthorization>
  ) => calls.onboard(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
  createPartyWithAuthorization: (...args: Parameters<CreatePartyClient>) =>
    calls.create(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
  endContactPointWithAuthorization: (...args: Parameters<typeof endContactPointWithAuthorization>) =>
    calls.endContact(...args).pipe(Effect.tap(() => fixtureCommittedAck)),
  matchPartyWithAuthorization: rs.fn(),
  updateContactPointWithAuthorization: rs.fn(),
  updatePartyWithAuthorization: rs.fn(),
}));
rs.mock('@app/party-registry/apis/party-source-effect-receipt/client', () => ({
  executePartySourceEffectReceiptWithAuthorization: calls.receipt,
}));
rs.mock('@app/shared-contracts/gateway-context-server', () => ({
  acquireDelegatedGatewayContext: (request: GatewayDelegationRequest) => {
    calls.gateway.push(request);
    const recovery = Match.value(request.subject).pipe(
      Match.tag('RegisteredRecovery', (subject) => {
        if (calls.fact === null) {
          return Option.none();
        }
        return Option.some({
          originalActionInvocationId: calls.fact.actionInvocationId,
          originalActionKey: subject.originalActionKey,
          originalAuthContextRef: fixtureAuthContextRef,
          originalIdempotencyKey: subject.originalIdempotencyKey,
          originalPrincipalId: subject.originalPrincipalId,
          originalRequestHash: subject.originalRequestHash,
          requestHash: subject.requestHash,
        });
      }),
      Match.orElse(() => Option.none()),
    );
    const result = {
      apiBaseUrl: 'https://party.internal.fixture/party-registry-api',
      authorization: `Bearer internal-attempt-${calls.gateway.length}`,
      compositionRevision: 'c'.repeat(64),
      expiresAt: 1_700_000_300,
      machineContext: {
        authContextRef: fixtureAuthContextRef,
        bindingIncarnation: '10000000-0000-4000-8000-000000000007',
        principalId: executorPrincipalId,
      },
    };
    return Option.match(recovery, {
      onNone: () => Effect.succeed(result),
      onSome: (metadata) => Effect.succeed({ ...result, recovery: metadata }),
    });
  },
}));

const tenantId = '10000000-0000-4000-8000-000000000001';
const routeId = '10000000-0000-4000-8000-000000000002';
const effectId = '10000000-0000-4000-8000-000000000003';
const effect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  effectKey: 'create-party',
  intent: {
    _tag: 'PartyCreate',
    payload: {
      candidate: {
        evidenceRefs: ['internal:customer-1'],
        firstName: 'Internal',
        lastName: 'Customer',
        officialIdentifiers: [],
        partyType: 'PERSON',
        provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: 'internal-symmy' },
        subjectEvidence: [
          {
            kind: 'CLIENT_SOURCE_ASSERTION',
            observedSubject: 'PERSON',
            occurrenceId: 'occurrence-1',
            recordId: 'customer-1',
            source: { issuer: 'internal-symmy', namespace: 'customers', recordType: 'CUSTOMER', routeRef: routeId },
            sourceObservedAt: '2026-11-07T00:00:00.000Z',
            statement: 'The internal fixture asserts this person.',
            subjectKey: '10000000-0000-4000-8000-000000000004',
          },
        ],
        validFrom: '2026-11-07T00:00:00.000Z',
      },
    },
  },
  itemId: '10000000-0000-4000-8000-000000000005',
  ref: {
    effectId,
    mappingVersion: 'mapping-1',
    occurrence: {
      occurrenceId: 'occurrence-1',
      record: {
        entityKind: 'CUSTOMER',
        issuerId: 'internal-symmy',
        route: { integrationRouteId: routeId, tenantId },
        sourceNamespace: 'customers',
        sourceRecordId: 'customer-1',
      },
    },
    operation: { entrypointKey: 'party.registry.create-party', moduleId: 'party.registry', schemaVersion: '1' },
    routeRevision: 'route-1',
  },
});
const context = attestOutboxWorkerHandlerContext({
  actorPrincipalId: '10000000-0000-4000-8000-000000000006',
  attemptNumber: 1,
  claimId: 'claim:internal',
  compositionRevision: 'c'.repeat(64),
  consumerModuleKey: 'integration.symmy',
  deliveryId: '10000000-0000-4000-8000-000000000010',
  domainEventId: '10000000-0000-4000-8000-000000000011',
  legalEntityScope: 'forbidden',
  messageId: '10000000-0000-4000-8000-000000000012',
  originatorInvocationId: '10000000-0000-4000-8000-000000000013',
  producerModuleKey: 'integration.symmy',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'integration.symmy.job-admitted.v1',
  workerKey: 'integration.symmy.execute-symmy-job',
});
const canonicalPartyRef = Schema.decodeUnknownSync(PartyRefSchema)({
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000015',
  resourceType: 'party.registry.party',
  tenantId,
});
const created = Schema.decodeUnknownSync(CreatePartyResultSchema)({
  decisionRef: {
    moduleId: 'party.registry',
    resourceId: '10000000-0000-4000-8000-000000000014',
    resourceType: 'party.registry.party-match-decision',
    tenantId,
  },
  outcome: 'CREATED',
  partyRef: {
    moduleId: 'party.registry',
    resourceId: '10000000-0000-4000-8000-000000000015',
    resourceType: 'party.registry.party',
    tenantId,
  },
});
const originalReceipt = Schema.decodeUnknownSync(PartySourceEffectReceiptResponseSchema)({
  actionInvocationId: invocationId,
  operation: 'CREATE',
  outcome: 'COMMITTED',
  result: created,
});
const input = (): SymmyEffectAdapterInput => ({
  canExecuteNewEffects: true,
  context,
  dependencies: [],
  effect,
  readOriginalActionInvocation: () =>
    Effect.sync(() => {
      calls.factReads += 1;
      return Option.fromNullishOr(calls.fact);
    }),
  recordInvocationId: () => Effect.void,
  recordOwnerReceipt: () => Effect.void,
  recordOwnerRequest: ({ authContextRef, requestHash }) =>
    Effect.sync(() => {
      calls.hashes.push({ authContextRef, hash: requestHash });
      calls.order.push('pin-request');
    }),
  recordResolvedEffect: () => Effect.void,
});
const createAdapter = Effect.gen(function* createAdapter() {
  const adapters = yield* makeSymmyPartyCommerceAdapters;
  const adapter = adapters.find(
    (candidate) => candidate.operation.entrypointKey === effect.ref.operation.entrypointKey,
  );
  if (adapter === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  return adapter;
});
const withOriginalRequest = Effect.fn('PartyCommerceAdapterFixture.originalRequest')(function* withOriginalRequest(
  original: SymmyEffectAdapterInput,
) {
  const intent = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceIntentSchema)(original.effect.intent);
  const scope =
    original.legalEntityId === undefined
      ? { principalId: executorPrincipalId, tenantId }
      : { legalEntityId: original.legalEntityId, principalId: executorPrincipalId, tenantId };
  const originalRequestHash = yield* prepareSymmyPartyCommerceRequestHash(intent, scope);
  return {
    ...original,
    originalAuthContextRef: fixtureAuthContextRef,
    originalExecutorPrincipalId: executorPrincipalId,
    originalRequestHash,
  };
});
const reset = () => {
  calls.counterpartyAssignment.mockReset();
  calls.organizationIco.mockReset();
  calls.organizationIcoRead.mockReset();
  calls.groupDefinition.mockReset();
  calls.membership.mockReset();
  calls.membershipReceipt.mockReset();
  calls.onboard.mockReset();
  calls.updateGroup.mockReset();
  calls.profileReceipt.mockReset();
  calls.address.mockReset();
  calls.endContact.mockReset();
  calls.addressReceipt.mockReset();
  calls.create.mockReset();
  calls.retail.mockReset();
  calls.assignment.mockReset();
  calls.assignmentReceipt.mockReset();
  calls.privacy.mockReset();
  calls.receipt.mockReset();
  calls.fact = null;
  calls.exposeCommittedAckFact = true;
  calls.factReads = 0;
  calls.hashes.length = 0;
  calls.gateway.length = 0;
  calls.order.length = 0;
};

const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '10000000-0000-4000-8000-000000000021',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
};
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '10000000-0000-4000-8000-000000000022',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};
const assignmentEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  intent: {
    _tag: 'AssignCustomerPriceGroup',
    authorizationSubject: { kind: 'RETAIL' },
    payload: {
      effectiveFrom: '2026-11-07T00:00:00.000Z',
      expectedProfileRevision: 1,
      priceGroupRef,
      profile,
      reason: 'Explicit internal assignment',
      source: {
        effectId,
        issuer: 'internal-symmy',
        mappingRevision: 'mapping-1',
        namespace: 'customers',
        occurrenceId: 'occurrence-1',
        order: 1,
        recordId: 'customer-1',
        recordType: 'CUSTOMER',
        revision: 'source-1',
        route: { id: routeId, revision: 'route-1' },
      },
    },
  },
  ref: {
    ...effect.ref,
    operation: {
      entrypointKey: 'commerce.customer-context.assign-customer-price-group',
      moduleId: 'commerce.customer-context',
      schemaVersion: '1',
    },
    originalTarget: profile,
  },
});
const assignmentResult = Schema.decodeUnknownSync(AssignCustomerPriceGroupResultSchema)({
  assignment: {
    assignmentRef: {
      moduleId: 'commerce.customer-context',
      resourceId: '10000000-0000-4000-8000-000000000023',
      resourceType: 'commerce.customer-context.customer-price-group-assignment',
      tenantId,
    },
    effectiveFrom: '2026-11-07T00:00:00.000Z',
    effectiveTo: null,
    priceGroupRef,
    profile,
    reason: 'Explicit internal assignment',
    recordedAt: '2026-11-07T00:00:00.000Z',
    revision: 1,
    state: 'ACTIVE',
  },
  changed: true,
  replacedAssignmentRef: null,
});
const privacyAllowed = Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
  authorityIncarnation: 'internal-authority-1',
  authorityRevision: 'internal-revision-1',
  evaluatedAt: '2026-11-07T00:00:00.000Z',
  evidence: {
    authoritativeReferences: [],
    currentnessConditions: [],
    evaluatedScope: {
      controllerRef: 'internal:controller',
      dataCategoryRefs: ['internal:customer-assignment'],
      operation: 'PRICE_GROUP_ASSIGN',
      processingScopeRef: { scopeId: 'internal:assignment-scope', scopeType: 'privacy.processing-scope' },
      purposeRef: 'internal:explicit-purpose',
      purposeVersionId: 'internal:purpose-v1',
      recipientRefs: [],
      subjectRef: {
        moduleId: 'privacy.core',
        resourceId: 'internal:subject-1',
        resourceType: 'privacy.core.privacy-subject',
        tenantId,
      },
    },
    outcome: 'ALLOWED',
    policyRevisions: [],
    reasonCodes: ['INTERNAL_SCRIPTED_ALLOW'],
    trustedDecisionTime: '2026-11-07T00:00:00.000Z',
  },
  outcome: 'ALLOWED',
});
const privacyDenied = Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
  evaluatedAt: '2026-11-07T00:00:00.000Z',
  outcome: 'DENIED',
  reason: 'PROCESSING_NOT_ALLOWED',
});
const assignmentAdapter = Effect.gen(function* assignmentAdapter() {
  const adapters = yield* makeSymmyPartyCommerceAdapters;
  const adapter = adapters.find(
    (candidate) => candidate.operation.entrypointKey === assignmentEffect.ref.operation.entrypointKey,
  );
  if (adapter === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  return adapter;
});

// The public Privacy owner response is scripted; production never manufactures this authority.
describe('explicit Commerce assignment source Privacy', () => {
  it.effect('checks the exact profile and source again after an earlier positive result', () =>
    Effect.gen(function* recheck() {
      reset();
      calls.privacy
        .mockReturnValueOnce(Effect.succeed(privacyAllowed))
        .mockReturnValueOnce(Effect.succeed(privacyDenied));
      calls.assignment.mockReturnValue(Effect.succeed(assignmentResult));
      const adapter = yield* assignmentAdapter;
      const original = { ...input(), effect: assignmentEffect, legalEntityId: '10000000-0000-4000-8000-000000000020' };
      const first = yield* adapter.execute(original);
      expect(first.status).toBe('accepted_change');
      const denied = yield* adapter.execute(original);
      expect(denied.status).toBe('denied');
      expect(calls.assignment).toHaveBeenCalledTimes(1);
      expect(calls.privacy).toHaveBeenCalledTimes(2);
      expect(calls.privacy.mock.calls[0]?.[0]).toMatchObject({
        consumerModuleId: 'commerce.customer-context',
        operation: 'PRICE_GROUP_ASSIGN',
        source: { occurrenceId: 'occurrence-1', recordId: 'customer-1' },
        target: { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: profile.resourceId },
      });
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('leaves recovery indeterminate when receiving owner current Privacy rejects its immutable source', () =>
    Effect.gen(function* deniedRecovery() {
      reset();
      calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      calls.assignmentReceipt.mockReturnValue(
        Effect.fail(
          CustomerPriceGroupAssignmentReceiptForbiddenProblemSchema.make({
            detail: 'Current owner Privacy denies the original source',
            status: 403,
            title: 'Forbidden',
            type: 'about:blank',
          }),
        ),
      );
      const adapter = yield* assignmentAdapter;
      const result = yield* adapter
        .recover(
          yield* withOriginalRequest({
            ...input(),
            effect: assignmentEffect,
            legalEntityId: '10000000-0000-4000-8000-000000000020',
            originalInvocationId: invocationId,
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(calls.assignmentReceipt).toHaveBeenCalledTimes(1);
      expect(calls.privacy).not.toHaveBeenCalled();
      expect(calls.assignment).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
});

const contactPointRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000030',
  resourceType: 'party.registry.party-contact-point',
  tenantId,
};
const endContactEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  intent: {
    _tag: 'EndPartyContactPoint',
    payload: {
      contactPointRef,
      effectiveEnd: '2026-11-07T00:00:00.000Z',
      provenance: { authoritative: false, method: 'PROVIDER_OBSERVATION', source: 'EXTERNAL_EVIDENCE' },
      reason: 'Explicit end from the internal source',
      sourceReference: {
        occurrenceId: 'occurrence-1',
        recordId: 'customer-1',
        source: { issuer: 'internal-symmy', namespace: 'customers', recordType: 'CUSTOMER', routeRef: routeId },
      },
      target: { type: 'WHOLE_CONTACT_POINT' },
    },
  },
  ref: {
    ...effect.ref,
    operation: { entrypointKey: 'party.registry.end-contact-point', moduleId: 'party.registry', schemaVersion: '1' },
    originalTarget: contactPointRef,
  },
});

describe('governed internal Party adapter', () => {
  it.effect('preserves the original Contact end no-change receipt instead of guessing from current state', () =>
    Effect.gen(function* contactNoChange() {
      reset();
      calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      calls.receipt.mockReturnValue(
        Effect.succeed(
          Schema.decodeUnknownSync(PartySourceEffectReceiptResponseSchema)({
            actionInvocationId: invocationId,
            operation: 'END_CONTACT_POINT',
            outcome: 'COMMITTED',
            result: { changed: false, contactPointRef, partyRef: canonicalPartyRef, revision: 3 },
          }),
        ),
      );
      const adapters = yield* makeSymmyPartyCommerceAdapters;
      const adapter = adapters.find(
        (candidate) => candidate.operation.entrypointKey === endContactEffect.ref.operation.entrypointKey,
      );
      if (adapter === undefined) {
        return yield* symmyJobWorkerUnavailable();
      }
      const recovered = yield* adapter.recover(
        yield* withOriginalRequest({
          ...input(),
          effect: endContactEffect,
          originalInvocationId: invocationId,
        }),
      );
      expect(recovered).toMatchObject({ outcome: { status: 'accepted_no_change' }, status: 'settled' });
      expect(calls.receipt.mock.calls[0]?.[0]).toMatchObject({
        operation: 'END_CONTACT_POINT',
        payload: { contactPointRef },
      });
      return yield* Effect.void;
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('does not invoke the owner if the complete request pin cannot be saved', () =>
    Effect.gen(function* cannotPin() {
      reset();
      calls.create.mockReturnValue(Effect.succeed(created));
      const adapter = yield* createAdapter;
      const result = yield* Effect.result(
        adapter.execute({ ...input(), recordOwnerRequest: () => Effect.fail(symmyJobWorkerUnavailable()) }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(calls.create).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('reuses the pinned executor and exact original command key when no invocation was acknowledged', () =>
    Effect.gen(function* originalCommand() {
      reset();
      calls.receipt.mockReturnValue(Effect.succeed({ outcome: 'INDETERMINATE' }));
      calls.create.mockReturnValue(Effect.succeed(created));
      const adapter = yield* createAdapter;
      const original = yield* withOriginalRequest(input());
      expect(yield* adapter.recover(original)).toEqual({ status: 'retry_original_key' });
      expect(calls.gateway).toHaveLength(0);
      const result = yield* adapter.execute(original);
      expect(result).toMatchObject({ status: 'accepted_change' });
      expect(calls.gateway).toHaveLength(1);
      expect(calls.gateway[0]?.subject).toMatchObject({
        operationRequirementKey: 'integration.symmy.requirement.worker.party.registry.create-party',
      });
      expect(calls.gateway[0]?.subject).toMatchObject({ expectedPrincipalId: '10000000-0000-4000-8000-000000000008' });
      expect(calls.create.mock.calls[0]?.[2].idempotencyKey).toBe(effectId);
      expect(calls.create.mock.calls[0]?.[1]).toBe('Bearer internal-attempt-1');
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('keeps revoked new-effect authority from replaying an uncertain command', () =>
    Effect.gen(function* revoked() {
      reset();
      calls.receipt.mockReturnValue(Effect.succeed({ outcome: 'INDETERMINATE' }));
      const adapter = yield* createAdapter;
      const result = yield* adapter.recover({
        ...input(),
        canExecuteNewEffects: false,
        originalExecutorPrincipalId: '10000000-0000-4000-8000-000000000008',
      });
      expect(result).toEqual({ status: 'unavailable' });
      expect(calls.create).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('rejects a receipt identifying a different previously recorded invocation', () =>
    Effect.gen(function* wrongInvocation() {
      reset();
      calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      calls.receipt.mockReturnValue(Effect.succeed(originalReceipt));
      const adapter = yield* createAdapter;
      const result = yield* adapter.recover(
        yield* withOriginalRequest({
          ...input(),
          originalInvocationId: '10000000-0000-4000-8000-000000000099',
        }),
      );
      expect(result).toEqual({ status: 'unavailable' });
      expect(calls.create).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('uses the committed synchronous admission without manufacturing a worker delivery', () =>
    Effect.gen(function* synchronousAdmission() {
      reset();
      calls.create.mockReturnValue(Effect.succeed(created));
      const adapter = yield* createAdapter;
      const initial = input();
      yield* adapter.execute({
        admission: {
          actionInvocationId: invocationId,
          compositionRevision: 'c'.repeat(64),
          sourceActionKey: 'integration.symmy.admit-symmy-sync',
          tenantId,
        },
        canExecuteNewEffects: true,
        dependencies: [],
        effect,
        readOriginalActionInvocation: initial.readOriginalActionInvocation,
        recordInvocationId: initial.recordInvocationId,
        recordOwnerReceipt: initial.recordOwnerReceipt,
        recordOwnerRequest: initial.recordOwnerRequest,
        recordResolvedEffect: initial.recordResolvedEffect,
      });
      expect(
        calls.gateway.some((request) =>
          Match.value(request.subject).pipe(
            Match.tag('RegisteredAdmission', () => true),
            Match.orElse(() => false),
          ),
        ),
      ).toBe(true);
      expect(calls.gateway[0]?.subject).toMatchObject({
        actionInvocationId: invocationId,
        sourceActionKey: 'integration.symmy.admit-symmy-sync',
      });
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('pins the actual executor before the native write and uses a fresh operation-bound credential', () =>
    Effect.gen(function* execute() {
      reset();
      calls.create.mockImplementation(() =>
        Effect.sync(() => {
          calls.order.push('owner-write');
          return created;
        }),
      );
      const adapter = yield* createAdapter;
      const result = yield* adapter.execute(input());
      expect(result.status).toBe('accepted_change');
      expect(calls.order).toEqual(['pin-request', 'owner-write']);
      expect(calls.hashes[0]?.hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(calls.hashes[0]?.authContextRef).toBe(fixtureAuthContextRef);
      expect(calls.gateway[0]).toMatchObject({
        audience: 'party-registry',
        subject: { _tag: 'RegisteredWorkload', context, declarationKey: 'party.registry.party.create' },
      });
      expect(calls.create.mock.calls[0]?.[1]).toBe('Bearer internal-attempt-1');
      expect(calls.create.mock.calls[0]?.[2]).toMatchObject({ idempotencyKey: effectId });
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('recovers the original owner receipt without invoking the write again', () =>
    Effect.gen(function* recover() {
      reset();
      calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      calls.receipt.mockReturnValue(Effect.succeed(originalReceipt));
      const adapter = yield* createAdapter;
      const result = yield* adapter.recover(yield* withOriginalRequest(input()));
      expect(result).toMatchObject({ outcome: { status: 'accepted_change' }, status: 'settled' });
      expect(calls.create).not.toHaveBeenCalled();
      expect(calls.receipt.mock.calls[0]?.[0]).toMatchObject({ operation: 'CREATE' });
      expect(calls.gateway[0]?.subject).toMatchObject({
        declarationKey: 'party.registry.party-source-effect-receipt.read',
        operationRequirementKey: 'integration.symmy.requirement.worker.party.registry.api.party-source-effect-receipt',
      });
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('records a native indeterminate invocation before returning uncertainty', () =>
    Effect.gen(function* indeterminate() {
      reset();
      calls.create.mockReturnValue(
        Effect.fail(
          PartyCommandCommitIndeterminateProblemSchema.make({
            detail: 'Internal lost acknowledgement fixture',
            invocationId: Schema.decodeUnknownSync(PartyCommandCommitIndeterminateProblemSchema.fields.invocationId)(
              invocationId,
            ),
            resolution: 'RESOLVE_COMMIT',
            retryCommand: false,
            status: 503,
            title: 'Indeterminate',
            type: 'https://ontos.dev/problems/internal-lost-ack',
          }),
        ),
      );
      const invocations: string[] = [];
      const adapter = yield* createAdapter;
      const result = yield* Effect.result(
        adapter.execute({
          ...input(),
          recordInvocationId: (id) =>
            Effect.sync(() => {
              invocations.push(id);
            }),
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(invocations).toEqual([invocationId]);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('allows a new exact attempt after interruption before any owner request was pinned', () =>
    Effect.gen(function* absent() {
      reset();
      calls.receipt.mockReturnValue(Effect.succeed({ outcome: 'INDETERMINATE' }));
      const adapter = yield* createAdapter;
      const result = yield* adapter.recover(input());
      expect(result).toEqual({ status: 'not_committed' });
      expect(calls.create).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('keeps the pinned executor when recovering an old interruption between owner pins', () =>
    Effect.gen(function* partialPin() {
      reset();
      const adapter = yield* createAdapter;
      const legacy = { ...input(), originalExecutorPrincipalId: executorPrincipalId };
      expect(yield* adapter.recover(legacy)).toEqual({ status: 'retry_original_key' });
      expect(yield* adapter.recover({ ...legacy, originalInvocationId: invocationId })).toEqual({
        status: 'unavailable',
      });
      expect(calls.factReads).toBe(0);
      expect(calls.gateway).toHaveLength(0);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
});
describe('original native invocation recovery authority', () => {
  it.effect('does not retry a known committed action when its authorized receipt Read is denied', () =>
    Effect.gen(function* committedDenied() {
      reset();
      calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      calls.receipt.mockReturnValue(
        Effect.fail(
          PartySourceEffectReceiptForbiddenProblemSchema.make({
            detail: 'Internal current authority revoked',
            status: 403,
            title: 'Forbidden',
            type: 'about:blank',
          }),
        ),
      );
      const adapter = yield* createAdapter;
      const recovered = yield* adapter.recover(yield* withOriginalRequest(input())).pipe(Effect.result);
      expect(Result.isFailure(recovered)).toBe(true);
      expect(calls.receipt).toHaveBeenCalledTimes(1);
      expect(calls.create).not.toHaveBeenCalled();
      expect(calls.gateway[0]?.subject).toMatchObject({
        originalActionKey: 'party.registry.create-party',
        originalIdempotencyKey: effectId,
        originalPrincipalId: executorPrincipalId,
      });
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect.each(['rejected', 'failed'])(
    'never invokes a write or receipt Read for a kernel invocation in %s',
    (status) =>
      Effect.gen(function* noncommittedFact() {
        reset();
        calls.fact = { actionInvocationId: invocationId, status };
        const adapter = yield* createAdapter;
        const recovered = yield* adapter.recover(yield* withOriginalRequest(input()));
        expect(recovered).toEqual({ status: 'unavailable' });
        expect(calls.create).not.toHaveBeenCalled();
        expect(calls.receipt).not.toHaveBeenCalled();
        expect(calls.gateway).toHaveLength(0);
      }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect.each(['received', 'running'])(
    'lets the worker retry a kernel invocation in %s using only current exact write authority',
    (status) =>
      Effect.gen(function* openFact() {
        reset();
        calls.fact = { actionInvocationId: invocationId, status };
        const adapter = yield* createAdapter;
        const original = yield* withOriginalRequest({ ...input(), originalInvocationId: invocationId });
        expect(yield* adapter.recover(original)).toEqual({ status: 'retry_original_key' });
        expect(yield* adapter.recover({ ...original, canExecuteNewEffects: false })).toEqual({ status: 'unavailable' });
        expect(calls.create).not.toHaveBeenCalled();
        expect(calls.receipt).not.toHaveBeenCalled();
        expect(calls.gateway).toHaveLength(0);
        calls.create.mockReturnValue(
          Effect.sync(() => {
            calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
            return created;
          }),
        );
        calls.receipt.mockReturnValue(Effect.succeed(originalReceipt));
        expect(yield* adapter.execute(original)).toMatchObject({ status: 'accepted_change' });
        expect(yield* adapter.recover({ ...original, canExecuteNewEffects: false })).toMatchObject({
          outcome: { status: 'accepted_change' },
          status: 'settled',
        });
        expect(calls.create).toHaveBeenCalledTimes(1);
        expect(calls.create.mock.calls[0]?.[2].idempotencyKey).toBe(effectId);
      }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('fails before the owner call when an original command no longer matches its persisted request hash', () =>
    Effect.gen(function* hashMismatch() {
      reset();
      calls.create.mockReturnValue(Effect.succeed(created));
      const adapter = yield* createAdapter;
      const result = yield* adapter
        .execute({
          ...input(),
          originalAuthContextRef: fixtureAuthContextRef,
          originalExecutorPrincipalId: executorPrincipalId,
          originalRequestHash: 'f'.repeat(64),
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(calls.create).not.toHaveBeenCalled();
      expect(calls.hashes).toHaveLength(0);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
});
const sellingLegalEntityId = '10000000-0000-4000-8000-000000000090';
const retailDependencyEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  dependsOn: [{ effectKey: 'create-party', itemKey: 'customer-1' }],
  effectKey: 'ensure-profile',
  intent: {
    _tag: 'EnsureRetailProfileFromParty',
    fromPartyEffect: { effectKey: 'create-party', itemKey: 'customer-1' },
    payload: {
      effectiveAt: '2026-11-07T00:00:00.000Z',
      partySourceReference: {
        occurrenceId: 'occurrence-1',
        recordId: 'customer-1',
        source: { issuer: 'internal-symmy', namespace: 'customers', recordType: 'CUSTOMER', routeRef: routeId },
      },
      source: {
        effectId,
        issuer: 'internal-symmy',
        mappingRevision: 'mapping-1',
        namespace: 'customers',
        occurrenceId: 'occurrence-1',
        order: 1,
        recordId: 'customer-1',
        recordType: 'CUSTOMER',
        revision: 'source-1',
        route: { id: routeId, revision: 'route-1' },
      },
      subject: {
        kind: 'RETAIL',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: sellingLegalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      },
      trigger: 'AUTHORIZED_ONBOARDING',
    },
  },
  ref: {
    ...effect.ref,
    operation: {
      entrypointKey: 'commerce.customer-context.ensure-retail-customer-profile',
      moduleId: 'commerce.customer-context',
      schemaVersion: '1',
    },
  },
});
const retailParent = (): SymmyEffectAdapterInput['dependencies'][number] => ({
  effect,
  itemKey: 'customer-1',
  outcome: Option.some({ effectId: effect.ref.effectId, owner: 'party.registry', status: 'accepted_change' }),
  ownerReceipt: Option.some({ _tag: 'PartyCreated', partyRef: canonicalPartyRef }),
  state: 'settled',
  version: 1,
});
const retailDependencyAdapter = Effect.gen(function* retailDependencyAdapter() {
  const adapters = yield* makeSymmyPartyCommerceAdapters;
  const adapter = adapters.find(
    (value) => value.operation.entrypointKey === retailDependencyEffect.ref.operation.entrypointKey,
  );
  if (adapter === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  return adapter;
});
describe('immutable canonical dependency resolution', () => {
  it.effect('persists the actual resolved Party before pinning the executor or writing a native profile', () =>
    Effect.gen(function* resolvedBeforeWrite() {
      reset();
      calls.retail.mockImplementation(() =>
        Effect.sync(() => {
          calls.order.push('owner-write');
          return Schema.decodeUnknownSync(EnsureRetailCustomerProfileResultSchema)({
            outcome: 'PROFILE_CREATED',
            profileRef: profile,
            revision: 1,
            state: 'ACTIVE',
          });
        }),
      );
      const adapter = yield* retailDependencyAdapter;
      const recorded: unknown[] = [];
      const result = yield* adapter.execute({
        ...input(),
        dependencies: [retailParent()],
        effect: retailDependencyEffect,
        legalEntityId: sellingLegalEntityId,
        recordResolvedEffect: (value) =>
          Effect.sync(() => {
            recorded.push(value);
            calls.order.push('resolve');
          }),
      });
      expect(result.status).toBe('accepted_change');
      expect(calls.order).toEqual(['resolve', 'pin-request', 'owner-write']);
      expect(recorded).toMatchObject([
        {
          intent: {
            _tag: 'EnsureRetailProfile',
            payload: { source: { effectId, occurrenceId: 'occurrence-1' }, subject: { partyRef: canonicalPartyRef } },
          },
        },
      ]);
      expect(calls.retail.mock.calls[0]?.[0].subject.partyRef).toEqual(canonicalPartyRef);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('does not resolve an undeclared parent or retry resolution after authority is revoked', () =>
    Effect.gen(function* unresolvedDenied() {
      reset();
      const adapter = yield* retailDependencyAdapter;
      const undeclared = yield* adapter
        .execute({
          ...input(),
          dependencies: [retailParent()],
          effect: { ...retailDependencyEffect, dependsOn: [] },
          legalEntityId: sellingLegalEntityId,
        })
        .pipe(Effect.result);
      const revoked = yield* adapter.recover({
        ...input(),
        canExecuteNewEffects: false,
        dependencies: [retailParent()],
        effect: retailDependencyEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(Result.isFailure(undeclared)).toBe(true);
      expect(revoked).toEqual({ status: 'unavailable' });
      expect(calls.retail).not.toHaveBeenCalled();
      expect(calls.gateway).toHaveLength(0);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
});
const addressSource = {
  effectId,
  identity: {
    issuer: 'internal-symmy',
    namespace: 'customers',
    occurrenceId: 'occurrence-1',
    recordId: 'customer-1',
    recordType: 'CUSTOMER',
    routeRef: routeId,
  },
  mappingRevision: 'mapping-1',
  order: 1,
  purposes: ['DELIVERY'],
  revision: 'source-1',
  routeRevision: 'route-1',
};
const savedAddressRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '10000000-0000-4000-8000-000000000095',
  resourceType: 'commerce.customer-context.saved-address',
  tenantId,
};
const savedAddressEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  intent: {
    _tag: 'AddSavedAddress',
    payload: {
      origin: {
        kind: 'COMMERCE_ONLY',
        postalAddress: { addressLine1: 'Fixture Street 1', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
      },
      profile: { kind: 'RETAIL', profileRef: profile },
      purposes: ['DELIVERY'],
      reason: 'Explicit qualified delivery address',
      source: addressSource,
    },
  },
  ref: {
    ...effect.ref,
    operation: {
      entrypointKey: 'commerce.customer-context.add-saved-address',
      moduleId: 'commerce.customer-context',
      schemaVersion: '1',
    },
  },
});
const savedAddressAdapter = Effect.gen(function* savedAddressAdapter() {
  const adapters = yield* makeSymmyPartyCommerceAdapters;
  const adapter = adapters.find(
    (value) => value.operation.entrypointKey === savedAddressEffect.ref.operation.entrypointKey,
  );
  if (adapter === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  return adapter;
});
describe('finite Saved Address owner dispatch', () => {
  it.effect('writes the explicit purpose and source locator without inventing a native address ID', () =>
    Effect.gen(function* addAddress() {
      reset();
      calls.address.mockReturnValue(
        Effect.succeed(
          Schema.decodeUnknownSync(AddSavedAddressResultSchema)({
            address: {
              lifecycle: 'ACTIVE',
              origin: {
                kind: 'COMMERCE_ONLY',
                postalAddress: {
                  addressLine1: 'Fixture Street 1',
                  city: 'Prague',
                  countryCode: 'CZ',
                  postalCode: '11000',
                },
              },
              profile: { kind: 'RETAIL', profileRef: profile },
              purposes: ['DELIVERY'],
              revision: 1,
              savedAddressRef,
            },
            outcome: 'ADDED',
          }),
        ),
      );
      const adapter = yield* savedAddressAdapter;
      const result = yield* adapter.execute({
        ...input(),
        effect: savedAddressEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result.status).toBe('accepted_change');
      expect(calls.address.mock.calls[0]?.[0]).toMatchObject({
        purposes: ['DELIVERY'],
        source: { effectId, identity: { occurrenceId: 'occurrence-1', recordId: 'customer-1' } },
      });
      expect(calls.address.mock.calls[0]?.[0].source?.nativeAddressId).toBeUndefined();
      expect(calls.order).toEqual(['pin-request']);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('recovers an original reused result without creating another address', () =>
    Effect.gen(function* recoveredAddress() {
      reset();
      calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      const original = yield* withOriginalRequest({
        ...input(),
        effect: savedAddressEffect,
        legalEntityId: sellingLegalEntityId,
      });
      calls.addressReceipt.mockReturnValue(
        Effect.succeed(
          Schema.decodeUnknownSync(SavedAddressSourceReceiptResponseSchema)({
            _tag: 'RECEIPT',
            receipt: {
              actionInvocationId: invocationId,
              clearedDefaults: [],
              operation: 'ADD',
              outcome: 'REUSED',
              profile: { kind: 'RETAIL', profileRef: profile },
              requestHash: original.originalRequestHash,
              revision: 1,
              savedAddressRef,
            },
          }),
        ),
      );
      const adapter = yield* savedAddressAdapter;
      const result = yield* adapter.recover(original);
      expect(result).toMatchObject({ outcome: { status: 'accepted_no_change' }, status: 'settled' });
      expect(calls.address).not.toHaveBeenCalled();
      expect(calls.addressReceipt.mock.calls[0]?.[0]).toMatchObject({
        actionInvocationId: invocationId,
        actionKey: 'commerce.customer-context.add-saved-address',
        requestHash: original.originalRequestHash,
        source: { identity: { recordId: 'customer-1' } },
      });
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
});

it.effect('keeps a successful Contact write indeterminate when its following receipt Read is forbidden', () =>
  Effect.gen(function* acknowledgedContactReadDenied() {
    reset();
    calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
    calls.endContact.mockReturnValue(
      Effect.succeed(
        Schema.decodeUnknownSync(EndContactPointResultSchema)({
          contactPointRef,
          current: false,
          end: {
            effectiveEnd: '2026-11-07T00:00:00.000Z',
            endedByActionInvocationId: invocationId,
            endedByPrincipalId: executorPrincipalId,
            provenance: { evidenceReferences: [], method: 'PROVIDER_OBSERVATION', source: 'EXTERNAL_EVIDENCE' },
            reason: 'Explicit end',
            recordedAt: '2026-11-07T00:00:00.000Z',
          },
          partyRef: canonicalPartyRef,
          privacyClassification: 'PERSONAL',
          provenance: { authoritative: false, method: 'PROVIDER_OBSERVATION', source: 'EXTERNAL_EVIDENCE' },
          recordedAt: '2026-11-07T00:00:00.000Z',
          revision: 2,
          state: 'ENDED',
          storedPartyRef: canonicalPartyRef,
          validFrom: '2026-11-06T00:00:00.000Z',
          validTo: '2026-11-07T00:00:00.000Z',
          value: {
            displayValue: 'fixture@example.test',
            lookupValue: 'fixture@example.test',
            preferred: false,
            type: 'EMAIL',
          },
        }),
      ),
    );
    calls.receipt.mockReturnValue(
      Effect.fail(
        PartySourceEffectReceiptForbiddenProblemSchema.make({
          detail: 'Current processing denied after native commit',
          status: 403,
          title: 'Forbidden',
          type: 'about:blank',
        }),
      ),
    );
    const adapters = yield* makeSymmyPartyCommerceAdapters;
    const adapter = adapters.find(
      (value) => value.operation.entrypointKey === endContactEffect.ref.operation.entrypointKey,
    );
    if (adapter === undefined) {
      return yield* symmyJobWorkerUnavailable();
    }
    const result = yield* adapter.execute({ ...input(), effect: endContactEffect }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls.endContact).toHaveBeenCalledTimes(1);
    expect(calls.receipt).toHaveBeenCalledTimes(1);
    return yield* Effect.void;
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect(
  'does not acquire a credential or execute an already normalized new effect after admission authority is revoked',
  () =>
    Effect.gen(function* nativeRevoked() {
      reset();
      const adapter = yield* createAdapter;
      const result = yield* adapter.execute({ ...input(), canExecuteNewEffects: false }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(calls.gateway).toHaveLength(0);
      expect(calls.create).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
);

const resolvedRetailEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...retailDependencyEffect,
  dependsOn: [],
  intent: Match.value(Schema.decodeUnknownSync(SymmyPartyCommerceIntentSchema)(retailDependencyEffect.intent)).pipe(
    Match.tag('EnsureRetailProfileFromParty', (intent) => ({
      _tag: 'EnsureRetailProfile',
      payload: { ...intent.payload, subject: { ...intent.payload.subject, partyRef: canonicalPartyRef } },
    })),
    Match.orElse(() => {}),
  ),
});
it.effect('uses only independently guarded minimal Retail creation receipt after a forbidden full profile Read', () =>
  Effect.gen(function* minimalCreationRecovery() {
    reset();
    calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
    const nativeIntent = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceIntentSchema)(resolvedRetailEffect.intent);
    const originalIntent = Match.value(nativeIntent).pipe(
      Match.tag('EnsureRetailProfile', (intent) => intent.payload),
      Match.orElse(() => {}),
    );
    calls.profileReceipt
      .mockReturnValueOnce(
        Effect.fail(
          CustomerProfileSourceForbiddenProblemSchema.make({
            detail: 'Exact full profile read currently forbidden',
            status: 403,
            title: 'Forbidden',
            type: 'about:blank',
          }),
        ),
      )
      .mockReturnValueOnce(
        Effect.succeed(
          Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)({
            _tag: 'MINIMAL_RECEIPT',
            currentAdmission: {
              outcome: 'SOURCE_PERSON_CURRENT',
              partyRef: canonicalPartyRef,
              partyRevision: 1,
              sourceActionInvocationId: '10000000-0000-4000-8000-000000000097',
              sourceDecisionRef: created.decisionRef,
              sourceReference: {
                occurrenceId: 'occurrence-1',
                recordId: 'customer-1',
                source: { issuer: 'internal-symmy', namespace: 'customers', recordType: 'CUSTOMER', routeRef: routeId },
              },
            },
            receipt: {
              actionInvocationId: invocationId,
              actorPrincipalId: executorPrincipalId,
              intent: originalIntent,
              profileKind: 'RETAIL',
              recordedAt: '2026-11-07T00:00:00.000Z',
              result: {
                outcome: 'PROFILE_CREATED',
                profileRef: profile,
                revision: 1,
                sourceEffect: { effectId, replayed: false },
                state: 'ACTIVE',
              },
            },
          }),
        ),
      );
    const adapter = yield* retailDependencyAdapter;
    const result = yield* adapter.recover(
      yield* withOriginalRequest({ ...input(), effect: resolvedRetailEffect, legalEntityId: sellingLegalEntityId }),
    );
    expect(result).toMatchObject({ outcome: { status: 'accepted_change' }, status: 'settled' });
    expect(calls.retail).not.toHaveBeenCalled();
    expect(calls.profileReceipt.mock.calls.map((call) => call[0].mode)).toEqual(['RECEIPT', 'MINIMAL_RECEIPT']);
  }).pipe(Effect.provide(nodeCryptoLayer)),
);
it.effect('does not treat an unavailable full profile receipt as absence or issue another write', () =>
  Effect.gen(function* unavailableProfileRecovery() {
    reset();
    calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
    calls.profileReceipt.mockReturnValue(
      Effect.fail(
        CustomerProfileSourceUnavailableProblemSchema.make({
          detail: 'Owner context unavailable',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'about:blank',
        }),
      ),
    );
    const adapter = yield* retailDependencyAdapter;
    const result = yield* adapter
      .recover(
        yield* withOriginalRequest({ ...input(), effect: resolvedRetailEffect, legalEntityId: sellingLegalEntityId }),
      )
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls.profileReceipt).toHaveBeenCalledTimes(1);
    expect(calls.retail).not.toHaveBeenCalled();
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect('settles the native group meaning-change refusal as conflict without retry or receipt lookup', () =>
  Effect.gen(function* definiteMeaningConflict() {
    reset();
    calls.updateGroup.mockReturnValue(
      Effect.fail(
        UpdateCustomerGroupActionIneligibleProblemSchema.make({
          code: 'customer_group_definition_change_requires_new_group',
          detail: 'A changed group meaning requires a new group',
          status: 422,
          title: 'Ineligible',
          type: 'about:blank',
        }),
      ),
    );
    const groupRef = {
      moduleId: 'commerce.customer-context',
      resourceId: '10000000-0000-4000-8000-000000000098',
      resourceType: 'commerce.customer-context.customer-group',
      tenantId,
    };
    const selected = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
      ...effect,
      intent: {
        _tag: 'CustomerGroupUpdate',
        payload: {
          description: 'Explicit fixture group',
          expectedRevision: 1,
          groupRef,
          membershipCriteria: 'Changed source membership rule',
          name: 'Fixture group',
          purpose: 'Internal fixture classification',
          reason: 'Source changed the meaning',
          source: {
            definitionEvidence: { kind: 'SOURCE_RECORD', reference: 'internal:group-source', revision: 'source-2' },
            effectId,
            issuer: 'internal-symmy',
            mappingRevision: 'mapping-1',
            namespace: 'customers',
            order: 1,
            recordId: 'customer-1',
            revision: 'source-2',
            route: { id: routeId, revision: 'route-1' },
            sourceCode: 'FIXTURE_GROUP',
          },
        },
      },
      ref: {
        ...effect.ref,
        operation: {
          entrypointKey: 'commerce.customer-context.update-customer-group',
          moduleId: 'commerce.customer-context',
          schemaVersion: '1',
        },
        originalTarget: groupRef,
      },
    });
    const adapters = yield* makeSymmyPartyCommerceAdapters;
    const adapter = adapters.find((value) => value.operation.entrypointKey === selected.ref.operation.entrypointKey);
    if (adapter === undefined) {
      return yield* symmyJobWorkerUnavailable();
    }
    const result = yield* adapter.execute({ ...input(), effect: selected, legalEntityId: sellingLegalEntityId });
    expect(result.status).toBe('conflict');
    expect(calls.updateGroup).toHaveBeenCalledTimes(1);
    expect(calls.factReads).toBe(0);
    return yield* Effect.void;
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect('never settles a successful native ACK without the actual succeeded Core identity', () =>
  Effect.gen(function* absentNativeFact() {
    reset();
    calls.exposeCommittedAckFact = false;
    calls.create.mockReturnValue(Effect.succeed(created));
    const adapter = yield* createAdapter;
    const result = yield* adapter.execute(input()).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.receipt).not.toHaveBeenCalled();
    expect(calls.factReads).toBe(1);
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect('pins the accepted company semantic witness before CAS, executor identity, hash and native Onboard', () =>
  Effect.gen(function* companyWitnessBeforeNativeWrite() {
    reset();
    const source = { issuer: 'internal-symmy', namespace: 'customers', recordType: 'CUSTOMER', routeRef: routeId };
    const party = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
      ...effect,
      intent: {
        _tag: 'PartyCreate',
        payload: {
          candidate: {
            businessName: 'Internal Company',
            evidenceRefs: [],
            officialIdentifiers: [],
            partyType: 'ORGANIZATION',
            provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: routeId },
            subjectEvidence: [
              {
                kind: 'CLIENT_SOURCE_ASSERTION',
                observedSubject: 'ORGANIZATION',
                occurrenceId: 'occurrence-1',
                recordId: 'customer-1',
                source,
                sourceObservedAt: '2026-11-07T00:00:00.000Z',
                statement: OrganizationBusinessSourceStatement,
                subjectKey: 'customer-1',
              },
            ],
            validFrom: '2026-11-07T00:00:00.000Z',
          },
        },
      },
    });
    const onboard = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
      ...effect,
      dependsOn: [{ effectKey: effect.effectKey, itemKey: 'customer-1' }],
      effectKey: 'onboard',
      intent: {
        _tag: 'OnboardCounterpartyCustomerFromParty',
        fromPartyEffect: { effectKey: effect.effectKey, itemKey: 'customer-1' },
        payload: {
          counterpartyProvenance: {
            evidenceReference: 'customer-1',
            method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
            reason: OrganizationBusinessCounterpartyContextReason,
            source: routeId,
          },
          customerEvidence: {
            evidenceReference: 'customer-1',
            method: 'APPROVED_PURCHASING_RELATIONSHIP',
            reason: OrganizationBusinessCustomerRoleReason,
            source: routeId,
          },
          sourceReference: { occurrenceId: 'occurrence-1', recordId: 'customer-1', source },
          validFrom: '2026-11-07T00:00:00.000Z',
        },
      },
      ref: {
        ...effect.ref,
        effectId: '10000000-0000-4000-8000-000000000099',
        operation: {
          entrypointKey: 'party.registry.counterparty-customer-onboard',
          moduleId: 'party.registry',
          schemaVersion: '1',
        },
      },
    });
    const plan = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({
      items: [{ effects: [party, onboard], itemId: effect.itemId, itemKey: 'customer-1' }],
    });
    const counterpartyRef = {
      moduleId: 'party.registry',
      resourceId: '10000000-0000-4000-8000-000000000097',
      resourceType: 'party.registry.counterparty',
      tenantId,
    };
    const nativeResult = Schema.decodeUnknownSync(CounterpartyCustomerOnboardResultSchema)({
      counterpartyCreated: true,
      counterpartyRef,
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: sellingLegalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
      partyRef: canonicalPartyRef,
      rolePeriodCreated: true,
      rolePeriodRef: {
        moduleId: 'party.registry',
        resourceId: '10000000-0000-4000-8000-000000000096',
        resourceType: 'party.registry.counterparty-role-period',
        tenantId,
      },
      roleType: 'CUSTOMER',
      validFrom: '2026-11-07T00:00:00.000Z',
      validTo: null,
    });
    calls.onboard.mockImplementation(() =>
      Effect.sync(() => {
        calls.order.push('owner-write');
        return nativeResult;
      }),
    );
    const adapters = yield* makeSymmyPartyCommerceAdapters;
    const adapter = adapters.find(
      (candidate) => candidate.operation.entrypointKey === onboard.ref.operation.entrypointKey,
    );
    if (adapter === undefined) {
      return yield* symmyJobWorkerUnavailable();
    }
    const recorded: unknown[] = [];
    const result = yield* adapter.execute({
      ...input(),
      acceptedPlan: plan,
      dependencies: [
        {
          ...retailParent(),
          effect: party,
          outcome: Option.some({ effectId: party.ref.effectId, owner: 'party.registry', status: 'accepted_no_change' }),
          ownerReceipt: Option.some({ _tag: 'PartyMatched', partyRef: canonicalPartyRef }),
        },
      ],
      effect: onboard,
      legalEntityId: sellingLegalEntityId,
      recordResolvedEffect: (value) =>
        Effect.sync(() => {
          recorded.push(value);
          calls.order.push('resolve');
        }),
    });
    expect(result.status).toBe('accepted_change');
    expect(calls.order).toEqual(['resolve', 'pin-request', 'owner-write']);
    expect(recorded).toMatchObject([
      {
        intent: {
          _tag: 'OnboardCounterpartyCustomer',
          payload: {
            partyRef: canonicalPartyRef,
            sourceOrganizationWitness: {
              effectId: onboard.ref.effectId,
              originalAdmissionInvocationId: context.originatorInvocationId,
              semanticProjectionVersion: OrganizationBusinessOnboardTemplateProjectionVersion,
            },
          },
        },
      },
    ]);
    expect(calls.onboard.mock.calls[0]?.[0].sourceOrganizationWitness?.semanticInputDigest).toMatch(/^[a-f0-9]{64}$/u);
    calls.receipt.mockReturnValue(
      Effect.succeed(
        yield* Schema.decodeUnknownEffect(PartySourceEffectReceiptResponseSchema)({
          actionInvocationId: invocationId,
          operation: 'ONBOARD_COUNTERPARTY_CUSTOMER',
          outcome: 'COMMITTED',
          result: Schema.encodeSync(CounterpartyCustomerOnboardResultSchema)(nativeResult),
        }),
      ),
    );
    const resolved = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)(recorded[0]);
    for (const priorRefs of [
      {},
      { legalEntityRef: nativeResult.legalEntityRef },
      { rolePeriodRef: nativeResult.rolePeriodRef },
    ]) {
      const originalOwnerReceipt = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceOwnerReceiptSchema)({
        _tag: 'CounterpartyCustomerOnboarded',
        counterpartyRef,
        partyRef: canonicalPartyRef,
        ...priorRefs,
      });
      const receipts: unknown[] = [];
      const recovered = yield* adapter.recover(
        yield* withOriginalRequest({
          ...input(),
          effect: resolved,
          legalEntityId: sellingLegalEntityId,
          originalOwnerReceipt,
          recordOwnerReceipt: (receipt) =>
            Effect.sync(() => {
              receipts.push(receipt);
            }),
        }),
      );
      expect(recovered.status).toBe('settled');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toEqual({ ...originalOwnerReceipt, actionInvocationId: invocationId });
      expect(Object.hasOwn(receipts[0] ?? {}, 'rolePeriodRef')).toBe(Object.hasOwn(priorRefs, 'rolePeriodRef'));
    }
    expect(calls.onboard).toHaveBeenCalledTimes(1);
    return yield* Effect.void;
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

const selectedMembershipGroup = {
  moduleId: 'commerce.customer-context',
  resourceId: '10000000-0000-4000-8000-000000000091',
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
};
const membershipSelector = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema.fields.selector)({
  kind: 'CUSTOMER_GROUP',
  source: {
    entityKind: 'CUSTOMER_GROUP',
    issuerId: 'group-definition-issuer',
    route: { integrationRouteId: routeId, tenantId },
    sourceNamespace: 'group-definitions',
    sourceRecordId: 'group-record-1',
  },
  target: selectedMembershipGroup,
});
const membershipEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  intent: {
    _tag: 'CustomerGroupMembership',
    payload: {
      effectiveAt: '2026-11-07T00:00:00.000Z',
      groupRef: selectedMembershipGroup,
      manager: {
        factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
        issuer: 'internal-symmy',
        sourceNamespace: 'customers',
        tenantId,
      },
      operation: 'ASSIGN',
      profile: { profileKind: 'RETAIL', profileRef: profile },
      reason: 'Explicit selected source membership',
      route: { id: routeId, revision: 'route-1' },
      source: { assertionId: 'occurrence-1', effectId, order: 1, sourceRecordId: 'customer-1' },
    },
  },
  ref: {
    ...effect.ref,
    operation: {
      entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
      moduleId: 'commerce.customer-context',
      schemaVersion: '1',
    },
    originalTarget: profile,
  },
});
const membershipCurrentGroup = Schema.decodeUnknownSync(CustomerGroupDefinitionSourceResponseSchema)({
  _tag: 'CURRENT',
  group: {
    businessCode: 'NATIVE_GROUP_CODE',
    currentDefinition: {
      changeKind: 'CREATED',
      description: 'Fixture definition',
      membershipCriteria: 'Explicit source meaning',
      name: 'Internal selected group',
      purpose: 'Internal source meaning',
      reason: 'Explicit source definition',
      recordedAt: '2026-11-07T00:00:00.000Z',
      revision: 1,
    },
    currentState: 'ACTIVE',
    definitionHistory: [],
    groupRef: selectedMembershipGroup,
    lifecycleHistory: [],
    meaningKey: 'internal.qualified-group',
    revision: 1,
  },
  source: {
    definitionEvidence: { kind: 'SOURCE_RECORD', reference: 'group-record-1', revision: 'source-group-1' },
    effectId: 'original-group-definition-effect',
    issuer: 'group-definition-issuer',
    mappingRevision: 'mapping-1',
    namespace: 'group-definitions',
    order: 0,
    recordId: 'group-record-1',
    revision: 'source-group-1',
    route: { id: routeId, revision: 'route-1' },
    sourceCode: 'RAW_GROUP_CODE',
  },
});
const membershipPayload = Match.value(membershipEffect.intent).pipe(
  Match.when({ _tag: 'CustomerGroupMembership' }, (value) => value.payload),
  Match.orElse(() => {
    throw new Error('Membership fixture invalid');
  }),
);
const membershipResult = Schema.decodeUnknownSync(ApplyCustomerGroupMembershipSourceResultSchema)({
  items: [],
  source: membershipPayload.source,
});
const membershipAdapter = Effect.gen(function* membershipAdapter() {
  const adapters = yield* makeSymmyPartyCommerceAdapters;
  const selected = adapters.find(
    (value) => value.operation.entrypointKey === membershipEffect.ref.operation.entrypointKey,
  );
  if (selected === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  return selected;
});
describe('current qualified Group Definition before first Membership write', () => {
  it.effect(
    'reads the real selector record and pins the native Group, not the membership source record or an equal code',
    () =>
      Effect.gen(function* currentQualifiedDefinition() {
        reset();
        calls.groupDefinition.mockReturnValue(Effect.succeed(membershipCurrentGroup));
        calls.membership.mockReturnValue(Effect.succeed(membershipResult));
        const adapter = yield* membershipAdapter;
        const result = yield* adapter.execute({
          ...input(),
          effect: membershipEffect,
          legalEntityId: sellingLegalEntityId,
          routeKey: 'customerGroupCustomersBatch',
          selector: membershipSelector,
        });
        expect(result.status).toBe('accepted_no_change');
        expect(calls.groupDefinition).toHaveBeenCalledTimes(1);
        expect(calls.groupDefinition.mock.calls[0]?.[0]).toEqual({
          issuer: 'group-definition-issuer',
          mappingRevision: 'mapping-1',
          mode: 'CURRENT',
          namespace: 'group-definitions',
          recordId: 'group-record-1',
          route: { id: routeId, revision: 'route-1' },
        });
        expect(calls.gateway[0]?.subject).toMatchObject({
          operationRequirementKey:
            'integration.symmy.requirement.worker.commerce.customer-context.api.customer-group-definition-source',
        });
        expect(calls.membership).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('never writes for absent, retargeted, stale or unavailable current definition', () =>
    Effect.gen(function* rejectedCurrentDefinition() {
      const current = Match.value(membershipCurrentGroup).pipe(
        Match.tag('CURRENT', (value) => value),
        Match.orElse(() => {
          throw new Error('CURRENT fixture invalid');
        }),
      );
      for (const response of [
        { _tag: 'ABSENT' },
        {
          ...current,
          group: {
            ...current.group,
            groupRef: { ...selectedMembershipGroup, resourceId: '10000000-0000-4000-8000-000000000092' },
          },
        },
        { ...current, source: { ...current.source, mappingRevision: 'stale-mapping' } },
        { ...current, source: { ...current.source, issuer: 'different-issuer' } },
        { ...current, source: { ...current.source, namespace: 'different-namespace' } },
        { ...current, source: { ...current.source, recordId: 'membership-row-is-not-group-record' } },
        { ...current, source: { ...current.source, route: { ...current.source.route, revision: 'stale-route' } } },
        {
          ...current,
          source: { ...current.source, route: { ...current.source.route, id: '10000000-0000-4000-8000-000000000093' } },
        },
      ]) {
        reset();
        calls.groupDefinition.mockReturnValue(
          Effect.succeed(Schema.decodeUnknownSync(CustomerGroupDefinitionSourceResponseSchema)(response)),
        );
        const adapter = yield* membershipAdapter;
        yield* adapter
          .execute({
            ...input(),
            effect: membershipEffect,
            legalEntityId: sellingLegalEntityId,
            routeKey: 'customerGroupCustomersBatch',
            selector: membershipSelector,
          })
          .pipe(Effect.result);
        expect(calls.membership).not.toHaveBeenCalled();
        expect(calls.hashes).toHaveLength(0);
      }
      reset();
      calls.groupDefinition.mockReturnValue(
        Effect.fail(
          CustomerGroupDefinitionSourceUnavailableProblemSchema.make({
            detail: 'Current source unavailable',
            retryable: true,
            status: 503,
            title: 'Unavailable',
            type: 'about:blank',
          }),
        ),
      );
      const adapter = yield* membershipAdapter;
      yield* adapter
        .execute({
          ...input(),
          effect: membershipEffect,
          legalEntityId: sellingLegalEntityId,
          routeKey: 'customerGroupCustomersBatch',
          selector: membershipSelector,
        })
        .pipe(Effect.result);
      expect(calls.membership).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('uses the exact accepted Membership receipt without retargeting through the current Group selector', () =>
    Effect.gen(function* originalReceiptOnly() {
      reset();
      calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      calls.membershipReceipt.mockReturnValue(Effect.succeed(membershipResult));
      const adapter = yield* membershipAdapter;
      const recovered = yield* adapter.recover(
        yield* withOriginalRequest({
          ...input(),
          effect: membershipEffect,
          legalEntityId: sellingLegalEntityId,
          routeKey: 'customerGroupCustomersBatch',
        }),
      );
      expect(recovered.status).toBe('settled');
      expect(calls.membershipReceipt).toHaveBeenCalledTimes(1);
      expect(calls.groupDefinition).not.toHaveBeenCalled();
      expect(calls.membership).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
});

it.effect(
  'keeps native complete sets on the genuine generic route and refuses selected-route COMPLETE before any owner call',
  () =>
    Effect.gen(function* scopeCorrectComplete() {
      const complete = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
        ...membershipEffect,
        intent: {
          _tag: 'CustomerGroupMembership',
          payload: {
            completenessProofRef: 'explicit.complete.source-proof',
            effectiveAt: membershipPayload.effectiveAt,
            groupRefs: [],
            manager: membershipPayload.manager,
            operation: 'COMPLETE',
            profile: membershipPayload.profile,
            reason: membershipPayload.reason,
            route: membershipPayload.route,
            source: membershipPayload.source,
          },
        },
      });
      reset();
      const adapter = yield* membershipAdapter;
      const selected = yield* adapter.execute({
        ...input(),
        effect: complete,
        legalEntityId: sellingLegalEntityId,
        routeKey: 'customerGroupCustomersBatch',
        selector: membershipSelector,
      });
      expect(selected).toEqual({
        owner: 'commerce.customer-context',
        reason: 'missing_context',
        status: 'unsupported',
      });
      expect(calls.membership).not.toHaveBeenCalled();
      expect(calls.groupDefinition).not.toHaveBeenCalled();
      expect(calls.gateway).toHaveLength(0);
      reset();
      calls.membership.mockReturnValue(Effect.succeed(membershipResult));
      const generic = yield* adapter.execute({
        ...input(),
        effect: complete,
        legalEntityId: sellingLegalEntityId,
        routeKey: 'customersBatch',
      });
      expect(generic.status).toBe('accepted_no_change');
      expect(calls.membership).toHaveBeenCalledTimes(1);
      expect(calls.groupDefinition).not.toHaveBeenCalled();
      reset();
      const uncertain = yield* adapter
        .execute({
          ...input(),
          effect: complete,
          legalEntityId: sellingLegalEntityId,
          originalExecutorPrincipalId: executorPrincipalId,
          routeKey: 'customerGroupCustomersBatch',
          selector: membershipSelector,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(uncertain)).toBe(true);
      expect(calls.membership).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect(
  'requires the genuine selected route, selector, native target and Tenant before any current binding request',
  () =>
    Effect.gen(function* selectorScopeOnly() {
      const mismatched = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
        ...membershipEffect,
        intent: {
          _tag: 'CustomerGroupMembership',
          payload: {
            ...membershipPayload,
            groupRef: { ...selectedMembershipGroup, resourceId: '10000000-0000-4000-8000-000000000092' },
          },
        },
      });
      const foreignSelector = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema.fields.selector)({
        ...membershipSelector,
        source: {
          ...membershipSelector?.source,
          route: { integrationRouteId: routeId, tenantId: '10000000-0000-4000-8000-000000000094' },
        },
      });
      const adapter = yield* membershipAdapter;
      for (const variant of [
        { effect: membershipEffect, routeKey: 'customerGroupCustomersBatch' as const },
        { effect: mismatched, routeKey: 'customerGroupCustomersBatch' as const, selector: membershipSelector },
        { effect: membershipEffect, routeKey: 'customerGroupCustomersBatch' as const, selector: foreignSelector },
        { effect: membershipEffect, selector: membershipSelector },
      ]) {
        reset();
        const result = yield* adapter
          .execute({ ...input(), ...variant, legalEntityId: sellingLegalEntityId })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(calls.membership).not.toHaveBeenCalled();
        expect(calls.groupDefinition).not.toHaveBeenCalled();
        expect(calls.gateway).toHaveLength(0);
      }
    }).pipe(Effect.provide(nodeCryptoLayer)),
);

const organizationIcoProfile = {
  moduleId: 'commerce.customer-context',
  resourceId: '10000000-0000-4000-8000-000000000071',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
};
const organizationIcoEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  intent: {
    _tag: 'OrganizationCustomerProfileIco',
    payload: {
      countryCode: 'CZ',
      effectId,
      effectiveAt: '2026-11-07T00:00:00.000Z',
      expectedRevision: 0,
      identifier: { identifierType: 'ICO', value: '27074358' },
      operation: 'SET',
      originalInput: '27074358',
      profileRef: organizationIcoProfile,
    },
    sourceReference: {
      occurrenceId: 'occurrence-1',
      recordId: 'customer-1',
      source: { issuer: 'internal-symmy', namespace: 'customers', recordType: 'CUSTOMER', routeRef: routeId },
    },
  },
  ref: {
    ...effect.ref,
    operation: {
      entrypointKey: 'commerce.customer-context.change-organization-customer-profile-ico',
      moduleId: 'commerce.customer-context',
      schemaVersion: '1',
    },
    originalTarget: organizationIcoProfile,
  },
});
const organizationIcoCurrentProfile = Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)({
  _tag: 'CURRENT',
  item: {
    icoAuthority: 'ORGANIZATION',
    partyRef: canonicalPartyRef,
    partySourceReference: {
      occurrenceId: 'original-party-occurrence',
      recordId: 'party-record-1',
      source: {
        issuer: 'independent-party-issuer',
        namespace: 'party-citation',
        recordType: 'CUSTOMER',
        routeRef: routeId,
      },
    },
    profile: {
      profileRef: { ...organizationIcoProfile, kind: 'COUNTERPARTY' },
      revision: 1,
      state: 'ACTIVE',
      subject: {
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceId: '10000000-0000-4000-8000-000000000072',
          resourceType: 'party.registry.counterparty',
          tenantId,
        },
        kind: 'COUNTERPARTY',
      },
    },
    source: {
      effectId: 'original-profile-effect',
      issuer: 'internal-symmy',
      mappingRevision: 'mapping-1',
      namespace: 'customers',
      occurrenceId: 'original-profile-creation-occurrence',
      order: 0,
      recordId: 'customer-1',
      recordType: 'CUSTOMER',
      revision: 'source-1',
      route: { id: routeId, revision: 'route-1' },
    },
  },
});
const organizationIcoNative = Schema.decodeUnknownSync(ChangeOrganizationCustomerProfileIcoResultSchema)({
  assertion: {
    effectiveAt: '2026-11-07T00:00:00.000Z',
    effectiveTo: null,
    isCurrent: true,
    normalizedValue: '27074358',
    normalizerVersion: 'CZ:ICO:party-v1',
    operation: 'SET',
    originalInput: { digits: '27074358', kind: 'KNOWN' },
    partyRef: canonicalPartyRef,
    profileRef: organizationIcoProfile,
    provenance: { ownerReceiptRef: { _tag: 'CORE_ACTION_INVOCATION', actionInvocationId: invocationId } },
    recordedAt: '2026-11-07T00:00:00.000Z',
    revision: 1,
  },
  outcome: 'APPLIED',
});
const organizationIcoAdapter = Effect.gen(function* organizationIcoAdapter() {
  const adapters = yield* makeSymmyPartyCommerceAdapters;
  const adapter = adapters.find(
    (value) => value.operation.entrypointKey === organizationIcoEffect.ref.operation.entrypointKey,
  );
  if (adapter === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  return adapter;
});
describe('explicit organization contextual ICO native path', () => {
  it.effect(
    'uses exact current source-to-profile binding and the explicit company Action without personal fallback',
    () =>
      Effect.gen(function* organizationIcoWrite() {
        reset();
        calls.profileReceipt.mockReturnValue(Effect.succeed(organizationIcoCurrentProfile));
        calls.organizationIco.mockReturnValue(Effect.succeed(organizationIcoNative));
        const adapter = yield* organizationIcoAdapter;
        const result = yield* adapter.execute({
          ...input(),
          effect: organizationIcoEffect,
          legalEntityId: sellingLegalEntityId,
        });
        expect(result.status).toBe('accepted_change');
        expect(calls.organizationIco).toHaveBeenCalledTimes(1);
        expect(calls.profileReceipt.mock.calls[0]?.[0]).toEqual({
          issuer: 'internal-symmy',
          mappingRevision: 'mapping-1',
          mode: 'CURRENT',
          namespace: 'customers',
          recordId: 'customer-1',
          recordType: 'CUSTOMER',
          route: { id: routeId, revision: 'route-1' },
        });
        expect(calls.privacy).not.toHaveBeenCalled();
        expect(calls.hashes).toHaveLength(1);
        expect(calls.gateway[0]?.subject).toMatchObject({
          operationRequirementKey:
            'integration.symmy.requirement.worker.commerce.customer-context.api.customer-profile-source',
        });
        expect(calls.gateway[1]?.subject).toMatchObject({
          operationRequirementKey:
            'integration.symmy.requirement.worker.commerce.customer-context.change-organization-customer-profile-ico',
        });
      }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('does not write or switch to personal handling for an absent or retargeted source profile', () =>
    Effect.gen(function* organizationSourceRefusal() {
      const current = Match.value(organizationIcoCurrentProfile).pipe(
        Match.tag('CURRENT', (value) => value),
        Match.orElse(() => {
          throw new Error('CURRENT fixture invalid');
        }),
      );
      for (const response of [
        { _tag: 'ABSENT' },
        { ...current, item: { ...current.item, icoAuthority: 'PERSONAL' } },
        {
          ...current,
          item: {
            ...current.item,
            profile: {
              ...current.item.profile,
              profileRef: { ...current.item.profile.profileRef, resourceId: '10000000-0000-4000-8000-000000000073' },
            },
          },
        },
      ]) {
        reset();
        calls.profileReceipt.mockReturnValue(
          Effect.succeed(Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)(response)),
        );
        const adapter = yield* organizationIcoAdapter;
        const result = yield* adapter
          .execute({ ...input(), effect: organizationIcoEffect, legalEntityId: sellingLegalEntityId })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(calls.organizationIco).not.toHaveBeenCalled();
        expect(calls.privacy).not.toHaveBeenCalled();
        expect(calls.hashes).toHaveLength(0);
      }
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect(
    'recovers only the exact original native company ICO receipt without rechecking source targeting or rewriting',
    () =>
      Effect.gen(function* organizationExactReceipt() {
        reset();
        calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
        calls.organizationIcoRead.mockReturnValue(
          Effect.succeed(
            Schema.decodeUnknownSync(OrganizationCustomerProfileIcoResponseSchema)({
              _tag: 'RECEIPT',
              assertion: organizationIcoNative.assertion,
            }),
          ),
        );
        const adapter = yield* organizationIcoAdapter;
        const recovered = yield* adapter.recover(
          yield* withOriginalRequest({
            ...input(),
            effect: organizationIcoEffect,
            legalEntityId: sellingLegalEntityId,
          }),
        );
        expect(recovered.status).toBe('settled');
        expect(calls.organizationIcoRead.mock.calls[0]?.[0]).toEqual({
          actionInvocationId: invocationId,
          profileRef: organizationIcoProfile,
        });
        expect(calls.profileReceipt).not.toHaveBeenCalled();
        expect(calls.organizationIco).not.toHaveBeenCalled();
        expect(calls.privacy).not.toHaveBeenCalled();
      }).pipe(Effect.provide(nodeCryptoLayer)),
  );
});

it.effect('keeps explicit company Privacy denial terminal and does not switch to a personal action or migration', () =>
  Effect.gen(function* companyPrivacyDenied() {
    reset();
    calls.profileReceipt.mockReturnValue(Effect.succeed(organizationIcoCurrentProfile));
    calls.organizationIco.mockReturnValue(
      Effect.fail(
        ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema.make({
          code: 'PRIVACY_DENIED',
          detail: 'Current company policy denies the native fields',
          status: 422,
          title: 'Ineligible',
          type: 'about:blank',
        }),
      ),
    );
    const adapter = yield* organizationIcoAdapter;
    const result = yield* adapter.execute({
      ...input(),
      effect: organizationIcoEffect,
      legalEntityId: sellingLegalEntityId,
    });
    expect(result.status).toBe('denied');
    expect(calls.organizationIco).toHaveBeenCalledTimes(1);
    expect(calls.organizationIcoRead).not.toHaveBeenCalled();
    expect(calls.privacy).not.toHaveBeenCalled();
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.factReads).toBe(0);
  }).pipe(Effect.provide(nodeCryptoLayer)),
);
it.effect('does not settle a mismatched company ICO receipt or reinterpret forbidden recovery as a new rejection', () =>
  Effect.gen(function* exactCompanyRecoveryRefusal() {
    const adapter = yield* organizationIcoAdapter;
    for (const assertion of [
      { ...organizationIcoNative.assertion, originalInput: { digits: '12345678', kind: 'KNOWN' } },
      {
        ...organizationIcoNative.assertion,
        provenance: {
          ownerReceiptRef: {
            _tag: 'CORE_ACTION_INVOCATION',
            actionInvocationId: '10000000-0000-4000-8000-000000000075',
          },
        },
      },
    ]) {
      reset();
      calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      calls.organizationIcoRead.mockReturnValue(
        Effect.succeed(
          Schema.decodeUnknownSync(OrganizationCustomerProfileIcoResponseSchema)({ _tag: 'RECEIPT', assertion }),
        ),
      );
      const result = yield* adapter.recover(
        yield* withOriginalRequest({ ...input(), effect: organizationIcoEffect, legalEntityId: sellingLegalEntityId }),
      );
      expect(result.status).toBe('unavailable');
      expect(calls.organizationIco).not.toHaveBeenCalled();
      expect(calls.profileReceipt).not.toHaveBeenCalled();
    }
    reset();
    calls.fact = { actionInvocationId: invocationId, status: 'succeeded' };
    calls.organizationIcoRead.mockReturnValue(
      Effect.fail(
        OrganizationCustomerProfileIcoForbiddenProblemSchema.make({
          detail: 'Current original-receipt policy denies disclosure',
          status: 403,
          title: 'Forbidden',
          type: 'about:blank',
        }),
      ),
    );
    const result = yield* adapter
      .recover(
        yield* withOriginalRequest({ ...input(), effect: organizationIcoEffect, legalEntityId: sellingLegalEntityId }),
      )
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls.organizationIco).not.toHaveBeenCalled();
    expect(calls.profileReceipt).not.toHaveBeenCalled();
    expect(calls.privacy).not.toHaveBeenCalled();
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect(
  'reports the explicit organization migration fence prerequisite without automatic cutover or a personal fallback',
  () =>
    Effect.gen(function* companyFenceRequired() {
      reset();
      calls.profileReceipt.mockReturnValue(Effect.succeed(organizationIcoCurrentProfile));
      calls.organizationIco.mockReturnValue(
        Effect.fail(
          ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema.make({
            code: 'MIGRATION_REQUIRED',
            detail: 'Native owner requires the explicit operator fence',
            status: 422,
            title: 'Ineligible',
            type: 'about:blank',
          }),
        ),
      );
      const adapter = yield* organizationIcoAdapter;
      const result = yield* adapter.execute({
        ...input(),
        effect: organizationIcoEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result).toEqual({ owner: 'commerce.customer-context', reason: 'missing_context', status: 'unsupported' });
      expect(calls.organizationIco).toHaveBeenCalledTimes(1);
      expect(calls.organizationIcoRead).not.toHaveBeenCalled();
      expect(calls.privacy).not.toHaveBeenCalled();
      expect(calls.create).not.toHaveBeenCalled();
      expect(calls.factReads).toBe(0);
    }).pipe(Effect.provide(nodeCryptoLayer)),
);

const organizationAssignmentCounterparty = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000081',
  resourceType: 'party.registry.counterparty',
  tenantId,
};
const organizationAssignmentProfile = { ...organizationIcoProfile, kind: 'COUNTERPARTY' };
const organizationAssignmentIntent = Schema.decodeUnknownSync(SymmyPartyCommerceIntentSchema)({
  _tag: 'AssignCounterpartyPriceGroup',
  authorizationSubject: { counterpartyRef: organizationAssignmentCounterparty, kind: 'COUNTERPARTY' },
  payload: {
    counterpartyRef: organizationAssignmentCounterparty,
    effectiveFrom: '2026-11-07T00:00:00.000Z',
    expectedProfileRevision: 1,
    priceGroupRef,
    processingKind: 'ORGANIZATION_BUSINESS',
    profile: organizationAssignmentProfile,
    source: {
      effectId,
      issuer: 'internal-symmy',
      mappingRevision: 'mapping-1',
      namespace: 'customers',
      occurrenceId: 'occurrence-1',
      order: 1,
      recordId: 'customer-1',
      recordType: 'CUSTOMER',
      revision: 'source-1',
      route: { id: routeId, revision: 'route-1' },
    },
  },
});
const organizationAssignmentEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  intent: organizationAssignmentIntent,
  ref: {
    ...effect.ref,
    operation: {
      entrypointKey: 'commerce.customer-context.assign-counterparty-price-group',
      moduleId: 'commerce.customer-context',
      schemaVersion: '1',
    },
    originalTarget: organizationAssignmentProfile,
  },
});
const organizationAssignmentResult = Schema.decodeUnknownSync(AssignCounterpartyPriceGroupResultSchema)({
  assignment: {
    assignmentRef: assignmentResult.assignment.assignmentRef,
    effectiveFrom: '2026-11-07T00:00:00.000Z',
    effectiveTo: null,
    priceGroupRef,
    profile: organizationAssignmentProfile,
    recordedAt: '2026-11-07T00:00:00.000Z',
    revision: 1,
    state: 'ACTIVE',
  },
  changed: true,
  processingKind: 'ORGANIZATION_BUSINESS',
  replacedAssignmentRef: null,
});
const counterpartyAssignmentAdapter = Effect.gen(function* counterpartyAssignmentAdapter() {
  const adapters = yield* makeSymmyPartyCommerceAdapters;
  const adapter = adapters.find(
    (candidate) => candidate.operation.entrypointKey === organizationAssignmentEffect.ref.operation.entrypointKey,
  );
  if (adapter === undefined) {
    return yield* symmyJobWorkerUnavailable();
  }
  return adapter;
});
describe('explicit company price assignment processing branch', () => {
  it.effect('sends the validated company command to its native owner without the personal-data checker', () =>
    Effect.gen(function* organizationNativeBranch() {
      reset();
      calls.counterpartyAssignment.mockReturnValue(Effect.succeed(organizationAssignmentResult));
      const adapter = yield* counterpartyAssignmentAdapter;
      const result = yield* adapter.execute({
        ...input(),
        effect: organizationAssignmentEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result.status).toBe('accepted_change');
      expect(calls.counterpartyAssignment).toHaveBeenCalledTimes(1);
      expect(calls.privacy).not.toHaveBeenCalled();
      expect(calls.gateway).toHaveLength(1);
      expect(calls.gateway[0]?.audience).toBe('commerce-customer-context');
      expect(calls.gateway[0]?.subject).toMatchObject({
        declarationKey: 'commerce.customer-context.counterparty-price-group.assign',
      });
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('preserves the personal Counterparty policy check and stops its denied command', () =>
    Effect.gen(function* personalCounterpartyDenied() {
      reset();
      calls.privacy.mockReturnValue(Effect.succeed(privacyDenied));
      const personal = Match.value(organizationAssignmentIntent).pipe(
        Match.tag('AssignCounterpartyPriceGroup', (value) => ({
          ...value,
          payload: { ...value.payload, processingKind: 'PERSONAL_DATA', reason: 'Explicit personal assignment' },
        })),
        Match.orElse(() => {
          throw new Error('Counterparty assignment fixture invalid');
        }),
      );
      const selected = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
        ...organizationAssignmentEffect,
        intent: personal,
      });
      const adapter = yield* counterpartyAssignmentAdapter;
      const result = yield* adapter.execute({ ...input(), effect: selected, legalEntityId: sellingLegalEntityId });
      expect(result.status).toBe('denied');
      expect(calls.privacy).toHaveBeenCalledTimes(1);
      expect(calls.counterpartyAssignment).not.toHaveBeenCalled();
      expect(calls.hashes).toHaveLength(0);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('validates malformed company commands before any credential or owner HTTP call', () =>
    Effect.gen(function* malformedCompanyBoundary() {
      const adapter = yield* counterpartyAssignmentAdapter;
      for (const reason of ['unbounded narrative', null]) {
        reset();
        const malformed = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)(organizationAssignmentEffect);
        // Deliberately corrupt a decoded fixture to exercise the adapter's runtime input boundary.
        const invalid = Match.value(organizationAssignmentIntent).pipe(
          Match.tag('AssignCounterpartyPriceGroup', (value) => ({ ...value, payload: { ...value.payload, reason } })),
          Match.orElse(() => {
            throw new Error('Counterparty assignment fixture invalid');
          }),
        );
        Object.defineProperty(malformed, 'intent', { value: invalid });
        const result = yield* adapter
          .execute({ ...input(), effect: malformed, legalEntityId: sellingLegalEntityId })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(calls.gateway).toHaveLength(0);
        expect(calls.privacy).not.toHaveBeenCalled();
        expect(calls.counterpartyAssignment).not.toHaveBeenCalled();
      }
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
  it.effect('retains native company refusal without retrying through personal processing', () =>
    Effect.gen(function* noDenialFallback() {
      reset();
      calls.counterpartyAssignment.mockReturnValue(
        Effect.fail(
          AssignCounterpartyPriceGroupActionForbiddenProblemSchema.make({
            code: 'customer_price_group_source_privacy_denied',
            detail: 'Current company processing is denied',
            status: 403,
            title: 'Forbidden',
            type: 'about:blank',
          }),
        ),
      );
      const adapter = yield* counterpartyAssignmentAdapter;
      const result = yield* adapter.execute({
        ...input(),
        effect: organizationAssignmentEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result.status).toBe('denied');
      expect(calls.counterpartyAssignment).toHaveBeenCalledTimes(1);
      expect(calls.privacy).not.toHaveBeenCalled();
      expect(calls.gateway).toHaveLength(1);
      expect(calls.factReads).toBe(0);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );
});
