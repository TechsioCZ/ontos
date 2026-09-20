import { randomUUID } from 'node:crypto';

import { ActionAuthorizationPreflightDatabaseLive, CorePersistenceLive, DatabaseConfigLive } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { acquirePoolResource } from '../../../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { ExternalIdentityClient } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import type { ExternalIdentityClientPort } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import {
  CommerceEnrollmentOwnerEffectRegistry,
  CommerceEnrollmentOwnerEffectRegistryLive,
} from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import type { CommerceEnrollmentOwnerEffectContext } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../../src/enrollment/orchestration/owner-transaction-runner.ts';
import { CommerceEnrollmentOwnerEffectRejected } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerReconciliationInput } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentKeySchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';

/**
 * Reconciling the two Commerce-owned Retail self-enrollment transitions after their Action response
 * was lost.
 *
 * The governed Action runtime resolves commit state but republishes no Action result, so the owner
 * verdict — which profile, which binding — has to come from Commerce's own durable rows. Every
 * scenario below writes those rows through the very SECURITY DEFINER routines the Actions run, then
 * reconciles through the deployed registry with no second dispatch available: the Action clients in
 * these entries would have to reach a Commerce BFF that is not running here, so any answer other
 * than an owner read would fail rather than resolve.
 */

const REQUEST_DIGEST = 'a'.repeat(64);
const RESULT_DIGEST = 'b'.repeat(64);
const CANDIDATE_DIGEST = 'c'.repeat(64);
const INTENT_DIGEST = 'd'.repeat(64);
const at = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z');

const ensureTransition: JourneyTransitionSpec = {
  ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  required: true,
  transitionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
};
const bindTransition: JourneyTransitionSpec = {
  ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  required: true,
  transitionKey: BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
};

const unreachable = (operationName: string) => () => Effect.die(`${operationName} is not part of this scenario`);

/** Neither Commerce-owned transition reconciles through Core; reaching it here is the bug. */
const coreClient: ExternalIdentityClientPort = {
  activatePrincipalBinding: unreachable('activatePrincipalBinding'),
  changePrincipalBindingStatus: unreachable('changePrincipalBindingStatus'),
  issueExternalGatewayContext: unreachable('issueExternalGatewayContext'),
  readPrincipalBinding: unreachable('readPrincipalBinding'),
  reservePrincipalBinding: unreachable('reservePrincipalBinding'),
  resolveExternalSubject: unreachable('resolveExternalSubject'),
};

/**
 * The deployed registry over the production owner transaction runner — the same wiring
 * `api/index.ts` composes. Without the runner the registry falls back to the fail-closed answer, so
 * this layer is what the scenarios below are actually asserting about.
 */
const registryLive = CommerceEnrollmentOwnerEffectRegistryLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(ExternalIdentityClient, coreClient),
      Layer.succeed(CommerceCoreIdentityClientConfig, {
        apiKey: Redacted.make('enrollment-profile-reconciliation'),
        baseUrl: 'https://core-identity.invalid',
      }),
      Layer.succeed(CommercePortalAuthAccountLookupService, {
        existsByEmail: unreachable('existsByEmail'),
        existsByProviderSubject: unreachable('existsByProviderSubject'),
        subjectForOwnerInvocation: unreachable('subjectForOwnerInvocation'),
      }),
      CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
        Layer.provide(
          ActionAuthorizationPreflightDatabaseLive.pipe(
            Layer.provideMerge(CorePersistenceLive),
            Layer.provide(DatabaseConfigLive),
          ),
        ),
      ),
    ),
  ),
);

interface Scenario {
  readonly actorPrincipalId: string;
  readonly attemptId: string;
  readonly bindInvocationId: string;
  readonly ensureInvocationId: string;
  readonly legalEntityId: string;
  readonly partyResourceId: string;
  readonly tenantId: string;
}

const scenario = (): Scenario => ({
  actorPrincipalId: randomUUID(),
  attemptId: randomUUID(),
  bindInvocationId: randomUUID(),
  ensureInvocationId: randomUUID(),
  legalEntityId: randomUUID(),
  partyResourceId: `retail-reconciliation-party-${randomUUID()}`,
  tenantId: randomUUID(),
});

