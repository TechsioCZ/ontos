import { AssignCounterpartyPriceGroupResultSchema } from '@app/commerce-customer-context/actions/assign-counterparty-price-group';
import { UpdateCustomerGroupResultSchema } from '@app/commerce-customer-context/actions/update-customer-group';
import { AddSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/add-saved-address-action';
import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import {
  AssignCounterpartyPriceGroupActionForbiddenProblemSchema,
  AssignCounterpartyPriceGroupPayloadSchema,
} from '@app/commerce-customer-context/api/assign-counterparty-price-group-action';
import { AssignCustomerPriceGroupPayloadSchema } from '@app/commerce-customer-context/api/assign-customer-price-group-action';
import { ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema } from '@app/commerce-customer-context/api/change-organization-customer-profile-ico-action';
import { OrganizationCustomerProfileIcoForbiddenProblemSchema } from '@app/commerce-customer-context/api/organization-customer-profile-ico';
import {
  ChangeOrganizationCustomerProfileIcoPayloadSchema,
  ChangeOrganizationCustomerProfileIcoResultSchema,
  OrganizationCustomerProfileIcoRequestSchema,
  OrganizationCustomerProfileIcoResponseSchema,
} from '@app/commerce-customer-context/domain/organization-profile-ico';
import {
  CustomerGroupDefinitionSourceRequestSchema,
  CustomerGroupDefinitionSourceResponseSchema,
  CustomerGroupDefinitionSourceUnavailableProblemSchema,
} from '@app/commerce-customer-context/api/customer-group-definition-source';
import {
  CustomerGroupMembershipSourceReceiptRequestSchema,
  CustomerGroupMembershipSourceReceiptResponseSchema,
} from '@app/commerce-customer-context/api/customer-group-membership-source-receipt';
import { ApplyCustomerGroupMembershipSourceResultSchema } from '@app/commerce-customer-context/actions/apply-customer-group-membership-source';
import {
  OrganizationBusinessSourceStatement,
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessCustomerRoleReason,
  OrganizationBusinessOnboardTemplateProjectionVersion,
} from '@app/party-registry/apis/organization-record-facts';
import {
  UpdateCustomerGroupActionIneligibleProblemSchema,
  UpdateCustomerGroupPayloadSchema,
} from '@app/commerce-customer-context/api/update-customer-group-action';
import {
  CustomerProfileSourceRequestSchema,
  CustomerProfileSourceResponseSchema,
  CustomerProfileSourceForbiddenProblemSchema,
  CustomerProfileSourceUnavailableProblemSchema,
} from '@app/commerce-customer-context/api/customer-profile-source';
import {
  SavedAddressSourceReceiptRequestSchema,
  SavedAddressSourceReceiptResponseSchema,
} from '@app/commerce-customer-context/api/saved-address-source-receipt';
import { AddSavedAddressResultSchema } from '@app/commerce-customer-context/actions/add-saved-address';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { EnsureRetailCustomerProfileResultSchema } from '@app/commerce-customer-context/actions/ensure-retail-customer-profile';
import { EnsureRetailCustomerProfilePayloadSchema } from '@app/commerce-customer-context/api/ensure-retail-customer-profile-action';
import {
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingEligibilityResponseSchema,
} from '@app/privacy/api/source-processing-eligibility';
import {
  CustomerPriceGroupAssignmentReceiptForbiddenProblemSchema,
  CustomerPriceGroupAssignmentReceiptRequestSchema,
  CustomerPriceGroupAssignmentReceiptResponseSchema,
} from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt';
import { AssignCustomerPriceGroupResultSchema } from '@app/commerce-customer-context/actions/assign-customer-price-group';
import {
  CreatePartyPayloadSchema,
  CreatePartyResultSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
  EndContactPointPayloadSchema,
  EndContactPointResultSchema,
  PartyCommandAlreadyCommittedProblemSchema,
  PartyCommandCommitIndeterminateProblemSchema,
  PartyCommandForbiddenProblemSchema,
} from '@app/party-registry/api';
import {
  PartySourceEffectReceiptRequestSchema,
  PartySourceEffectReceiptResponseSchema,
  PartySourceEffectReceiptForbiddenProblemSchema,
} from '@app/party-registry/apis/party-source-effect-receipt';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import {
  GatewayContextResponseSchema,
  GatewayDelegatedContextRequestSchema,
  shellGatewayContextContract,
} from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Effect, Match, Option, Result, Schema, Struct } from 'effect';
import type { Crypto } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

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
import { symmyWorkerCompositionRevision, withSymmyWorkerClaim } from '../support/symmy-worker-claim.fixture.ts';

const executorPrincipalId = '10000000-0000-4000-8000-000000000008';
const fixtureAuthContextRef = 'job:integration.symmy.execute-symmy-job:run:10000000-0000-4000-8000-000000000010';
const invocationId = '10000000-0000-4000-8000-000000000009';

/**
 * The owner deployments Symmy reaches, as native HTTP peers behind the actual generated owner clients and
 * the actual delegated Shell gateway client. Each peer reads the schema-valid request it was sent and
 * answers with the schema-valid response or problem the test scripts for it.
 */
type OwnerReply = () => Response;
interface RoutedOwnerEndpoint {
  readonly path: string;
  readonly receive: (request: Request, text: string) => Option.Option<OwnerReply>;
  readonly reset: () => void;
  readonly write: boolean;
}
const problemReply =
  <Problem extends { readonly status: number }, Encoded>(
    schema: Schema.Codec<Problem, Encoded>,
    problem: Problem,
  ): OwnerReply =>
  () =>
    Response.json(Schema.encodeSync(schema)(problem), {
      headers: { 'content-type': 'application/problem+json' },
      status: problem.status,
    });
