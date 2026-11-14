import {
  ActionTransactionError,
  defineDatabaseIdentityEnrollment,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { AccessPortalProjection } from '@app/core-runtime/access/portal';
import { ReadPrincipalBindingResultSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import { Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { NodeCrypto } from '@effect/platform-node';
import { getActionHandler } from '@app/core-runtime/testing/actions';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { bindRetailPortalProfileAction } from '../../src/actions/bind-retail-portal-profile.action.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { ProfileReactivationEligibilityEvaluatorFactory } from '../../src/integrations/profile-reactivation-eligibility.ts';
import { PartyRegistryGuestResolverFactory } from '../../src/integrations/party-registry-guest-resolver.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';

import { installOperationalScopeAt } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { makeCommerceTenantWorkloadCredentials } from '../../api/tenant-workload-credentials.ts';
import {
  BindRetailPortalProfilePayloadSchema,
  RetailPortalBindingActionRejected,
} from '../../shared/actions/bind-retail-portal-profile.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { RetailEnrollmentRegistrationSchema } from '../../shared/enrollment-contracts.ts';
import { prepareRetailEnrollmentTargetBinding } from '../../src/integrations/retail-enrollment-binding.ts';
import { retailEnrollmentTargetIdentityLive } from '../../src/integrations/retail-enrollment-binding-live.ts';
import {
  retailPartyRefFor,
  retailSelfEnrollmentRequestDigest,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import { RETAIN_RETAIL_RESULTS_TRANSITION } from '../../src/enrollment/journeys/retail-enrollment-restart.ts';

const uid = (value: number) => `77000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantId = uid(1);
const legalEntityId = uid(2);
const requesterId = uid(3);
const customerId = uid(4);
const requesterBindingId = uid(5);
const targetBindingId = uid(6);
const attemptId = uid(7);
const profileId = uid(8);
const partyId = uid(9);
const invocationId = uid(10);
const originatorId = uid(11);
const providerInvocationId = uid(12);
const sourceAttemptId = uid(13);
const revision = 'a'.repeat(64);
const at = '2026-11-07T10:00:00.000Z';
const providerSubjectId = 'exact-provider-subject';
const unused = () => Effect.die('Unexpected mutation or retired authorization path');
const payload = Schema.decodeUnknownSync(BindRetailPortalProfilePayloadSchema)({
  effectiveAt: at,
  enrollmentEvidenceRef: attemptId,
  expectedRevision: null,
  expectedState: null,
  principalRef: {
    moduleId: 'core.identity',
    resourceId: customerId,
    resourceType: 'core.identity.principal',
    tenantId,
  },
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
  reason: 'Verified native enrollment',
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
});
const makeScope = (actorAppId = 'commerce-customer-context'): OperationalScope =>
  trustVerifiedGatewayPrincipalContext(
    {
      authBindingId: requesterBindingId,
      authContextRef: 'api-key:original-storefront',
      authMethod: 'api_key',
      correlationId: 'native-binding-proof',
      legalEntityId,
      principalId: requesterId,
      tenantId,
    },
    revision,
    undefined,
    { appId: actorAppId, buildMarker: 'current-ccc-build', principalId: uid(14) },
  );

const modes = [
  'valid',
  'wrong-attempt',
  'wrong-tenant',
  'wrong-company',
  'wrong-actor',
  'wrong-provider',
  'wrong-profile',
  'wrong-principal',
  'revoked',
  'disabled',
  'unverified',
  'closed-journal',
  'expired',
  'unbound-actor',
  'standalone-api-key',
  'missing-originator',
  'stale-profile',
  'stale-journal',
  'stale-binding',
  'missing-retention',
  'wrong-source',
  'missing-predecessor',
  'failed-provider',
  // An enrollment the Storefront client never started: a definite refusal, never an unavailable owner.
  'missing-attempt',
] as const;
type Mode = (typeof modes)[number];

const nativeAttemptRow = (mode: Mode, restart: boolean, changed: boolean) => ({
  attempt_outcome: 'FOUND',
  authentication_namespace_id: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  completed_at: null,
  composition_revision: revision,
  created_at: at,
  created_by_principal_id: mode === 'wrong-actor' ? uid(99) : requesterId,
  failure_code: null,
  failure_reason: null,
  intent_digest: 'b'.repeat(64),
  intent_key: restart ? `commerce.retail-restart:${sourceAttemptId}:7` : 'native-binding-test',
  invitation_id: null,
  journey: restart ? 'EXISTING_ACCOUNT' : 'RETAIL_SELF_ENROLLMENT',
  last_failure_code: null,
  last_failure_reason: null,
  last_owner_invocation_id: null,
  lease_expires_at: mode === 'expired' ? '2026-11-07T09:59:59.000Z' : null,
  lease_owner: mode === 'expired' ? 'native-worker' : null,
  lease_token: mode === 'expired' ? uid(15) : null,
  operation_actor_principal_id: null,
  operation_id: null,
  operation_lease_expires_at: null,
  operation_lease_owner: null,
  operation_lease_token: null,
  operation_revision: null,
  operation_status: null,
  outcome_code: null,
  owner_invocation_id: null,
  owner_module_key: null,
  portal_enrollment_attempt_id: mode === 'wrong-attempt' ? uid(99) : attemptId,
  provider_subject_id: mode === 'wrong-provider' ? 'unrelated-provider-subject' : providerSubjectId,
  reconciliation_ref: null,
  request_digest: null,
  required: null,
  result_digest: null,
  result_reference: null,
  revision: changed && mode === 'stale-journal' ? 11 : 10,
  state: mode === 'closed-journal' ? 'COMPLETE' : 'IN_PROGRESS',
  subject_type: 'user',
  target_legal_entity_id: mode === 'wrong-company' ? uid(99) : legalEntityId,
  target_resource_id: restart ? sourceAttemptId : null,
  tenant_id: mode === 'wrong-tenant' ? uid(99) : tenantId,
  terminated_at: null,
  transition_key: null,
  updated_at: at,
});

const journalRows = (mode: Mode, restart: boolean, changed: boolean) => {
  const base = nativeAttemptRow(mode, restart, changed);
  const operation = (id: number, owner: string, key: string, result: string | null, digest = 'c'.repeat(64)) => ({
    ...base,
    operation_actor_principal_id: requesterId,
    operation_id: uid(id),
    operation_revision: 1,
    operation_status: result === null ? 'IN_PROGRESS' : 'SUCCEEDED',
    owner_invocation_id: id === 20 ? providerInvocationId : uid(id),
    owner_module_key: owner,
    request_digest: digest,
    required: true,
    result_reference: result,
    transition_key: key,
  });
  const bindingDigest = retailSelfEnrollmentRequestDigest({
    intent: {
      partyRef: retailPartyRefFor(tenantId, partyId),
      principalRef: payload.principalRef,
      sellingLegalEntityRef: payload.sellingLegalEntityRef,
      step: 'RETAIL_PORTAL_BINDING',
    },
    ownerModuleKey: 'commerce.customer-context',
    portalEnrollmentAttemptId: attemptId,
    transitionKey: 'commerce.customer-context.bind-retail-portal-profile',
  });
  const rows = [
    operation(
      23,
      'commerce.customer-context',
      'commerce.customer-context.bind-retail-portal-profile',
      null,
      bindingDigest,
    ),
  ];
  if (restart) {
    if (mode !== 'missing-retention') {
      rows.push(
        operation(
          24,
          'commerce.customer-context',
          RETAIN_RETAIL_RESULTS_TRANSITION,
          mode === 'wrong-source' ? uid(99) : sourceAttemptId,
        ),
      );
    }
  } else {
    rows.push(
      operation(20, 'commerce.portal-auth', 'provider.account.create', providerSubjectId),
      operation(21, 'party.registry', 'party.candidate.submit', partyId),
      operation(
        22,
        'commerce.customer-context',
        'commerce.customer-context.ensure-retail-customer-profile',
        mode === 'wrong-profile' ? uid(99) : profileId,
      ),
    );
  }
  if (mode === 'failed-provider') {
    return rows.map((row) =>
      row.owner_module_key === 'commerce.portal-auth' ? { ...row, operation_status: 'FAILED' } : row,
    );
  }
  return rows;
};

const registration = Schema.decodeUnknownSync(RetailEnrollmentRegistrationSchema)({
  displayName: 'Ada Customer',
  email: 'ada@example.test',
});

const nativeTargetIdentityRows = (mode: Mode, changed: boolean) => [
  {
    authBindingId: targetBindingId,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    bindingRevision: changed && mode === 'stale-binding' ? 3 : 2,
    bindingStatus: changed && mode === 'revoked' ? 'revoked' : 'active',
    createdByInvocationId: uid(25),
    lastTransitionRef: uid(26),
    principalId: customerId,
    principalKind: 'human',
    principalStatus: changed && mode === 'disabled' ? 'disabled' : 'active',
    provider: 'better-auth',
    providerSubjectId,
    revokedAt: changed && mode === 'revoked' ? new Date(at) : null,
    subjectType: 'user',
    tenantId,
    tenantStatus: 'active',
  },
];

const nativeRestartRows = (mode: Mode) =>
  ['missing-predecessor', 'failed-provider'].includes(mode)
    ? []
    : [
        {
          context: {
            directoryOwnerInvocationIds: [],
            partyId,
            profileId: mode === 'wrong-profile' ? uid(99) : profileId,
            providerOwnerInvocationId: providerInvocationId,
            registration,
            retainedMask: 7,
            sourceAttemptId,
          },
        },
      ];

const unusedBindingDependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.succeed(AccessPortalProjection, {
    project: () => Effect.die('A direct binding handler must not execute post-attempt projection'),
  }),
  Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, { make: () => unused }),
  Layer.succeed(ProfileReactivationEligibilityEvaluatorFactory, { make: () => unused, observe: unused }),
  Layer.succeed(PartyRegistryGuestResolverFactory, { make: () => unused }),
  Layer.succeed(PartyRegistryRetailPartyResolverFactory, { make: () => unused }),
);

const fixture = Effect.fn('RetailEnrollmentBinding.fixture')(function* fixture(mode: Mode = 'valid', restart = false) {
  yield* TestClock.setTime(Date.parse(at));
  let scope: OperationalScope;
  if (mode === 'standalone-api-key') {
    scope = trustVerifiedGatewayPrincipalContext(
      {
        authBindingId: requesterBindingId,
        authContextRef: 'api-key:standalone',
        authMethod: 'api_key',
        correlationId: 'standalone',
        legalEntityId,
        principalId: requesterId,
        tenantId,
      },
      revision,
    );
  } else {
    scope = mode === 'unbound-actor' ? makeScope('pricing') : makeScope();
  }
  let changed = false;
  let insideSql = false;
  let identityReads = 0;
  let identityLocks = 0;
  const statements: string[] = [];
  const database = yield* makeTestDatabase((statement) => {
    statements.push(statement);
    if (statement === 'COMMIT' || statement === 'ROLLBACK') {
      insideSql = false;
    }
    if (statement.includes('current_user')) {
      return Effect.succeed([
        { legal_entity_id: legalEntityId, operation_at: new Date(at), role: 'ontos_runtime', tenant_id: tenantId },
      ]);
    }
    if (statement.includes('"read_portal_enrollment_originator"')) {
      return Effect.succeed([{ originator_action_invocation_id: mode === 'missing-originator' ? null : originatorId }]);
    }
    if (statement.includes('"read_portal_enrollment_attempt"')) {
      return Effect.succeed(mode === 'missing-attempt' ? [] : journalRows(mode, restart, changed));
    }
    if (statement.includes('"read_retail_enrollment_restart_context"')) {
      return Effect.succeed(nativeRestartRows(mode));
    }
    if (statement.includes('"read_retail_profile_by_party"')) {
      return Effect.succeed([
        {
          outcome: 'PROFILE_AVAILABLE',
          payload: {
            outcome: 'PROFILE_ALREADY_EXISTS_ACTIVE',
            profileRef: payload.profileRef,
            revision: changed && mode === 'stale-profile' ? 2 : 1,
            state: 'ACTIVE',
          },
        },
      ]);
    }
    // The runtime identity reads owner tables only through their owned routines, never by direct SELECT.
    if (statement.includes('"read_customer_profile"')) {
      return Effect.succeed([
        {
          outcome: 'PROFILE_AVAILABLE',
          payload: {
            createdAt: '2026-01-01T00:00:00.000Z',
            profileId,
            profileKind: 'RETAIL',
            revision: changed && mode === 'stale-profile' ? 2 : 1,
            scopeLegalEntityId: legalEntityId,
            state: 'ACTIVE',
            subject: { attributionKind: 'NONE', kind: 'RETAIL', partyResourceId: partyId, partyResourceRevision: null },
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ]);
    }
    if (statement.includes('from "commerce_customer_context"."')) {
      return Effect.die(`Owner tables are not readable directly by the runtime identity: ${statement}`);
    }
    if (statement.includes('from "core"."principal_auth_bindings"')) {
      identityLocks += 1;
      return Effect.succeed(nativeTargetIdentityRows(mode, changed));
    }
    return Effect.succeed([]);
  });
  const identityLayer = retailEnrollmentTargetIdentityLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ExternalIdentityClient, {
          activatePrincipalBinding: unused,
          changePrincipalBindingStatus: unused,
          issueExternalGatewayContext: unused,
          readPrincipalBinding: (request, options) => {
            expect(insideSql).toBe(false);
            expect(request).toEqual({
              authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
              lookup: 'subject',
              providerSubjectId,
              subjectType: 'user',
            });
            expect(options?.requestCorrelation).toBe(scope.correlationId);
            identityReads += 1;
            return Schema.decodeUnknownEffect(Schema.toType(ReadPrincipalBindingResultSchema))({
              authBindingId: targetBindingId,
              authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
              bindingRevision: 2,
              bindingStatus: 'active',
              originalInvocationId: Option.some(uid(25)),
              outcome: 'FOUND',
              principalId: mode === 'wrong-principal' ? uid(99) : customerId,
              principalStatus: 'active',
              tenantStatus: 'active',
            }).pipe(Effect.orDie);
          },
          reservePrincipalBinding: unused,
          resolveExternalSubject: unused,
        }),
        Layer.succeed(CommerceCoreIdentityClientConfig, {
          baseUrl: 'https://identity.example.test',
          credentials: makeCommerceTenantWorkloadCredentials({
            [tenantId]: {
              coreIdentityApiKey: Redacted.make('test-current-identity-read'),
              gatewayApiKey: Redacted.make('unused-action-credential'),
            },
          }),
        }),
        Layer.succeed(CommercePortalAuthAccountLookupService, {
          existsByEmail: unused,
          existsByProviderSubject: unused,
          subjectForOwnerInvocation: unused,
          verifiedEmailForOwnerInvocation: (request) => {
            expect(insideSql).toBe(false);
            expect(request).toEqual({
              ownerInvocationId: providerInvocationId,
              providerSubjectId: mode === 'wrong-provider' ? 'unrelated-provider-subject' : providerSubjectId,
            });
            return Effect.succeed(mode !== 'unverified' && mode !== 'wrong-provider');
          },
        }),
      ),
    ),
  );
  const context = yield* Layer.build(identityLayer);
  const run: ActionServicePreparationContext['transaction'] = (operation) =>
    database
      .transaction((transaction) =>
        Effect.gen(function* actualScopedOwnerTransaction() {
          insideSql = true;
          const { scoped } = yield* installOperationalScopeAt(transaction, scope, defineDatabaseIdentityEnrollment([]));
          return yield* operation(scoped);
        }),
      )
      .pipe(
        Effect.catchTag('SqlError', () =>
          Effect.fail(
            new ActionTransactionError({ code: 'action_transaction_failed', reason: 'Scripted owner SQL failed' }),
          ),
        ),
      );
  const preparation: ActionServicePreparationContext = {
    actionInvocationId: invocationId,
    compositionRevision: revision,
    scope,
    transaction: run,
  };
  return {
    change: () => {
      changed = true;
    },
    context,
    identityLocks: () => identityLocks,
    identityReads: () => identityReads,
    preparation,
    run,
    scope,
    statements,
  };
});

for (const restart of [false, true]) {
  for (const mode of modes.filter(
    (value) => restart || !['missing-retention', 'wrong-source', 'missing-predecessor'].includes(value),
  )) {
    it.effect(`requires current delegated native target evidence (${restart ? 'restart' : 'new'}): ${mode}`, () =>
      Effect.gen(function* canonicalBindingProof() {
        const test = yield* fixture(mode, restart);
        const prepared = yield* prepareRetailEnrollmentTargetBinding(payload, test.preparation).pipe(
          Effect.provideContext(test.context),
          Effect.result,
        );
        if (Result.isFailure(prepared)) {
          expect(mode).not.toBe('valid');
          expect(Schema.is(RetailPortalBindingActionRejected)(prepared.failure)).toBe(true);
          expect(prepared.failure).toMatchObject({ code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT', retryable: false });
          return;
        }
        test.change();
        const target = yield* test
          .run((transaction) => prepared.success(transaction, test.scope, revision, payload, invocationId))
          .pipe(Effect.result);
        expect(Result.isSuccess(target)).toBe(mode === 'valid');
        if (Result.isFailure(target)) {
          expect(target.failure).toMatchObject({ code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT', retryable: false });
        }
        if (Result.isSuccess(target)) {
          expect(target.success).toEqual({ authBindingId: targetBindingId, principalId: customerId });
          expect(test.scope.authBindingId).toBe(requesterBindingId);
          expect(test.identityReads()).toBe(1);
          expect(test.identityLocks()).toBe(1);
        }
      }).pipe(Effect.scoped),
    );
  }
}

it.effect('consumes prepared target once and refuses another actual Action or copied requester', () =>
  Effect.gen(function* exactInvocationBinding() {
    const test = yield* fixture();
    const prepared = yield* prepareRetailEnrollmentTargetBinding(payload, test.preparation).pipe(
      Effect.provideContext(test.context),
    );
    const foreignInvocation = yield* test
      .run((transaction) => prepared(transaction, test.scope, revision, payload, uid(99)))
      .pipe(Effect.result);
    expect(Result.isFailure(foreignInvocation)).toBe(true);
    const foreignRequester = yield* test
      .run((transaction) => prepared(transaction, { ...test.scope }, revision, payload, invocationId))
      .pipe(Effect.result);
    expect(Result.isFailure(foreignRequester)).toBe(true);
    const accepted = yield* test.run((transaction) =>
      prepared(transaction, test.scope, revision, payload, invocationId),
    );
    expect(accepted.authBindingId).toBe(targetBindingId);
    const replay = yield* test
      .run((transaction) => prepared(transaction, test.scope, revision, payload, invocationId))
      .pipe(Effect.result);
    expect(Result.isFailure(replay)).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect('the actual binding registration rechecks target identity before the native mutation and portal grant', () =>
  Effect.gen(function* registeredBindingTargetRecheck() {
    const test = yield* fixture('revoked');
    const prepare = getActionServicePreflight(bindRetailPortalProfileAction);
    if (prepare === undefined) {
      return yield* Effect.die('The published binding Action lost its owner preparation');
    }
    const factory = yield* prepare(payload, {
      ...test.preparation,
      evaluatePolicy: () => Effect.die('The binding Action declares no unrelated Policy'),
    }).pipe(Effect.provideContext(test.context));
    test.change();
    const result = yield* test
      .run((transaction) =>
        factory(transaction, test.scope, revision).pipe(
          Effect.flatMap((services) => {
            const collector = createActionCollector(
              bindRetailPortalProfileAction.descriptor.domainEvents,
              'commerce.customer-context',
              bindRetailPortalProfileAction.descriptor.accessEvidencePolicy,
            );
            return getActionHandler(bindRetailPortalProfileAction)(payload, {
              actionInvocationId: invocationId,
              addDomainEvent: collector.addDomainEvent,
              addOutboxMessage: collector.addOutboxMessage,
              compositionRevision: revision,
              recordAuditEvidence: collector.recordAuditEvidence,
              recordDataAccess: collector.recordDataAccess,
              scope: test.scope,
              services,
            });
          }),
        ),
      )
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT', retryable: false });
    }
    expect(test.identityLocks()).toBe(1);
    expect(test.statements.some((statement) => statement.includes('mutate_retail_portal_binding'))).toBe(false);
    expect(test.statements.some((statement) => statement.startsWith('insert'))).toBe(false);
    return yield* Effect.void;
  }).pipe(Effect.provide(unusedBindingDependencies), Effect.scoped),
);