const operation = (
  identities: Scenario,
  overrides: Pick<
    EnrollmentOwnerOperationSnapshot,
    'ownerInvocationId' | 'portalEnrollmentOwnerOperationId' | 'status' | 'transitionKey'
  > &
    Partial<EnrollmentOwnerOperationSnapshot>,
): EnrollmentOwnerOperationSnapshot => ({
  actorPrincipalId: Schema.decodeSync(EnrollmentPrincipalIdSchema)(identities.actorPrincipalId),
  createdAt: at,
  ownerModuleKey: Schema.decodeSync(EnrollmentModuleKeySchema)(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY),
  portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(identities.attemptId),
  requestDigest: REQUEST_DIGEST,
  required: true,
  revision: 1,
  tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(identities.tenantId),
  updatedAt: at,
  ...overrides,
});

const attemptFor = (identities: Scenario): EnrollmentAttemptSnapshot => ({
  createdAt: at,
  createdByPrincipalId: Schema.decodeSync(EnrollmentPrincipalIdSchema)(identities.actorPrincipalId),
  intentDigest: INTENT_DIGEST,
  intentKey: Schema.decodeSync(EnrollmentKeySchema)(
    'commerce.customer-context.portal-enrollment.retail_self_enrollment.reconciliation',
  ),
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(identities.attemptId),
  revision: 5,
  state: 'RECONCILIATION_REQUIRED',
  targetLegalEntityId: Schema.decodeSync(EnrollmentLegalEntityIdSchema)(identities.legalEntityId),
  tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(identities.tenantId),
  updatedAt: at,
});

/** The durable journey subject, exactly as the preparation resolver rebuilds it from the Attempt. */
const contextFor = (
  identities: Scenario,
  operations: readonly EnrollmentOwnerOperationSnapshot[],
): CommerceEnrollmentOwnerEffectContext => ({
  attempt: attemptFor(identities),
  operations,
  requestCorrelation: `enrollment-profile-reconciliation-${identities.attemptId}`,
  subject: {
    partyCandidateDigest: CANDIDATE_DIGEST,
    partyRef: Option.some({
      moduleId: 'party.registry',
      resourceId: identities.partyResourceId,
      resourceType: 'party.registry.party',
      tenantId: identities.tenantId,
    }),
    portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(identities.attemptId),
    principalRef: {
      moduleId: 'core.identity',
      resourceId: identities.actorPrincipalId,
      resourceType: 'core.identity.principal',
      tenantId: identities.tenantId,
    },
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: identities.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: identities.tenantId,
    },
  },
});

const reconciliationFor = (identities: Scenario, transition: JourneyTransitionSpec, ownerInvocationId: string) => ({
  ...Schema.decodeUnknownSync(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: identities.actorPrincipalId,
    correlationId: `enrollment-profile-reconciliation-${identities.attemptId}`,
    expectedRevision: 5,
    ownerInvocationId,
    ownerModuleKey: transition.ownerModuleKey,
    portalEnrollmentAttemptId: identities.attemptId,
    requestDigest: REQUEST_DIGEST,
    tenantId: identities.tenantId,
    transitionKey: transition.transitionKey,
  }),
  observedRevision: 5,
  ownerOperationRevision: 1,
});

/** The ensure transition's durable journal entry once its Action response was lost. */
const indeterminateEnsure = (identities: Scenario): EnrollmentOwnerOperationSnapshot =>
  operation(identities, {
    ownerInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(identities.ensureInvocationId),
    portalEnrollmentOwnerOperationId: Schema.decodeSync(EnrollmentOwnerOperationIdSchema)(randomUUID()),
    status: 'INDETERMINATE',
    transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY),
  });

const succeededEnsure = (identities: Scenario, profileId: string): EnrollmentOwnerOperationSnapshot =>
  operation(identities, {
    outcomeCode: Schema.decodeSync(EnrollmentKeySchema)('retail_customer_profile_ensured'),
    ownerInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(identities.ensureInvocationId),
    portalEnrollmentOwnerOperationId: Schema.decodeSync(EnrollmentOwnerOperationIdSchema)(randomUUID()),
    resultDigest: RESULT_DIGEST,
    resultReference: Schema.decodeSync(EnrollmentResourceIdSchema)(profileId),
    status: 'SUCCEEDED',
    transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY),
  });