const ownerEndpoint = <Body, BodyEncoded, Success, SuccessEncoded>(
  path: string,
  schemas: {
    readonly body: Schema.Codec<Body, BodyEncoded>;
    readonly success: Schema.Codec<Success, SuccessEncoded>;
    readonly write: boolean;
  },
) => {
  const bodies: Body[] = [];
  const sent: Request[] = [];
  const queued: OwnerReply[] = [];
  let fallback = Option.none<OwnerReply>();
  const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(schemas.body));
  const encodeSuccess = Schema.encodeSync(schemas.success);
  const succeeding =
    (value: () => Success): OwnerReply =>
    () =>
      Response.json(encodeSuccess(value()));
  const endpoint = {
    /** Answers every later request with the owner's response computed when the request arrives. */
    answer: (value: () => Success) => {
      fallback = Option.some(succeeding(value));
    },
    bodies,
    fail: <Problem extends { readonly status: number }, Encoded>(
      schema: Schema.Codec<Problem, Encoded>,
      problem: Problem,
    ) => {
      fallback = Option.some(problemReply(schema, problem));
    },
    failOnce: <Problem extends { readonly status: number }, Encoded>(
      schema: Schema.Codec<Problem, Encoded>,
      problem: Problem,
    ) => {
      queued.push(problemReply(schema, problem));
      return endpoint;
    },
    path,
    /** Records the schema-valid request; an undecodable one gets no scripted reply. */
    receive: (request: Request, text: string) => {
      sent.push(request);
      return Option.flatMap(decodeBody(text), (body) => {
        bodies.push(body);
        return Option.orElse(Option.fromNullishOr(queued.shift()), () => fallback);
      });
    },
    reset: () => {
      bodies.length = 0;
      sent.length = 0;
      queued.length = 0;
      fallback = Option.none();
    },
    sent,
    succeed: (value: Success) => {
      fallback = Option.some(succeeding(() => value));
    },
    succeedOnce: (value: Success) => {
      queued.push(succeeding(() => value));
      return endpoint;
    },
    write: schemas.write,
  };
  return endpoint;
};
const owners = {
  address: ownerEndpoint('/commerce-customer-context/actions/add-saved-address', {
    body: AddSavedAddressPayloadSchema,
    success: AddSavedAddressResultSchema,
    write: true,
  }),
  addressReceipt: ownerEndpoint('/reads/saved-address-source-receipt', {
    body: SavedAddressSourceReceiptRequestSchema,
    success: SavedAddressSourceReceiptResponseSchema,
    write: false,
  }),
  assignment: ownerEndpoint('/commerce-customer-context/actions/assign-customer-price-group', {
    body: AssignCustomerPriceGroupPayloadSchema,
    success: AssignCustomerPriceGroupResultSchema,
    write: true,
  }),
  assignmentReceipt: ownerEndpoint('/reads/customer-price-group-assignment-receipt', {
    body: CustomerPriceGroupAssignmentReceiptRequestSchema,
    success: CustomerPriceGroupAssignmentReceiptResponseSchema,
    write: false,
  }),
  counterpartyAssignment: ownerEndpoint('/commerce-customer-context/actions/assign-counterparty-price-group', {
    body: AssignCounterpartyPriceGroupPayloadSchema,
    success: AssignCounterpartyPriceGroupResultSchema,
    write: true,
  }),
  create: ownerEndpoint('/party-registry/actions/create-party', {
    body: CreatePartyPayloadSchema,
    success: CreatePartyResultSchema,
    write: true,
  }),
  endContact: ownerEndpoint('/party-registry/actions/end-contact-point', {
    body: EndContactPointPayloadSchema,
    success: EndContactPointResultSchema,
    write: true,
  }),
  groupDefinition: ownerEndpoint('/reads/customer-group-definition-source', {
    body: CustomerGroupDefinitionSourceRequestSchema,
    success: CustomerGroupDefinitionSourceResponseSchema,
    write: false,
  }),
  membership: ownerEndpoint('/commerce-customer-context/actions/apply-customer-group-membership-source', {
    body: ApplyCustomerGroupMembershipSourcePayloadSchema,
    success: ApplyCustomerGroupMembershipSourceResultSchema,
    write: true,
  }),
  membershipReceipt: ownerEndpoint('/reads/customer-group-membership-source-receipt', {
    body: CustomerGroupMembershipSourceReceiptRequestSchema,
    success: CustomerGroupMembershipSourceReceiptResponseSchema,
    write: false,
  }),
  onboard: ownerEndpoint('/party-registry/actions/counterparty-customer-onboard', {
    body: CounterpartyCustomerOnboardPayloadSchema,
    success: CounterpartyCustomerOnboardResultSchema,
    write: true,
  }),
  organizationIco: ownerEndpoint('/commerce-customer-context/actions/change-organization-customer-profile-ico', {
    body: ChangeOrganizationCustomerProfileIcoPayloadSchema,
    success: ChangeOrganizationCustomerProfileIcoResultSchema,
    write: true,
  }),
  organizationIcoRead: ownerEndpoint('/reads/organization-customer-profile-ico', {
    body: OrganizationCustomerProfileIcoRequestSchema,
    success: OrganizationCustomerProfileIcoResponseSchema,
    write: false,
  }),
  privacy: ownerEndpoint('/reads/source-processing-eligibility', {
    body: SourceProcessingEligibilityRequestSchema,
    success: SourceProcessingEligibilityResponseSchema,
    write: false,
  }),
  profileReceipt: ownerEndpoint('/reads/customer-profile-source', {
    body: CustomerProfileSourceRequestSchema,
    success: CustomerProfileSourceResponseSchema,
    write: false,
  }),
  receipt: ownerEndpoint('/reads/party-source-effect-receipt', {
    body: PartySourceEffectReceiptRequestSchema,
    success: PartySourceEffectReceiptResponseSchema,
    write: false,
  }),
  retail: ownerEndpoint('/commerce-customer-context/actions/ensure-retail-customer-profile', {
    body: EnsureRetailCustomerProfilePayloadSchema,
    success: EnsureRetailCustomerProfileResultSchema,
    write: true,
  }),
  updateGroup: ownerEndpoint('/commerce-customer-context/actions/update-customer-group', {
    body: UpdateCustomerGroupPayloadSchema,
    success: UpdateCustomerGroupResultSchema,
    write: true,
  }),
};
const routedOwners: readonly RoutedOwnerEndpoint[] = Object.values(owners);
interface PeerState {
  /** Whether Core records the succeeded invocation once an owner write is acknowledged. */
  exposeCommittedAckFact: boolean;
  fact: { actionInvocationId: string; status: string } | null;
  factReads: number;
  readonly gateway: (typeof GatewayDelegatedContextRequestSchema.Type)[];
  readonly hashes: { authContextRef: string; hash: string }[];
  readonly order: string[];
  /** Requests no owner peer was scripted to answer; every test ends with none. */
  readonly unrouted: string[];
}
const peer: PeerState & typeof owners = {
  ...owners,
  exposeCommittedAckFact: true,
  fact: null,
  factReads: 0,
  gateway: [],
  hashes: [],
  order: [],
  unrouted: [],
};
const decodeGatewayRequest = Schema.decodeUnknownSync(Schema.fromJsonString(GatewayDelegatedContextRequestSchema));
const encodeGatewayResponse = Schema.encodeUnknownSync(GatewayContextResponseSchema);
/** The Shell issuer: a fresh operation-bound credential, plus original-invocation metadata only Core can prove. */
const issueDelegatedContext = (text: string) => {
  const request = decodeGatewayRequest(text);
  peer.gateway.push(request);
  const recovery = Match.value(request.subject).pipe(
    Match.tag('RegisteredRecovery', (subject) =>
      peer.fact === null
        ? {}
        : {
            recovery: {
              originalActionInvocationId: peer.fact.actionInvocationId,
              originalActionKey: subject.originalActionKey,
              originalAuthContextRef: fixtureAuthContextRef,
              originalIdempotencyKey: subject.originalIdempotencyKey,
              originalPrincipalId: subject.originalPrincipalId,
              originalRequestHash: subject.originalRequestHash,
              requestHash: subject.requestHash,
            },
          },
    ),
    Match.orElse(() => ({})),
  );
  return Response.json(
    encodeGatewayResponse({
      apiBaseUrl: `/${request.audience}-api`,
      compositionRevision: request.compositionRevision,
      expiresAt: 1_700_000_300,
      machineContext: {
        authContextRef: fixtureAuthContextRef,
        bindingIncarnation: '10000000-0000-4000-8000-000000000007',
        principalId: executorPrincipalId,
      },
      token: `internal-attempt-${peer.gateway.length}`,
      ...recovery,
    }),
  );
};
const answerPeer = (request: Request, text: string): Response => {
  const { pathname } = new URL(request.url);
  if (pathname === shellGatewayContextContract.issueDelegatedGatewayContextPath) {
    return issueDelegatedContext(text);
  }
  const endpoint = routedOwners.find((candidate) => pathname.endsWith(candidate.path));
  const reply = endpoint === undefined ? Option.none() : endpoint.receive(request, text);
  if (endpoint === undefined || Option.isNone(reply)) {
    peer.unrouted.push(pathname);
    return Response.json(
      { detail: `No scripted owner response for ${pathname}`, status: 500, title: 'Internal', type: 'about:blank' },
      { headers: { 'content-type': 'application/problem+json' }, status: 500 },
    );
  }
  const response = reply.value();
  // Published owner successes model the native Core commit separately from their DTO; production reads real facts.
  if (endpoint.write && response.ok && peer.exposeCommittedAckFact && peer.fact === null) {
    peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
  }
  return response;
};
const fetchPeer: typeof globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  return request
    .clone()
    .text()
    .then((text) => answerPeer(request, text));
};
const peerConfiguration = ConfigProvider.fromEnvRecord({
  ONTOS_GATEWAY_MODULE_API_KEY: 'internal-module-key',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});

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
  compositionRevision: symmyWorkerCompositionRevision,
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
const input = (): SymmyEffectAdapterInput => ({
  canExecuteNewEffects: true,
  context,
  dependencies: [],
  effect,
  readOriginalActionInvocation: () =>
    Effect.sync(() => {
      peer.factReads += 1;
      return Option.fromNullishOr(peer.fact);
    }),
  recordInvocationId: () => Effect.void,
  recordOwnerReceipt: () => Effect.void,
  recordOwnerRequest: ({ authContextRef, requestHash }) =>
    Effect.sync(() => {
      peer.hashes.push({ authContextRef, hash: requestHash });
      peer.order.push('pin-request');
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
  for (const endpoint of routedOwners) {
    endpoint.reset();
  }
  peer.fact = null;
  peer.exposeCommittedAckFact = true;
  peer.factReads = 0;
  peer.hashes.length = 0;
  peer.gateway.length = 0;
  peer.order.length = 0;
  peer.unrouted.length = 0;
};
/** Runs a test against the scripted owner peers without any worker delivery claim. */
const overSymmyPeers = <Value, Failure>(program: Effect.Effect<Value, Failure, Crypto.Crypto>) =>
  program.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(peer.unrouted).toEqual([]);
      }),
    ),
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, peerConfiguration),
    Effect.provideService(FetchHttpClient.Fetch, fetchPeer),
  );