const indeterminateBind = (identities: Scenario): EnrollmentOwnerOperationSnapshot =>
  operation(identities, {
    ownerInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(identities.bindInvocationId),
    portalEnrollmentOwnerOperationId: Schema.decodeSync(EnrollmentOwnerOperationIdSchema)(randomUUID()),
    status: 'INDETERMINATE',
    transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY),
  });

const reconcileThrough = (
  transition: JourneyTransitionSpec,
  context: CommerceEnrollmentOwnerEffectContext,
  reconciliation: CommerceEnrollmentOwnerReconciliationInput,
) =>
  CommerceEnrollmentOwnerEffectRegistry.pipe(
    Effect.flatMap((registry) => registry.resolve(transition, context)),
    Effect.flatMap((resolved) =>
      Option.isNone(resolved)
        ? Effect.die('The registry declares no owner effect for this Commerce-owned transition')
        : resolved.value.reconcile(reconciliation),
    ),
    Effect.provide(registryLive),
  );

interface RoutineRow extends Record<string, unknown> {
  readonly outcome: string;
  readonly payload: { readonly profileRef?: { readonly resourceId: string } } | null;
}

type OwnerDatabase = TestDatabaseFromPool<typeof commerceCustomerContextRelations>;

/** The runtime role, the only role a governed Action ever reaches an owner routine through. */
const ownerDatabase = Effect.gen(function* acquireOwnerDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const runtimePool = yield* acquirePoolResource(
    () => new Pool({ connectionString: connections.runtime.connectionString, max: 2 }),
  );
  return yield* makeTestDatabaseFromPool(runtimePool, commerceCustomerContextRelations);
});

const scopedRoutineCall = (
  transaction: Parameters<Parameters<OwnerDatabase['transaction']>[0]>[0],
  identities: Scenario,
  statement: ReturnType<typeof sql>,
) =>
  transaction
    .execute(
      sql`select set_config('ontos.tenant_id', ${identities.tenantId}, true), set_config('ontos.legal_entity_id', ${identities.legalEntityId}, true)`,
      'objects',
    )
    .pipe(Effect.flatMap(() => transaction.execute<RoutineRow>(statement, 'objects')));

const firstRoutineRow = (rows: readonly RoutineRow[]) =>
  rows[0] === undefined ? Effect.die('The owner routine returned no row') : Effect.succeed(rows[0]);

/**
 * One owner routine call under the same transaction-local scope the governed Action installs — the
 * Action's own write path, with only the HTTP in front of it removed.
 */
const runOwnerRoutine = (
  runtime: OwnerDatabase,
  identities: Scenario,
  statement: ReturnType<typeof sql>,
): Effect.Effect<RoutineRow> =>
  runtime
    .transaction((transaction) => scopedRoutineCall(transaction, identities, statement))
    .pipe(Effect.flatMap(firstRoutineRow), Effect.orDie);

const ensureProfileStatement = (identities: Scenario) =>
  sql`select * from commerce_customer_context.ensure_retail_profile(
        ${identities.tenantId}::uuid, ${identities.legalEntityId}::uuid, ${identities.partyResourceId}::text,
        null::text, 'AUTHENTICATED'::text, ${'2026-01-01T00:00:00.000Z'}::timestamptz,
        'AUTHORIZED_ONBOARDING'::text, ${randomUUID()}::uuid, ${identities.actorPrincipalId}::uuid)`;

const bindProfileStatement = (identities: Scenario, profileId: string) =>
  sql`select * from commerce_customer_context.mutate_retail_portal_binding(
        ${identities.tenantId}::uuid, ${identities.legalEntityId}::uuid, ${profileId}::uuid,
        ${identities.actorPrincipalId}::uuid, ${randomUUID()}::uuid, ${identities.attemptId}::text,
        null::text, null::integer, 'BIND'::text, ${'2026-01-01T00:00:00.000Z'}::timestamptz,
        'Retail self-enrollment established the portal profile binding'::text,
        ${randomUUID()}::uuid, ${identities.actorPrincipalId}::uuid)`;

const profileIdOf = (row: RoutineRow): string => {
  const resourceId = row.payload?.profileRef?.resourceId;
  if (resourceId === undefined) {
    throw new Error(`The ensure routine returned no profile reference (${row.outcome})`);
  }
  return resourceId;
};

it.live('reconciles a committed Retail Customer Profile ensure whose response was lost', () =>
  Effect.scoped(
    Effect.gen(function* lostEnsureResponse() {
      const runtime = yield* ownerDatabase;
      const identities = scenario();
      const ensured = yield* runOwnerRoutine(runtime, identities, ensureProfileStatement(identities));
      expect(ensured.outcome).toBe('PROFILE_CREATED');
      const profileId = profileIdOf(ensured);

      const resolution = yield* reconcileThrough(
        ensureTransition,
        contextFor(identities, [indeterminateEnsure(identities)]),
        reconciliationFor(identities, ensureTransition, identities.ensureInvocationId),
      );

      // Answering from the Action runtime alone reports every lost ensure response as
      // `commit_resolution_unavailable`, so this reconciliation fails and the Attempt stays in
      // RECONCILIATION_REQUIRED with portal access already half granted. This assertion is what the
      // owner read by (Tenant, Legal Entity, Party) buys.
      expect(resolution.status).toBe('SUCCEEDED');
      expect(String(resolution.outcomeCode)).toBe('retail_customer_profile_ensured');
      expect(String(resolution.resultReference)).toBe(profileId);
    }),
  ),
);

it.live('leaves a Retail Customer Profile ensure that never committed open for a retry', () =>
  Effect.scoped(
    Effect.gen(function* ensureNeverCommitted() {
      const identities = scenario();

      // No owner write at all: the ensure Action and the owner routine commit in the same
      // transaction, so a Party with no profile is a transition that never committed.
      const failure = yield* Effect.flip(
        reconcileThrough(
          ensureTransition,
          contextFor(identities, [indeterminateEnsure(identities)]),
          reconciliationFor(identities, ensureTransition, identities.ensureInvocationId),
        ),
      );

      // A rejection is the owner saying "dispatch this again"; `commit_resolution_unavailable` would
      // be the owner saying "I cannot tell", which is what leaves the Attempt stuck forever.
      const rejection = Schema.is(CommerceEnrollmentOwnerEffectRejected)(failure) ? failure.code : 'not-a-rejection';
      expect(rejection).toBe('commerce_profile_commit_open');
    }),
  ),
);

it.live('reconciles a committed Retail Portal Profile Binding whose response was lost', () =>
  Effect.scoped(
    Effect.gen(function* lostBindResponse() {
      const runtime = yield* ownerDatabase;
      const identities = scenario();
      const ensured = yield* runOwnerRoutine(runtime, identities, ensureProfileStatement(identities));
      const profileId = profileIdOf(ensured);
      const bound = yield* runOwnerRoutine(runtime, identities, bindProfileStatement(identities, profileId));
      expect(bound.outcome).toBe('BINDING_ACTIVATED');

      const resolution = yield* reconcileThrough(
        bindTransition,
        contextFor(identities, [succeededEnsure(identities, profileId), indeterminateBind(identities)]),
        reconciliationFor(identities, bindTransition, identities.bindInvocationId),
      );

      // The binding half is the one that may already have granted portal access, so leaving it
      // unresolved is the worst of the two. Without the owner read it is always unresolved.
      expect(resolution.status).toBe('SUCCEEDED');
      expect(String(resolution.outcomeCode)).toBe('retail_portal_profile_bound');
      expect(String(resolution.resultReference).length).toBeGreaterThan(0);
    }),
  ),
);

it.live('leaves a Retail Portal Profile Binding that never committed open for a retry', () =>
  Effect.scoped(
    Effect.gen(function* bindNeverCommitted() {
      const runtime = yield* ownerDatabase;
      const identities = scenario();
      const ensured = yield* runOwnerRoutine(runtime, identities, ensureProfileStatement(identities));
      const profileId = profileIdOf(ensured);

      const failure = yield* Effect.flip(
        reconcileThrough(
          bindTransition,
          contextFor(identities, [succeededEnsure(identities, profileId), indeterminateBind(identities)]),
          reconciliationFor(identities, bindTransition, identities.bindInvocationId),
        ),
      );

      // A rejection is the owner saying "dispatch this again"; `commit_resolution_unavailable` would
      // be the owner saying "I cannot tell", which is what leaves the Attempt stuck forever.
      const rejection = Schema.is(CommerceEnrollmentOwnerEffectRejected)(failure) ? failure.code : 'not-a-rejection';
      expect(rejection).toBe('commerce_profile_commit_open');
    }),
  ),
);