/** Runs a test as the Symmy job worker of `context`'s delivery against the scripted owner peers. */
const asSymmyWorker = <Value, Failure>(program: Effect.Effect<Value, Failure, Crypto.Crypto>) =>
  overSymmyPeers(program.pipe(withSymmyWorkerClaim(context)));

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
      peer.privacy.succeedOnce(privacyAllowed).succeedOnce(privacyDenied);
      peer.assignment.succeed(assignmentResult);
      const adapter = yield* assignmentAdapter;
      const original = { ...input(), effect: assignmentEffect, legalEntityId: '10000000-0000-4000-8000-000000000020' };
      const first = yield* adapter.execute(original);
      expect(first.status).toBe('accepted_change');
      const denied = yield* adapter.execute(original);
      expect(denied.status).toBe('denied');
      expect(peer.assignment.sent).toHaveLength(1);
      expect(peer.privacy.sent).toHaveLength(2);
      expect(peer.privacy.bodies[0]).toMatchObject({
        consumerModuleId: 'commerce.customer-context',
        operation: 'PRICE_GROUP_ASSIGN',
        source: { occurrenceId: 'occurrence-1', recordId: 'customer-1' },
        target: { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: profile.resourceId },
      });
    }).pipe(asSymmyWorker),
  );

  it.effect('leaves recovery indeterminate when receiving owner current Privacy rejects its immutable source', () =>
    Effect.gen(function* deniedRecovery() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      peer.assignmentReceipt.fail(
        CustomerPriceGroupAssignmentReceiptForbiddenProblemSchema,
        CustomerPriceGroupAssignmentReceiptForbiddenProblemSchema.make({
          detail: 'Current owner Privacy denies the original source',
          status: 403,
          title: 'Forbidden',
          type: 'about:blank',
        }),
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
      expect(peer.assignmentReceipt.sent).toHaveLength(1);
      expect(peer.privacy.sent).toHaveLength(0);
      expect(peer.assignment.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
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

const alreadyCommittedWithoutReply = () =>
  peer.create.fail(
    PartyCommandAlreadyCommittedProblemSchema,
    PartyCommandAlreadyCommittedProblemSchema.make({
      code: 'action_already_committed',
      detail: 'Internal commit without a saved reply',
      invocationId: Schema.decodeUnknownSync(PartyCommandAlreadyCommittedProblemSchema.fields.invocationId)(
        invocationId,
      ),
      resolution: 'REFRESH_GOVERNED_READS',
      retryCommand: false,
      status: 409,
      title: 'Already committed',
      type: 'https://ontos.dev/problems/internal-already-committed',
    }),
  );

describe('governed internal Party adapter', () => {
  it.effect('preserves the original Contact end no-change receipt instead of guessing from current state', () =>
    Effect.gen(function* contactNoChange() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      peer.receipt.succeed(
        Schema.decodeUnknownSync(PartySourceEffectReceiptResponseSchema)({
          actionInvocationId: invocationId,
          operation: 'END_CONTACT_POINT',
          outcome: 'COMMITTED',
          result: { changed: false, contactPointRef, partyRef: canonicalPartyRef, revision: 3 },
        }),
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
      expect(peer.receipt.bodies[0]).toMatchObject({
        operation: 'END_CONTACT_POINT',
        payload: { contactPointRef },
      });
      return yield* Effect.void;
    }).pipe(asSymmyWorker),
  );

  it.effect('does not invoke the owner if the complete request pin cannot be saved', () =>
    Effect.gen(function* cannotPin() {
      reset();
      peer.create.succeed(created);
      const adapter = yield* createAdapter;
      const result = yield* Effect.result(
        adapter.execute({ ...input(), recordOwnerRequest: () => Effect.fail(symmyJobWorkerUnavailable()) }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(peer.create.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );

  it.effect('reuses the pinned executor and exact original command key when no invocation was acknowledged', () =>
    Effect.gen(function* originalCommand() {
      reset();
      peer.receipt.succeed({ outcome: 'INDETERMINATE' });
      peer.create.succeed(created);
      const adapter = yield* createAdapter;
      const original = yield* withOriginalRequest(input());
      expect(yield* adapter.recover(original)).toEqual({ status: 'retry_original_key' });
      expect(peer.gateway).toHaveLength(0);
      const result = yield* adapter.execute(original);
      expect(result).toMatchObject({ status: 'accepted_change' });
      expect(peer.gateway).toHaveLength(1);
      expect(peer.gateway[0]?.subject).toMatchObject({
        operationRequirementKey: 'integration.symmy.requirement.worker.party.registry.create-party',
      });
      expect(peer.gateway[0]?.subject).toMatchObject({ expectedPrincipalId: '10000000-0000-4000-8000-000000000008' });
      expect(peer.create.sent[0]?.headers.get('idempotency-key')).toBe(effectId);
      expect(peer.create.sent[0]?.headers.get('authorization')).toBe('Bearer internal-attempt-1');
    }).pipe(asSymmyWorker),
  );

  it.effect('keeps revoked new-effect authority from replaying an uncertain command', () =>
    Effect.gen(function* revoked() {
      reset();
      peer.receipt.succeed({ outcome: 'INDETERMINATE' });
      const adapter = yield* createAdapter;
      const result = yield* adapter.recover({
        ...input(),
        canExecuteNewEffects: false,
        originalExecutorPrincipalId: '10000000-0000-4000-8000-000000000008',
      });
      expect(result).toEqual({ status: 'unavailable' });
      expect(peer.create.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );

  it.effect('never resends when Core identifies a different invocation than the recorded one', () =>
    Effect.gen(function* wrongInvocation() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      peer.create.succeed(created);
      const adapter = yield* createAdapter;
      const result = yield* adapter.recover(
        yield* withOriginalRequest({
          ...input(),
          originalInvocationId: '10000000-0000-4000-8000-000000000099',
        }),
      );
      expect(result).toEqual({ status: 'unavailable' });
      expect(peer.create.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );

  it.effect('uses the committed synchronous admission without manufacturing a worker delivery', () =>
    Effect.gen(function* synchronousAdmission() {
      reset();
      peer.create.succeed(created);
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
        peer.gateway.some((request) =>
          Match.value(request.subject).pipe(
            Match.tag('RegisteredAdmission', () => true),
            Match.orElse(() => false),
          ),
        ),
      ).toBe(true);
      expect(peer.gateway[0]?.subject).toMatchObject({
        actionInvocationId: invocationId,
        sourceActionKey: 'integration.symmy.admit-symmy-sync',
      });
    }).pipe(overSymmyPeers),
  );

  it.effect('pins the actual executor before the native write and uses a fresh operation-bound credential', () =>
    Effect.gen(function* execute() {
      reset();
      peer.create.answer(() => {
        peer.order.push('owner-write');
        return created;
      });
      const adapter = yield* createAdapter;
      const result = yield* adapter.execute(input());
      expect(result.status).toBe('accepted_change');
      expect(peer.order).toEqual(['pin-request', 'owner-write']);
      expect(peer.hashes[0]?.hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(peer.hashes[0]?.authContextRef).toBe(fixtureAuthContextRef);
      // Shell receives the delivery the worker holds by its verified identity, never the in-process context.
      expect(peer.gateway[0]).toMatchObject({
        audience: 'party-registry',
        compositionRevision: context.compositionRevision,
        subject: {
          _tag: 'RegisteredWorkload',
          claimId: context.claimId,
          declarationKey: 'party.registry.party.create',
          deliveryId: context.deliveryId,
          tenantId: context.tenantId,
          workerKey: context.workerKey,
        },
      });
      expect(peer.create.sent[0]?.headers.get('authorization')).toBe('Bearer internal-attempt-1');
      expect(peer.create.sent[0]?.headers.get('idempotency-key')).toBe(effectId);
    }).pipe(asSymmyWorker),
  );

  it.effect('settles a committed create-party with the reply Core saved for the pinned request', () =>
    Effect.gen(function* replaySavedReply() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      // Core answers the same key, principal and request hash with the reply it saved at commit.
      peer.create.succeed(created);
      const receipts: unknown[] = [];
      const invocations: string[] = [];
      const adapter = yield* createAdapter;
      const original = yield* withOriginalRequest(input());
      const result = yield* adapter.recover({
        ...original,
        recordInvocationId: (id) =>
          Effect.sync(() => {
            invocations.push(id);
          }),
        recordOwnerReceipt: (receipt) =>
          Effect.sync(() => {
            receipts.push(receipt);
          }),
      });
      expect(result).toMatchObject({ outcome: { status: 'accepted_change' }, status: 'settled' });
      expect(invocations).toEqual([invocationId]);
      expect(receipts).toEqual([
        Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
          _tag: 'PartyCreated',
          actionInvocationId: invocationId,
          partyRef: canonicalPartyRef,
        }),
      ]);
      // The resend is the persisted request: same key, pinned executor, same request hash, write credential.
      expect(peer.create.sent).toHaveLength(1);
      expect(peer.create.sent[0]?.headers.get('idempotency-key')).toBe(effectId);
      expect(peer.create.bodies).toEqual([
        Schema.decodeUnknownSync(CreatePartyPayloadSchema)(
          Schema.decodeUnknownSync(SymmyPartyCommerceIntentSchema)(effect.intent).payload,
        ),
      ]);
      expect(peer.hashes).toEqual([{ authContextRef: fixtureAuthContextRef, hash: original.originalRequestHash }]);
      expect(peer.gateway).toHaveLength(1);
      expect(peer.gateway[0]?.subject).toMatchObject({
        declarationKey: 'party.registry.party.create',
        expectedPrincipalId: executorPrincipalId,
        operationRequirementKey: 'integration.symmy.requirement.worker.party.registry.create-party',
      });
      // No receipt Read: the recovery needs no Privacy source processing context.
      expect(peer.receipt.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );

  it.effect('settles a committed create-party even after new-effect authority was revoked', () =>
    Effect.gen(function* replayWithoutNewAuthority() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      peer.create.succeed(created);
      const adapter = yield* createAdapter;
      const original = yield* withOriginalRequest({ ...input(), canExecuteNewEffects: false });
      expect(yield* adapter.recover(original)).toMatchObject({
        outcome: { status: 'accepted_change' },
        status: 'settled',
      });
      expect(peer.create.sent).toHaveLength(1);
      expect(peer.receipt.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );

  it.effect('settles a committed create-party without a saved reply from its Party receipt', () =>
    Effect.gen(function* replayWithoutSavedReply() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      // A commit made before Core saved replies, past the recovery window, with an unstorable reply, or whose
      // replay Core refuses answers ActionAlreadyCommitted; the receipt of the pinned invocation settles it.
      alreadyCommittedWithoutReply();
      peer.receipt.succeed(
        Schema.decodeUnknownSync(PartySourceEffectReceiptResponseSchema)({
          actionInvocationId: invocationId,
          operation: 'CREATE',
          outcome: 'COMMITTED',
          result: created,
        }),
      );
      const receipts: unknown[] = [];
      const adapter = yield* createAdapter;
      const result = yield* adapter.recover({
        ...(yield* withOriginalRequest(input())),
        recordOwnerReceipt: (receipt) =>
          Effect.sync(() => {
            receipts.push(receipt);
          }),
      });
      expect(result).toMatchObject({ outcome: { status: 'accepted_change' }, status: 'settled' });
      expect(receipts).toEqual([
        Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
          _tag: 'PartyCreated',
          actionInvocationId: invocationId,
          partyRef: canonicalPartyRef,
        }),
      ]);
      expect(peer.create.sent).toHaveLength(1);
      expect(peer.receipt.bodies).toEqual([expect.objectContaining({ operation: 'CREATE' })]);
    }).pipe(asSymmyWorker),
  );

  it.effect.each(['forbidden resend', 'no saved reply and a denied receipt Read'] as const)(
    'keeps a committed create-party uncertain, never denied or conflicting, on %s',
    (refusal) =>
      Effect.gen(function* replayRefused() {
        reset();
        peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
        if (refusal === 'forbidden resend') {
          peer.create.fail(
            PartyCommandForbiddenProblemSchema,
            PartyCommandForbiddenProblemSchema.make({
              detail: 'Internal current authority revoked',
              status: 403,
              title: 'Forbidden',
              type: 'about:blank',
            }),
          );
        } else {
          alreadyCommittedWithoutReply();
          peer.receipt.fail(
            PartySourceEffectReceiptForbiddenProblemSchema,
            PartySourceEffectReceiptForbiddenProblemSchema.make({
              detail: 'Internal current authority revoked',
              status: 403,
              title: 'Forbidden',
              type: 'about:blank',
            }),
          );
        }
        const receipts: unknown[] = [];
        const adapter = yield* createAdapter;
        const recovered = yield* adapter
          .recover({
            ...(yield* withOriginalRequest(input())),
            recordOwnerReceipt: (receipt) =>
              Effect.sync(() => {
                receipts.push(receipt);
              }),
          })
          .pipe(Effect.result);
        expect(Result.isFailure(recovered)).toBe(true);
        expect(receipts).toEqual([]);
        expect(peer.create.sent).toHaveLength(1);
        expect(peer.receipt.sent).toHaveLength(refusal === 'forbidden resend' ? 0 : 1);
      }).pipe(asSymmyWorker),
  );

  it.effect('never resends a committed create-party whose pinned request no longer matches', () =>
    Effect.gen(function* replayHashMismatch() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      peer.create.succeed(created);
      const adapter = yield* createAdapter;
      const recovered = yield* adapter
        .recover({
          ...input(),
          originalAuthContextRef: fixtureAuthContextRef,
          originalExecutorPrincipalId: executorPrincipalId,
          originalRequestHash: 'f'.repeat(64),
        })
        .pipe(Effect.result);
      expect(Result.isFailure(recovered)).toBe(true);
      expect(peer.create.sent).toHaveLength(0);
      expect(peer.hashes).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );

  it.effect('records a native indeterminate invocation before returning uncertainty', () =>
    Effect.gen(function* indeterminate() {
      reset();
      peer.create.fail(
        PartyCommandCommitIndeterminateProblemSchema,
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
    }).pipe(asSymmyWorker),
  );

  it.effect('allows a new exact attempt after interruption before any owner request was pinned', () =>
    Effect.gen(function* absent() {
      reset();
      peer.receipt.succeed({ outcome: 'INDETERMINATE' });
      const adapter = yield* createAdapter;
      const result = yield* adapter.recover(input());
      expect(result).toEqual({ status: 'not_committed' });
      expect(peer.create.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
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
      expect(peer.factReads).toBe(0);
      expect(peer.gateway).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );
});
describe('original native invocation recovery authority', () => {
  it.effect.each(['rejected', 'failed'])(
    'never invokes a write or receipt Read for a kernel invocation in %s',
    (status) =>
      Effect.gen(function* noncommittedFact() {
        reset();
        peer.fact = { actionInvocationId: invocationId, status };
        const adapter = yield* createAdapter;
        const recovered = yield* adapter.recover(yield* withOriginalRequest(input()));
        expect(recovered).toEqual({ status: 'unavailable' });
        expect(peer.create.sent).toHaveLength(0);
        expect(peer.receipt.sent).toHaveLength(0);
        expect(peer.gateway).toHaveLength(0);
      }).pipe(asSymmyWorker),
  );
  it.effect.each(['received', 'running'])(
    'lets the worker retry a kernel invocation in %s using only current exact write authority',
    (status) =>
      Effect.gen(function* openFact() {
        reset();
        peer.fact = { actionInvocationId: invocationId, status };
        const adapter = yield* createAdapter;
        const original = yield* withOriginalRequest({ ...input(), originalInvocationId: invocationId });
        expect(yield* adapter.recover(original)).toEqual({ status: 'retry_original_key' });
        expect(yield* adapter.recover({ ...original, canExecuteNewEffects: false })).toEqual({ status: 'unavailable' });
        expect(peer.create.sent).toHaveLength(0);
        expect(peer.receipt.sent).toHaveLength(0);
        expect(peer.gateway).toHaveLength(0);
        peer.create.answer(() => {
          peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
          return created;
        });
        expect(yield* adapter.execute(original)).toMatchObject({ status: 'accepted_change' });
        // Once committed, the same request under the same key is answered with Core's saved reply.
        expect(yield* adapter.recover({ ...original, canExecuteNewEffects: false })).toMatchObject({
          outcome: { status: 'accepted_change' },
          status: 'settled',
        });
        expect(peer.create.sent.map((request) => request.headers.get('idempotency-key'))).toEqual([effectId, effectId]);
        expect(new Set(peer.hashes.map(({ hash }) => hash))).toEqual(new Set([original.originalRequestHash]));
        expect(peer.receipt.sent).toHaveLength(0);
      }).pipe(asSymmyWorker),
  );
  it.effect('fails before the owner call when an original command no longer matches its persisted request hash', () =>
    Effect.gen(function* hashMismatch() {
      reset();
      peer.create.succeed(created);
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
      expect(peer.create.sent).toHaveLength(0);
      expect(peer.hashes).toHaveLength(0);
    }).pipe(asSymmyWorker),
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
      peer.retail.answer(() => {
        peer.order.push('owner-write');
        return Schema.decodeUnknownSync(EnsureRetailCustomerProfileResultSchema)({
          outcome: 'PROFILE_CREATED',
          profileRef: profile,
          revision: 1,
          state: 'ACTIVE',
        });
      });
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
            peer.order.push('resolve');
          }),
      });
      expect(result.status).toBe('accepted_change');
      expect(peer.order).toEqual(['resolve', 'pin-request', 'owner-write']);
      expect(recorded).toMatchObject([
        {
          intent: {
            _tag: 'EnsureRetailProfile',
            payload: { source: { effectId, occurrenceId: 'occurrence-1' }, subject: { partyRef: canonicalPartyRef } },
          },
        },
      ]);
      expect(peer.retail.bodies[0].subject.partyRef).toEqual(canonicalPartyRef);
    }).pipe(asSymmyWorker),
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
      expect(peer.retail.sent).toHaveLength(0);
      expect(peer.gateway).toHaveLength(0);
    }).pipe(asSymmyWorker),
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
      peer.address.succeed(
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
      );
      const adapter = yield* savedAddressAdapter;
      const result = yield* adapter.execute({
        ...input(),
        effect: savedAddressEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result.status).toBe('accepted_change');
      expect(peer.address.bodies[0]).toMatchObject({
        purposes: ['DELIVERY'],
        source: { effectId, identity: { occurrenceId: 'occurrence-1', recordId: 'customer-1' } },
      });
      expect(peer.address.bodies[0].source?.nativeAddressId).toBeUndefined();
      expect(peer.order).toEqual(['pin-request']);
    }).pipe(asSymmyWorker),
  );
  it.effect('recovers an original reused result without creating another address', () =>
    Effect.gen(function* recoveredAddress() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      const original = yield* withOriginalRequest({
        ...input(),
        effect: savedAddressEffect,
        legalEntityId: sellingLegalEntityId,
      });
      peer.addressReceipt.succeed(
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
      );
      const adapter = yield* savedAddressAdapter;
      const result = yield* adapter.recover(original);
      expect(result).toMatchObject({ outcome: { status: 'accepted_no_change' }, status: 'settled' });
      expect(peer.address.sent).toHaveLength(0);
      expect(peer.addressReceipt.bodies[0]).toMatchObject({
        actionInvocationId: invocationId,
        actionKey: 'commerce.customer-context.add-saved-address',
        requestHash: original.originalRequestHash,
        source: { identity: { recordId: 'customer-1' } },
      });
    }).pipe(asSymmyWorker),
  );
});

const commerceOnlyPostalAddress = {
  addressLine1: 'Fixture Street 1',
  city: 'Prague',
  countryCode: 'CZ',
  postalCode: '11000',
};
const profileAddressEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  dependsOn: [{ effectKey: 'ensure-profile', itemKey: 'customer-1' }],
  effectKey: 'address-add',
  intent: {
    _tag: 'AddSavedRetailAddressFromProfileEffect',
    fromProfileEffect: { effectKey: 'ensure-profile', itemKey: 'customer-1' },
    payload: {
      postalAddress: commerceOnlyPostalAddress,
      purposes: ['DELIVERY'],
      reason: 'Explicit qualified delivery address',
      source: addressSource,
    },
  },
  ref: { ...effect.ref, operation: savedAddressEffect.ref.operation },
});
const profileParent = (
  status: 'accepted_change' | 'accepted_no_change' | 'conflict',
): SymmyEffectAdapterInput['dependencies'][number] => ({
  effect: retailDependencyEffect,
  itemKey: 'customer-1',
  outcome: Option.some({ effectId: effect.ref.effectId, owner: 'commerce.customer-context', status }),
  ownerReceipt: Option.some(
    Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
      _tag: 'RetailProfileEnsured',
      partyRef: canonicalPartyRef,
      profileRef: profile,
    }),
  ),
  state: 'settled',
  version: 1,
});
describe('Commerce-only Saved Address resolved from its profile effect', () => {
  it.effect('persists the AddSavedAddress it resolved from the profile receipt before the native write', () =>
    Effect.gen(function* resolvedAddress() {
      reset();
      peer.address.succeed(
        Schema.decodeUnknownSync(AddSavedAddressResultSchema)({
          address: {
            lifecycle: 'ACTIVE',
            origin: { kind: 'COMMERCE_ONLY', postalAddress: commerceOnlyPostalAddress },
            profile: { kind: 'RETAIL', profileRef: profile },
            purposes: ['DELIVERY'],
            revision: 1,
            savedAddressRef,
          },
          outcome: 'ADDED',
        }),
      );
      const adapter = yield* savedAddressAdapter;
      const recorded: unknown[] = [];
      // An existing profile ends accepted without change: the address still goes to it, never to a second profile.
      const result = yield* adapter.execute({
        ...input(),
        dependencies: [profileParent('accepted_no_change')],
        effect: profileAddressEffect,
        legalEntityId: sellingLegalEntityId,
        recordResolvedEffect: (value) =>
          Effect.sync(() => {
            recorded.push(value);
          }),
      });
      expect(result.status).toBe('accepted_change');
      expect(recorded).toMatchObject([
        {
          intent: {
            _tag: 'AddSavedAddress',
            payload: {
              origin: { kind: 'COMMERCE_ONLY', postalAddress: commerceOnlyPostalAddress },
              profile: { kind: 'RETAIL', profileRef: { resourceId: profile.resourceId } },
              source: { effectId, identity: { occurrenceId: 'occurrence-1', recordId: 'customer-1' } },
            },
          },
        },
      ]);
      expect(peer.address.bodies[0]).toMatchObject({
        origin: { kind: 'COMMERCE_ONLY' },
        profile: { kind: 'RETAIL', profileRef: { resourceId: profile.resourceId } },
      });
    }).pipe(asSymmyWorker),
  );

  it.effect('writes nothing when the profile effect was not accepted', () =>
    Effect.gen(function* unacceptedProfile() {
      reset();
      const adapter = yield* savedAddressAdapter;
      const result = yield* adapter
        .execute({
          ...input(),
          dependencies: [profileParent('conflict')],
          effect: profileAddressEffect,
          legalEntityId: sellingLegalEntityId,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(peer.address.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );

  it.effect('finds nothing committed for an unresolved address and never recovers by itself', () =>
    Effect.gen(function* noRecovery() {
      reset();
      const adapter = yield* savedAddressAdapter;
      const result = yield* adapter.recover({
        ...input(),
        dependencies: [profileParent('accepted_change')],
        effect: profileAddressEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result).toEqual({ status: 'not_committed' });
      const revoked = yield* adapter.recover({
        ...input(),
        canExecuteNewEffects: false,
        dependencies: [profileParent('accepted_change')],
        effect: profileAddressEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(revoked).toEqual({ status: 'unavailable' });
      expect(peer.address.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );
});

it.effect('keeps a successful Contact write indeterminate when its following receipt Read is forbidden', () =>
  Effect.gen(function* acknowledgedContactReadDenied() {
    reset();
    peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
    peer.endContact.succeed(
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
    );
    peer.receipt.fail(
      PartySourceEffectReceiptForbiddenProblemSchema,
      PartySourceEffectReceiptForbiddenProblemSchema.make({
        detail: 'Current processing denied after native commit',
        status: 403,
        title: 'Forbidden',
        type: 'about:blank',
      }),
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
    expect(peer.endContact.sent).toHaveLength(1);
    expect(peer.receipt.sent).toHaveLength(1);
    return yield* Effect.void;
  }).pipe(asSymmyWorker),
);

it.effect(
  'does not acquire a credential or execute an already normalized new effect after admission authority is revoked',
  () =>
    Effect.gen(function* nativeRevoked() {
      reset();
      const adapter = yield* createAdapter;
      const result = yield* adapter.execute({ ...input(), canExecuteNewEffects: false }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(peer.gateway).toHaveLength(0);
      expect(peer.create.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
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
    peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
    const nativeIntent = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceIntentSchema)(resolvedRetailEffect.intent);
    const originalIntent = Match.value(nativeIntent).pipe(
      Match.tag('EnsureRetailProfile', (intent) => intent.payload),
      Match.orElse(() => {}),
    );
    peer.profileReceipt
      .failOnce(
        CustomerProfileSourceForbiddenProblemSchema,
        CustomerProfileSourceForbiddenProblemSchema.make({
          detail: 'Exact full profile read currently forbidden',
          status: 403,
          title: 'Forbidden',
          type: 'about:blank',
        }),
      )
      .succeedOnce(
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
      );
    const adapter = yield* retailDependencyAdapter;
    const result = yield* adapter.recover(
      yield* withOriginalRequest({ ...input(), effect: resolvedRetailEffect, legalEntityId: sellingLegalEntityId }),
    );
    expect(result).toMatchObject({ outcome: { status: 'accepted_change' }, status: 'settled' });
    expect(peer.retail.sent).toHaveLength(0);
    expect(peer.profileReceipt.bodies.map((body) => body.mode)).toEqual(['RECEIPT', 'MINIMAL_RECEIPT']);
  }).pipe(asSymmyWorker),
);
it.effect('does not treat an unavailable full profile receipt as absence or issue another write', () =>
  Effect.gen(function* unavailableProfileRecovery() {
    reset();
    peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
    peer.profileReceipt.fail(
      CustomerProfileSourceUnavailableProblemSchema,
      CustomerProfileSourceUnavailableProblemSchema.make({
        detail: 'Owner context unavailable',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'about:blank',
      }),
    );
    const adapter = yield* retailDependencyAdapter;
    const result = yield* adapter
      .recover(
        yield* withOriginalRequest({ ...input(), effect: resolvedRetailEffect, legalEntityId: sellingLegalEntityId }),
      )
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(peer.profileReceipt.sent).toHaveLength(1);
    expect(peer.retail.sent).toHaveLength(0);
  }).pipe(asSymmyWorker),
);

it.effect('settles the native group meaning-change refusal as conflict without retry or receipt lookup', () =>
  Effect.gen(function* definiteMeaningConflict() {
    reset();
    peer.updateGroup.fail(
      UpdateCustomerGroupActionIneligibleProblemSchema,
      UpdateCustomerGroupActionIneligibleProblemSchema.make({
        code: 'customer_group_definition_change_requires_new_group',
        detail: 'A changed group meaning requires a new group',
        status: 422,
        title: 'Ineligible',
        type: 'about:blank',
      }),
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
    expect(peer.updateGroup.sent).toHaveLength(1);
    expect(peer.factReads).toBe(0);
    return yield* Effect.void;
  }).pipe(asSymmyWorker),
);

it.effect('never settles a successful native ACK without the actual succeeded Core identity', () =>
  Effect.gen(function* absentNativeFact() {
    reset();
    peer.exposeCommittedAckFact = false;
    peer.create.succeed(created);
    const adapter = yield* createAdapter;
    const result = yield* adapter.execute(input()).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(peer.create.sent).toHaveLength(1);
    expect(peer.receipt.sent).toHaveLength(0);
    expect(peer.factReads).toBe(1);
  }).pipe(asSymmyWorker),
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
    peer.onboard.answer(() => {
      peer.order.push('owner-write');
      return nativeResult;
    });
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
          peer.order.push('resolve');
        }),
    });
    expect(result.status).toBe('accepted_change');
    expect(peer.order).toEqual(['resolve', 'pin-request', 'owner-write']);
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
    expect(peer.onboard.bodies[0].sourceOrganizationWitness?.semanticInputDigest).toMatch(/^[a-f0-9]{64}$/u);
    peer.receipt.succeed(
      yield* Schema.decodeUnknownEffect(PartySourceEffectReceiptResponseSchema)({
        actionInvocationId: invocationId,
        operation: 'ONBOARD_COUNTERPARTY_CUSTOMER',
        outcome: 'COMMITTED',
        result: Schema.encodeSync(CounterpartyCustomerOnboardResultSchema)(nativeResult),
      }),
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
    expect(peer.onboard.sent).toHaveLength(1);
    return yield* Effect.void;
  }).pipe(asSymmyWorker),
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
  items: [{ groupRef: selectedMembershipGroup, outcome: 'ALREADY_MANAGED' }],
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
        peer.groupDefinition.succeed(membershipCurrentGroup);
        peer.membership.succeed(membershipResult);
        const adapter = yield* membershipAdapter;
        const result = yield* adapter.execute({
          ...input(),
          effect: membershipEffect,
          legalEntityId: sellingLegalEntityId,
          routeKey: 'customerGroupCustomersBatch',
          selector: membershipSelector,
        });
        expect(result.status).toBe('accepted_no_change');
        expect(peer.groupDefinition.sent).toHaveLength(1);
        expect(peer.groupDefinition.bodies[0]).toEqual({
          issuer: 'group-definition-issuer',
          mappingRevision: 'mapping-1',
          mode: 'CURRENT',
          namespace: 'group-definitions',
          recordId: 'group-record-1',
          route: { id: routeId, revision: 'route-1' },
        });
        expect(peer.gateway[0]?.subject).toMatchObject({
          operationRequirementKey:
            'integration.symmy.requirement.worker.commerce.customer-context.api.customer-group-definition-source',
        });
        expect(peer.membership.sent).toHaveLength(1);
      }).pipe(asSymmyWorker),
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
        peer.groupDefinition.succeed(Schema.decodeUnknownSync(CustomerGroupDefinitionSourceResponseSchema)(response));
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
        expect(peer.membership.sent).toHaveLength(0);
        expect(peer.hashes).toHaveLength(0);
      }
      reset();
      peer.groupDefinition.fail(
        CustomerGroupDefinitionSourceUnavailableProblemSchema,
        CustomerGroupDefinitionSourceUnavailableProblemSchema.make({
          detail: 'Current source unavailable',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'about:blank',
        }),
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
      expect(peer.membership.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );
  it.effect('uses the exact accepted Membership receipt without retargeting through the current Group selector', () =>
    Effect.gen(function* originalReceiptOnly() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      peer.membershipReceipt.succeed(membershipResult);
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
      expect(peer.membershipReceipt.sent).toHaveLength(1);
      expect(peer.groupDefinition.sent).toHaveLength(0);
      expect(peer.membership.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );
  it.effect('settles nothing from a receipt of another group, order or source record', () =>
    Effect.gen(function* foreignReceipt() {
      const otherGroup = { ...selectedMembershipGroup, resourceId: '10000000-0000-4000-8000-000000000092' };
      for (const receipt of [
        { ...membershipResult, items: [{ groupRef: otherGroup, outcome: 'ALREADY_MANAGED' as const }] },
        { ...membershipResult, items: [] },
        { ...membershipResult, source: { ...membershipResult.source, order: membershipPayload.source.order + 1 } },
        { ...membershipResult, source: { ...membershipResult.source, sourceRecordId: 'another-membership-record' } },
      ]) {
        reset();
        peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
        peer.membershipReceipt.succeed(
          Schema.decodeUnknownSync(ApplyCustomerGroupMembershipSourceResultSchema)(receipt),
        );
        const adapter = yield* membershipAdapter;
        const recovered = yield* adapter.recover(
          yield* withOriginalRequest({
            ...input(),
            effect: membershipEffect,
            legalEntityId: sellingLegalEntityId,
            routeKey: 'customerGroupCustomersBatch',
          }),
        );
        expect(recovered.status).toBe('unavailable');
        expect(peer.membership.sent).toHaveLength(0);
      }
    }).pipe(asSymmyWorker),
  );
  it.effect('reads no receipt for a pinned command whose request hash is not the original one', () =>
    Effect.gen(function* foreignIntentHash() {
      reset();
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      peer.membershipReceipt.succeed(membershipResult);
      const adapter = yield* membershipAdapter;
      const original = yield* withOriginalRequest({
        ...input(),
        effect: membershipEffect,
        legalEntityId: sellingLegalEntityId,
        routeKey: 'customerGroupCustomersBatch',
      });
      const recovered = yield* adapter.recover({ ...original, originalRequestHash: 'a'.repeat(64) });
      expect(recovered.status).toBe('unavailable');
      expect(peer.membershipReceipt.sent).toHaveLength(0);
      expect(peer.membership.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
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
      expect(peer.membership.sent).toHaveLength(0);
      expect(peer.groupDefinition.sent).toHaveLength(0);
      expect(peer.gateway).toHaveLength(0);
      reset();
      peer.membership.succeed(membershipResult);
      const generic = yield* adapter.execute({
        ...input(),
        effect: complete,
        legalEntityId: sellingLegalEntityId,
        routeKey: 'customersBatch',
      });
      expect(generic.status).toBe('accepted_no_change');
      expect(peer.membership.sent).toHaveLength(1);
      expect(peer.groupDefinition.sent).toHaveLength(0);
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
      expect(peer.membership.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
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
        expect(peer.membership.sent).toHaveLength(0);
        expect(peer.groupDefinition.sent).toHaveLength(0);
        expect(peer.gateway).toHaveLength(0);
      }
    }).pipe(asSymmyWorker),
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
        peer.profileReceipt.succeed(organizationIcoCurrentProfile);
        peer.organizationIco.succeed(organizationIcoNative);
        const adapter = yield* organizationIcoAdapter;
        const result = yield* adapter.execute({
          ...input(),
          effect: organizationIcoEffect,
          legalEntityId: sellingLegalEntityId,
        });
        expect(result.status).toBe('accepted_change');
        expect(peer.organizationIco.sent).toHaveLength(1);
        expect(peer.profileReceipt.bodies[0]).toEqual({
          issuer: 'internal-symmy',
          mappingRevision: 'mapping-1',
          mode: 'CURRENT',
          namespace: 'customers',
          recordId: 'customer-1',
          recordType: 'CUSTOMER',
          route: { id: routeId, revision: 'route-1' },
        });
        expect(peer.privacy.sent).toHaveLength(0);
        expect(peer.hashes).toHaveLength(1);
        expect(peer.gateway[0]?.subject).toMatchObject({
          operationRequirementKey:
            'integration.symmy.requirement.worker.commerce.customer-context.api.customer-profile-source',
        });
        expect(peer.gateway[1]?.subject).toMatchObject({
          operationRequirementKey:
            'integration.symmy.requirement.worker.commerce.customer-context.change-organization-customer-profile-ico',
        });
      }).pipe(asSymmyWorker),
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
        peer.profileReceipt.succeed(Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)(response));
        const adapter = yield* organizationIcoAdapter;
        const result = yield* adapter
          .execute({ ...input(), effect: organizationIcoEffect, legalEntityId: sellingLegalEntityId })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(peer.organizationIco.sent).toHaveLength(0);
        expect(peer.privacy.sent).toHaveLength(0);
        expect(peer.hashes).toHaveLength(0);
      }
    }).pipe(asSymmyWorker),
  );
  it.effect(
    'recovers only the exact original native company ICO receipt without rechecking source targeting or rewriting',
    () =>
      Effect.gen(function* organizationExactReceipt() {
        reset();
        peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
        peer.organizationIcoRead.succeed(
          Schema.decodeUnknownSync(OrganizationCustomerProfileIcoResponseSchema)({
            _tag: 'RECEIPT',
            assertion: organizationIcoNative.assertion,
          }),
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
        expect(peer.organizationIcoRead.bodies[0]).toEqual({
          actionInvocationId: invocationId,
          profileRef: organizationIcoProfile,
        });
        expect(peer.profileReceipt.sent).toHaveLength(0);
        expect(peer.organizationIco.sent).toHaveLength(0);
        expect(peer.privacy.sent).toHaveLength(0);
      }).pipe(asSymmyWorker),
  );
});

const organizationCounterpartyProfileOperation = {
  entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
} as const;
const profileIcoEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...organizationIcoEffect,
  dependsOn: ['counterparty-profile'],
  effectKey: 'ico-set',
  intent: {
    _tag: 'OrganizationCustomerProfileIcoFromProfileEffect',
    fromProfileEffect: { effectKey: 'counterparty-profile', itemKey: 'customer-1' },
    payload: {
      countryCode: 'CZ',
      effectiveAt: '2026-11-07T00:00:00.000Z',
      expectedRevision: 0,
      identifier: { identifierType: 'ICO', value: '27074358' },
      operation: 'SET',
      originalInput: '27074358',
    },
    sourceReference: {
      occurrenceId: 'occurrence-1',
      recordId: 'customer-1',
      source: { issuer: 'internal-symmy', namespace: 'customers', recordType: 'CUSTOMER', routeRef: routeId },
    },
  },
  ref: Struct.omit(organizationIcoEffect.ref, ['originalTarget']),
});
const counterpartyProfileParent = (
  status: 'accepted_change' | 'accepted_no_change' | 'conflict',
): SymmyEffectAdapterInput['dependencies'][number] => ({
  effect: Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
    ...retailDependencyEffect,
    effectKey: 'counterparty-profile',
    ref: { ...retailDependencyEffect.ref, operation: organizationCounterpartyProfileOperation },
  }),
  itemKey: 'customer-1',
  outcome: Option.some({ effectId: effect.ref.effectId, owner: 'commerce.customer-context', status }),
  ownerReceipt: Option.some(
    Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
      _tag: 'CounterpartyProfileCreated',
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: '10000000-0000-4000-8000-000000000072',
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      profileRef: organizationIcoProfile,
    }),
  ),
  state: 'settled',
  version: 1,
});
describe('company ICO resolved from the profile effect of the same job', () => {
  it.effect('records the explicit ICO change on the profile the parent returned, then writes it', () =>
    Effect.gen(function* resolvedProfileIco() {
      reset();
      peer.profileReceipt.succeed(organizationIcoCurrentProfile);
      peer.organizationIco.succeed(organizationIcoNative);
      const adapter = yield* organizationIcoAdapter;
      const recorded: unknown[] = [];
      // An existing profile ends accepted without change: the ICO still goes to it, never to a second profile.
      const result = yield* adapter.execute({
        ...input(),
        dependencies: [counterpartyProfileParent('accepted_no_change')],
        effect: profileIcoEffect,
        legalEntityId: sellingLegalEntityId,
        recordResolvedEffect: (value) =>
          Effect.sync(() => {
            recorded.push(value);
          }),
      });
      expect(result.status).toBe('accepted_change');
      expect(recorded).toMatchObject([
        {
          intent: {
            _tag: 'OrganizationCustomerProfileIco',
            payload: { effectId, operation: 'SET', profileRef: { resourceId: organizationIcoProfile.resourceId } },
            sourceReference: { occurrenceId: 'occurrence-1', recordId: 'customer-1' },
          },
          ref: { originalTarget: { resourceId: organizationIcoProfile.resourceId, tenantId } },
        },
      ]);
      expect(JSON.stringify(recorded)).not.toContain('fromProfileEffect');
      expect(peer.organizationIco.sent).toHaveLength(1);
      expect(peer.organizationIco.bodies[0]).toMatchObject({
        effectId,
        expectedRevision: 0,
        identifier: { identifierType: 'ICO', value: '27074358' },
        profileRef: { resourceId: organizationIcoProfile.resourceId },
      });
      expect(peer.profileReceipt.sent).toHaveLength(1);
    }).pipe(asSymmyWorker),
  );

  it.effect('writes nothing when the profile effect was not accepted', () =>
    Effect.gen(function* unacceptedProfile() {
      reset();
      const adapter = yield* organizationIcoAdapter;
      const result = yield* adapter
        .execute({
          ...input(),
          dependencies: [counterpartyProfileParent('conflict')],
          effect: profileIcoEffect,
          legalEntityId: sellingLegalEntityId,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(peer.organizationIco.sent).toHaveLength(0);
      expect(peer.profileReceipt.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );

  it.effect('names no profile of a Retail effect and never writes through the unresolved intent', () =>
    Effect.gen(function* wrongParent() {
      reset();
      const adapter = yield* organizationIcoAdapter;
      const result = yield* adapter
        .execute({
          ...input(),
          dependencies: [{ ...profileParent('accepted_change'), itemKey: 'customer-1' }],
          effect: profileIcoEffect,
          legalEntityId: sellingLegalEntityId,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(peer.organizationIco.sent).toHaveLength(0);
      const unresolved = yield* adapter
        .recover({ ...input(), dependencies: [counterpartyProfileParent('accepted_change')], effect: profileIcoEffect })
        .pipe(Effect.result);
      expect(Result.isFailure(unresolved) || unresolved.success.status !== 'settled').toBe(true);
      expect(peer.organizationIco.sent).toHaveLength(0);
    }).pipe(asSymmyWorker),
  );
});

it.effect('keeps explicit company Privacy denial terminal and does not switch to a personal action or migration', () =>
  Effect.gen(function* companyPrivacyDenied() {
    reset();
    peer.profileReceipt.succeed(organizationIcoCurrentProfile);
    peer.organizationIco.fail(
      ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema,
      ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema.make({
        code: 'PRIVACY_DENIED',
        detail: 'Current company policy denies the native fields',
        status: 422,
        title: 'Ineligible',
        type: 'about:blank',
      }),
    );
    const adapter = yield* organizationIcoAdapter;
    const result = yield* adapter.execute({
      ...input(),
      effect: organizationIcoEffect,
      legalEntityId: sellingLegalEntityId,
    });
    expect(result.status).toBe('denied');
    expect(peer.organizationIco.sent).toHaveLength(1);
    expect(peer.organizationIcoRead.sent).toHaveLength(0);
    expect(peer.privacy.sent).toHaveLength(0);
    expect(peer.create.sent).toHaveLength(0);
    expect(peer.factReads).toBe(0);
  }).pipe(asSymmyWorker),
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
      peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
      peer.organizationIcoRead.succeed(
        Schema.decodeUnknownSync(OrganizationCustomerProfileIcoResponseSchema)({ _tag: 'RECEIPT', assertion }),
      );
      const result = yield* adapter.recover(
        yield* withOriginalRequest({ ...input(), effect: organizationIcoEffect, legalEntityId: sellingLegalEntityId }),
      );
      expect(result.status).toBe('unavailable');
      expect(peer.organizationIco.sent).toHaveLength(0);
      expect(peer.profileReceipt.sent).toHaveLength(0);
    }
    reset();
    peer.fact = { actionInvocationId: invocationId, status: 'succeeded' };
    peer.organizationIcoRead.fail(
      OrganizationCustomerProfileIcoForbiddenProblemSchema,
      OrganizationCustomerProfileIcoForbiddenProblemSchema.make({
        detail: 'Current original-receipt policy denies disclosure',
        status: 403,
        title: 'Forbidden',
        type: 'about:blank',
      }),
    );
    const result = yield* adapter
      .recover(
        yield* withOriginalRequest({ ...input(), effect: organizationIcoEffect, legalEntityId: sellingLegalEntityId }),
      )
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(peer.organizationIco.sent).toHaveLength(0);
    expect(peer.profileReceipt.sent).toHaveLength(0);
    expect(peer.privacy.sent).toHaveLength(0);
  }).pipe(asSymmyWorker),
);

it.effect(
  'reports the explicit organization migration fence prerequisite without automatic cutover or a personal fallback',
  () =>
    Effect.gen(function* companyFenceRequired() {
      reset();
      peer.profileReceipt.succeed(organizationIcoCurrentProfile);
      peer.organizationIco.fail(
        ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema,
        ChangeOrganizationCustomerProfileIcoActionIneligibleProblemSchema.make({
          code: 'MIGRATION_REQUIRED',
          detail: 'Native owner requires the explicit operator fence',
          status: 422,
          title: 'Ineligible',
          type: 'about:blank',
        }),
      );
      const adapter = yield* organizationIcoAdapter;
      const result = yield* adapter.execute({
        ...input(),
        effect: organizationIcoEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result).toEqual({ owner: 'commerce.customer-context', reason: 'missing_context', status: 'unsupported' });
      expect(peer.organizationIco.sent).toHaveLength(1);
      expect(peer.organizationIcoRead.sent).toHaveLength(0);
      expect(peer.privacy.sent).toHaveLength(0);
      expect(peer.create.sent).toHaveLength(0);
      expect(peer.factReads).toBe(0);
    }).pipe(asSymmyWorker),
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
      peer.counterpartyAssignment.succeed(organizationAssignmentResult);
      const adapter = yield* counterpartyAssignmentAdapter;
      const result = yield* adapter.execute({
        ...input(),
        effect: organizationAssignmentEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result.status).toBe('accepted_change');
      expect(peer.counterpartyAssignment.sent).toHaveLength(1);
      expect(peer.privacy.sent).toHaveLength(0);
      expect(peer.gateway).toHaveLength(1);
      expect(peer.gateway[0]?.audience).toBe('commerce-customer-context');
      expect(peer.gateway[0]?.subject).toMatchObject({
        declarationKey: 'commerce.customer-context.counterparty-price-group.assign',
      });
    }).pipe(asSymmyWorker),
  );
  it.effect('preserves the personal Counterparty policy check and stops its denied command', () =>
    Effect.gen(function* personalCounterpartyDenied() {
      reset();
      peer.privacy.succeed(privacyDenied);
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
      expect(peer.privacy.sent).toHaveLength(1);
      expect(peer.counterpartyAssignment.sent).toHaveLength(0);
      expect(peer.hashes).toHaveLength(0);
    }).pipe(asSymmyWorker),
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
        expect(peer.gateway).toHaveLength(0);
        expect(peer.privacy.sent).toHaveLength(0);
        expect(peer.counterpartyAssignment.sent).toHaveLength(0);
      }
    }).pipe(asSymmyWorker),
  );
  it.effect('retains native company refusal without retrying through personal processing', () =>
    Effect.gen(function* noDenialFallback() {
      reset();
      peer.counterpartyAssignment.fail(
        AssignCounterpartyPriceGroupActionForbiddenProblemSchema,
        AssignCounterpartyPriceGroupActionForbiddenProblemSchema.make({
          code: 'customer_price_group_source_privacy_denied',
          detail: 'Current company processing is denied',
          status: 403,
          title: 'Forbidden',
          type: 'about:blank',
        }),
      );
      const adapter = yield* counterpartyAssignmentAdapter;
      const result = yield* adapter.execute({
        ...input(),
        effect: organizationAssignmentEffect,
        legalEntityId: sellingLegalEntityId,
      });
      expect(result.status).toBe('denied');
      expect(peer.counterpartyAssignment.sent).toHaveLength(1);
      expect(peer.privacy.sent).toHaveLength(0);
      expect(peer.gateway).toHaveLength(1);
      expect(peer.factReads).toBe(0);
    }).pipe(asSymmyWorker),
  );
});
