import { randomUUID } from 'node:crypto';

import { ActionAuthorizationPreflightDatabaseLive, CorePersistenceLive, DatabaseConfigLive } from '@app/core-runtime';
import { ResendEmailDeliveryConfig } from '@app/email-delivery/resend';
import { eq, sql } from 'drizzle-orm';
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '../../../../packages/core-runtime/src/auth/gateway-assertion-redemption.ts';
import {
  commercePortalAuthRealmLive,
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { CommercePortalAuthEnrollmentStartInputSchema } from '../../api/portal-auth/enrollment/contracts.ts';
import {
  commercePortalAuthEnrollmentAccountCreationOutcome,
  commercePortalAuthEnrollmentAccountOwner,
  commercePortalAuthEnrollmentAccountVerificationOutcome,
  commercePortalAuthEnrollmentOwesTransitionOutcome,
} from '../../api/portal-auth/enrollment/http.ts';
import {
  commercePortalAuthEnrollmentAccountCreationClaim,
  commercePortalAuthEnrollmentAccountVerificationClaim,
  commercePortalAuthEnrollmentIntent,
} from '../../api/portal-auth/enrollment/intent.ts';
import type { CommercePortalAuthEnrollmentTransitionClaim } from '../../api/portal-auth/enrollment/intent.ts';
import { commercePortalAuthEnrollmentSessionSubject } from '../../api/portal-auth/enrollment/session-subject.ts';
import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { CommercePortalAuthService } from '../../api/portal-auth/session/http.ts';
import { CommercePortalAuthSessionLifecycle } from '../../api/portal-auth/session/lifecycle-service.ts';
import { PORTAL_ACCOUNT_VERIFICATION_TRANSITION_KEY } from '../../src/enrollment/journeys/existing-account.ts';
import { CommercePortalAuthAccountCreationRejected } from '../../api/portal-auth/provider/account-creation-rejected.ts';
import { CommercePortalAuthAccountCreationService } from '../../api/portal-auth/provider/account-create.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../../api/portal-auth/provider/account-creation-unavailable.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { CommerceCoreIdentityClientLive } from '../../api/portal-auth/provider/core-identity-client.ts';
import {
  claimedOrIndeterminate,
  commerceEnrollmentAttemptPersistenceForTransaction,
} from '../../src/enrollment/attempts/attempt-persistence.ts';
import {
  CommerceEnrollmentAttemptConflict,
  CommerceEnrollmentAttemptNotFound,
} from '../../src/enrollment/attempts/errors.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import {
  CommerceEnrollmentContinuation,
  CommerceEnrollmentContinuationLive,
} from '../../src/enrollment/continuation/enrollment-continuation.ts';
import { CommerceEnrollmentOwnerEffectRegistryLive } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../../src/enrollment/orchestration/owner-transaction-runner.ts';
import { commerceEnrollmentOwnerTransitionPreparationLive } from '../../src/enrollment/orchestration/owner-transition-composition.ts';
import { CommerceEnrollmentPreparationSubjectResolverLive } from '../../src/enrollment/orchestration/preparation-subject.ts';
import {
  CommerceEnrollmentOwnerTransitionPreparation,
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
  RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import type { CommerceEnrollmentPreparedOwnerBinding } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  CommercePortalAuthDatabaseLive,
  makeCommercePortalAuthDatabase,
} from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { user, verification } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import {
  makeEnrollmentAcceptanceFixture,
  readEnrollmentAcceptanceAttempt,
  readEnrollmentAcceptanceOperations,
  startEnrollmentAcceptanceAttempt,
} from '../support/enrollment-acceptance-fixture.ts';
import type { EnrollmentAcceptanceFixture } from '../support/enrollment-acceptance-fixture.ts';
import {
  issueAcceptanceGatewayAssertion,
  makeAcceptanceGatewayIssuer,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import type { AcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';

/**
 * The enrollment start path through the deployed composition, on real PostgreSQL.
 *
 * Until this wave the composition root mounted a fail-closed account-creation leaf, so the two
 * halves of the start path — the durable Attempt that authorizes one exact provider invocation, and
 * the Better Auth sign-up that invocation permits — had never been composed together in a
 * deployment. These scenarios assemble the installed realm exactly as `api/index.ts` does and pin
 * both halves: the capability is the real two-party one, and the route that dispatches through it
 * is reachable only under ordinary governance.
 */

const ORIGIN = 'http://localhost:3020';
const SECRET = 'd'.repeat(64);

const providerDatabaseUrl = Config.redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.redacted('DATABASE_URL')),
);

const emailDeliveryConfiguration = Layer.succeed(ResendEmailDeliveryConfig, {
  apiKey: Redacted.make('re_commerce_enrollment_journeys_http'),
  endpoint: 'https://api.resend.com/emails',
  from: 'no-reply@commerce.example.test',
});

/** The realm a host that opted in gets, assembled from the same layer the composition root uses. */
const configuredRealmLive = Effect.fnUntraced(function* configuredRealmLive() {
  const databaseUrl = yield* providerDatabaseUrl;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  return commercePortalAuthRealmLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.succeed(CommercePortalAuthConfig, configuration), emailDeliveryConfiguration),
    ),
  );
});

const configuredRuntime = Effect.acquireRelease(
  Effect.gen(function* buildConfiguredRuntime() {
    const realmLive = yield* configuredRealmLive();
    return makeCommerceCustomerContextApiRuntime(
      productionReadRuntimeLive,
      productionActionRuntimeLive,
      GatewayAssertionRedemptionLive,
      realmLive,
      Layer.empty,
    ).createHandler();
  }),
  (runtime) => Effect.promise(async () => await runtime.dispose()),
);

/** The provider account directory, read directly so a created row cannot hide behind the port. */
const portalAccountsFor = Effect.fnUntraced(function* portalAccountsFor(email: string) {
  const databaseUrl = yield* providerDatabaseUrl;
  const database = yield* makeCommercePortalAuthDatabase({ connectionString: databaseUrl }).pipe(Effect.orDie);
  return yield* database.executor.select({ id: user.id }).from(user).where(eq(user.email, email)).pipe(Effect.orDie);
});

/**
 * The enrollment owner preparation authority, assembled from the very layers `api/index.ts`
 * composes for a deployment that opted into both halves of the realm. The Core identity transport
 * is configured but deliberately unreachable: these scenarios pin *which* port answers a Retail
 * transition, and every answer below is decided before any Core call is made.
 */
const preparationAuthorityLive = Effect.fnUntraced(function* preparationAuthorityLive() {
  const databaseUrl = yield* providerDatabaseUrl;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const transactionRunnerLive = CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
    Layer.provide(
      ActionAuthorizationPreflightDatabaseLive.pipe(
        Layer.provideMerge(CorePersistenceLive),
        Layer.provide(DatabaseConfigLive),
      ),
    ),
  );
  const coreIdentityLive = CommerceCoreIdentityClientLive.pipe(
    Layer.provide(
      Layer.succeed(CommerceCoreIdentityClientConfig, {
        apiKey: Redacted.make('enrollment-journeys-http-core-identity'),
        baseUrl: 'https://core-identity.invalid',
      }),
    ),
  );
  const accountLookupLive = CommercePortalAuthAccountLookupLive.pipe(
    Layer.provide(
      CommercePortalAuthDatabaseLive.pipe(Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration))),
    ),
  );
  const subjectResolverLive = CommerceEnrollmentPreparationSubjectResolverLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        transactionRunnerLive,
        coreIdentityLive,
        Layer.succeed(CommerceCoreIdentityClientConfig, {
          apiKey: Redacted.make('enrollment-journeys-http-core-identity'),
          baseUrl: 'https://core-identity.invalid',
        }),
      ),
    ),
  );
  return commerceEnrollmentOwnerTransitionPreparationLive.pipe(
    Layer.provide(Layer.mergeAll(transactionRunnerLive, accountLookupLive, subjectResolverLive)),
  );
});

/** A binding for a transition of an Attempt that was never created in this Tenant. */
const bindingFor = (ownerModuleKey: string, transitionKey: string): CommerceEnrollmentPreparedOwnerBinding => ({
  actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
  actionKey: RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
  actorPrincipalId: Schema.decodeSync(EnrollmentPrincipalIdSchema)(randomUUID()),
  expectedRevision: 1,
  ownerInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
  ownerModuleKey: Schema.decodeSync(EnrollmentModuleKeySchema)(ownerModuleKey),
  portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(randomUUID()),
  tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(randomUUID()),
  transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(transitionKey),
});

const isRejected = Schema.is(CommercePortalAuthAccountCreationRejected);
const isUnavailable = Schema.is(CommercePortalAuthAccountCreationUnavailable);

it.live('installs the two-party account-creation capability, not a fail-closed leaf', () =>
  Effect.scoped(
    Effect.gen(function* installedAccountCreation() {
      const realmLive = yield* configuredRealmLive();
      const scope = yield* Effect.scope;
      const realm = yield* Layer.buildWithScope(realmLive, scope);
      const accountCreation = Context.get(realm, CommercePortalAuthAccountCreationService);
      const email = `enrollment-http-${randomUUID()}@example.test`;

      // An Attempt that was never created cannot have claimed this invocation, so the owner half
      // refuses before the provider half is reached.
      const failure = yield* Effect.flip(
        accountCreation.createAccount({
          email,
          enrollmentAttemptId: randomUUID(),
          name: 'Enrollment HTTP acceptance',
          ownerInvocationId: randomUUID(),
          password: Redacted.make('P'.repeat(24)),
          tenantId: randomUUID(),
        }),
      );

      // The fail-closed leaf answers `unavailable` because nothing is installed; the installed
      // capability answers `rejected` because the durable Attempt refused this exact invocation.
      // Reverting the composition to the leaf flips this assertion.
      expect(isUnavailable(failure)).toBe(false);
      expect(isRejected(failure)).toBe(true);

      // The provider effect is reachable only through an authorized claim: no account exists.
      expect(yield* portalAccountsFor(email)).toStrictEqual([]);
    }),
  ),
);

it.live('installs an owner preparation port for every declared Retail self-enrollment transition', () =>
  Effect.scoped(
    Effect.gen(function* installedRetailPreparation() {
      const scope = yield* Effect.scope;
      const authority = Context.get(
        yield* Layer.buildWithScope(yield* preparationAuthorityLive(), scope),
        CommerceEnrollmentOwnerTransitionPreparation,
      );

      // Every Retail transition is prepared against the durable Attempt the binding names. That
      // Attempt does not exist, so the owner-authoritative read refuses it definitively. The
      // fail-closed leaf this composition used to mount answers `unavailable` for all four, so
      // reverting the wiring in `api/index.ts` flips every assertion below.
      const outcomes = yield* Effect.forEach(
        [
          bindingFor(PORTAL_AUTH_OWNER_MODULE_KEY, PORTAL_ACCOUNT_CREATION_TRANSITION_KEY),
          bindingFor(PARTY_REGISTRY_OWNER_MODULE_KEY, PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY),
          bindingFor(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY, ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY),
          bindingFor(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY, BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY),
        ],
        (binding) => authority.prepare(binding),
        { concurrency: 1 },
      );

      expect(outcomes.map((outcome) => outcome.outcome)).toStrictEqual(['denied', 'denied', 'denied', 'denied']);
    }),
  ),
);

it.live('still fails closed for an owner transition no installed port declares', () =>
  Effect.scoped(
    Effect.gen(function* undeclaredTransitionFailsClosed() {
      const scope = yield* Effect.scope;
      const authority = Context.get(
        yield* Layer.buildWithScope(yield* preparationAuthorityLive(), scope),
        CommerceEnrollmentOwnerTransitionPreparation,
      );

      // Installing the Retail ports must not turn the router into a wildcard: a module or
      // transition nothing owns is still unavailable, never silently prepared.
      const outcome = yield* authority.prepare(bindingFor('some.other.module', 'some.other.transition'));

      expect(outcome.outcome).toBe('unavailable');
    }),
  ),
);

/**
 * The enrollment continuation, assembled from the very layers `api/index.ts` composes for a
 * deployment that opted into both halves of the realm. The Core identity transport is configured
 * but deliberately unreachable here; the assertion below is decided before any Core call is made.
 */
const continuationLive = Effect.fnUntraced(function* continuationLive() {
  const databaseUrl = yield* providerDatabaseUrl;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const coreIdentityConfigurationLive = Layer.succeed(CommerceCoreIdentityClientConfig, {
    apiKey: Redacted.make('enrollment-journeys-http-core-identity'),
    baseUrl: 'https://core-identity.invalid',
  });
  const transactionRunnerLive = CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
    Layer.provide(
      ActionAuthorizationPreflightDatabaseLive.pipe(
        Layer.provideMerge(CorePersistenceLive),
        Layer.provide(DatabaseConfigLive),
      ),
    ),
  );
  const coreIdentityLive = CommerceCoreIdentityClientLive.pipe(Layer.provide(coreIdentityConfigurationLive));
  const accountLookupLive = CommercePortalAuthAccountLookupLive.pipe(
    Layer.provide(
      CommercePortalAuthDatabaseLive.pipe(Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration))),
    ),
  );
  const registryLive = CommerceEnrollmentOwnerEffectRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(accountLookupLive, coreIdentityLive, coreIdentityConfigurationLive)),
  );
  const subjectResolverLive = CommerceEnrollmentPreparationSubjectResolverLive.pipe(
    Layer.provide(Layer.mergeAll(transactionRunnerLive, coreIdentityLive, coreIdentityConfigurationLive)),
  );
  return CommerceEnrollmentContinuationLive.pipe(
    Layer.provide(Layer.mergeAll(transactionRunnerLive, registryLive, subjectResolverLive)),
  );
});

it.live('installs the enrollment continuation, not the fail-closed leaf', () =>
  Effect.scoped(
    Effect.gen(function* installedContinuation() {
      const scope = yield* Effect.scope;
      const continuation = Context.get(
        yield* Layer.buildWithScope(yield* continuationLive(), scope),
        CommerceEnrollmentContinuation,
      );

      // The Attempt does not exist, so the installed continuation refuses it from the durable read.
      // The fail-closed leaf refuses every Attempt with `attempt_invalid` before reading anything,
      // so reverting the wiring in `api/index.ts` flips this assertion.
      const failure = yield* Effect.flip(
        continuation.advance({
          portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(randomUUID()),
          tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(randomUUID()),
        }),
      );

      expect(Schema.is(CommerceEnrollmentAttemptNotFound)(failure)).toBe(true);
    }),
  ),
);

/** One start request from a trusted origin, presenting no gateway assertion. */
const startEnrollmentRequest = (body: Record<string, string>): Request =>
  new Request(`${ORIGIN}/api/portal-auth/enrollment/start`, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'x-correlation-id': `enrollment-http-${randomUUID()}`,
    },
    method: 'POST',
  });

it.live('refuses the Counterparty invitation journey before an Attempt or an account exists', () =>
  Effect.scoped(
    Effect.gen(function* invitationJourneyRefused() {
      const runtime = yield* configuredRuntime;
      const email = `enrollment-http-${randomUUID()}@example.test`;

      const response = yield* Effect.promise(
        async () =>
          await runtime.handler(
            startEnrollmentRequest({
              displayName: 'Enrollment HTTP acceptance',
              email,
              invitationId: randomUUID(),
              journey: 'COUNTERPARTY_INVITATION',
              password: 'P'.repeat(24),
              sellingLegalEntityId: randomUUID(),
            }),
          ),
      );

      // The journey is refused for what it is, before the governed Action that would answer 401 for
      // this unauthenticated caller is ever reached: no owner effect can hold the invitation's
      // one-time claim proof, so an Attempt started here could only orphan the account it created.
      // Restoring the start path for this journey answers 401 and fails this assertion.
      expect(response.status).toBe(422);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(yield* Effect.promise(async () => await response.clone().json())).toMatchObject({
        code: 'enrollment_journey_unavailable',
        status: 422,
      });
      expect(yield* portalAccountsFor(email)).toStrictEqual([]);
    }),
  ),
);

it.live('refuses a Retail self-enrollment that names an invitation at the transport boundary', () =>
  Effect.scoped(
    Effect.gen(function* retailNamingAnInvitationRefused() {
      const runtime = yield* configuredRuntime;
      const email = `enrollment-http-${randomUUID()}@example.test`;

      const response = yield* Effect.promise(
        async () =>
          await runtime.handler(
            startEnrollmentRequest({
              displayName: 'Enrollment HTTP acceptance',
              email,
              invitationId: randomUUID(),
              journey: 'RETAIL_SELF_ENROLLMENT',
              password: 'P'.repeat(24),
              sellingLegalEntityId: randomUUID(),
            }),
          ),
      );

      // The journey and its invitation are not independent, and the payload schema says so: the
      // combination is refused at decode. A start payload that accepts an optional invitation for
      // every journey reaches the governed Action instead and answers 401 here.
      expect(response.status).toBe(400);
      expect(yield* portalAccountsFor(email)).toStrictEqual([]);
    }),
  ),
);

it.live('refuses an Existing-account start that names an invitation at the transport boundary', () =>
  Effect.scoped(
    Effect.gen(function* existingAccountNamingAnInvitationRefused() {
      const runtime = yield* configuredRuntime;
      const email = `enrollment-http-${randomUUID()}@example.test`;

      const response = yield* Effect.promise(
        async () =>
          await runtime.handler(
            startEnrollmentRequest({
              displayName: 'Enrollment HTTP acceptance',
              email,
              invitationId: randomUUID(),
              journey: 'EXISTING_ACCOUNT',
              password: 'P'.repeat(24),
              sellingLegalEntityId: randomUUID(),
            }),
          ),
      );

      // Accepting the key composes the Counterparty target for this Attempt, and its invitation
      // claim has no registered owner effect: the Attempt would journal an account-ownership proof
      // and reserve a Core binding before halting at NO_OWNER_EFFECT for good. Refused at decode,
      // nothing is started at all — a schema that takes an optional invitation here answers 401
      // from the governed Action instead, and this assertion fails.
      expect(response.status).toBe(400);
      expect(yield* portalAccountsFor(email)).toStrictEqual([]);
    }),
  ),
);

/**
 * The durable half of a start, on real PostgreSQL: the Attempt, the claim the route mints for
 * `provider.account.create`, the gate that authorizes exactly one provider call, and the outcome
 * the route owes that claim once the account exists.
 *
 * Only the Better Auth sign-up itself is stood in for — it is the one step that cannot be replayed,
 * and its answer is taken verbatim from the durable authorization the route's own capability reads.
 */
const START_DISPLAY_NAME = 'Enrollment HTTP acceptance';
const START_WORKER_ID = 'commerce.portal-auth.enrollment-start';
const isAttemptConflict = Schema.is(CommerceEnrollmentAttemptConflict);

const startInputFor = (email: string) =>
  Schema.decodeUnknownSync(CommercePortalAuthEnrollmentStartInputSchema)({
    displayName: START_DISPLAY_NAME,
    email,
    journey: 'RETAIL_SELF_ENROLLMENT',
    password: Redacted.make('P'.repeat(24)),
    sellingLegalEntityId: randomUUID(),
  });

/** The Attempt the governed `start-portal-enrollment` Action commits, under the route's own intent. */
const startAcceptanceEnrollment = Effect.fnUntraced(function* startAcceptanceEnrollment(
  fixture: EnrollmentAcceptanceFixture,
  startInput: ReturnType<typeof startInputFor>,
  actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type,
) {
  const intent = yield* commercePortalAuthEnrollmentIntent(startInput);
  return yield* startEnrollmentAcceptanceAttempt(fixture, {
    ...intent,
    actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
    actorPrincipalId,
    tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(fixture.scope.tenantId),
  });
});

/** The durable gate the private account-creation capability passes before it calls the provider. */
const authorizeAcceptanceAccountCreation = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
  ownerInvocationId: string,
) =>
  fixture.run(fixture.scope, (transaction) =>
    commerceEnrollmentAttemptPersistenceForTransaction(transaction, fixture.scope).authorizeAccountCreation({
      ownerInvocationId,
      portalEnrollmentAttemptId,
      tenantId: fixture.scope.tenantId,
    }),
  );

it.live('records the created portal account on the transition the start route claimed', () =>
  Effect.scoped(
    Effect.gen(function* recordsTheCreatedPortalAccount() {
      const tenantId = randomUUID();
      const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const startInput = startInputFor(`enrollment-http-${randomUUID()}@example.test`);
      const attempt = yield* startAcceptanceEnrollment(fixture, startInput, actorPrincipalId);
      const claim = yield* commercePortalAuthEnrollmentAccountCreationClaim(
        startInput,
        attempt.portalEnrollmentAttemptId,
      );

      const claimed = yield* fixture.ownerStore
        .claimTransition(
          Schema.decodeUnknownSync(ClaimEnrollmentTransitionInputSchema)({
            actorPrincipalId,
            expectedRevision: attempt.revision,
            leaseDurationMs: 30_000,
            ownerInvocationId: claim.ownerInvocationId,
            ownerModuleKey: claim.ownerModuleKey,
            portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
            requestDigest: claim.requestDigest,
            required: true,
            tenantId,
            transitionKey: claim.transitionKey,
            workerId: START_WORKER_ID,
          }),
        )
        .pipe(
          Effect.flatMap(
            claimedOrIndeterminate({
              ownerInvocationId: claim.ownerInvocationId,
              portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
            }),
          ),
        );
      expect(claimed.outcome).toBe('CLAIMED');
      expect(commercePortalAuthEnrollmentOwesTransitionOutcome(claimed.operation, claim)).toBe(true);

      // The provider call is authorized by the durable Attempt itself; the evidence and revision it
      // answers with are exactly what the private capability hands back to the route.
      const authorized = yield* authorizeAcceptanceAccountCreation(
        fixture,
        attempt.portalEnrollmentAttemptId,
        claim.ownerInvocationId,
      );
      const providerSubjectId = `portal-user-${randomUUID()}`;
      const recorded = yield* commercePortalAuthEnrollmentAccountCreationOutcome(
        claim,
        claimed.attempt,
        claimed.operation,
        {
          enrollmentAttemptId: attempt.portalEnrollmentAttemptId,
          evidenceRef: authorized.evidenceRef,
          outcome: 'CREATED',
          providerSubjectId,
          revision: authorized.revision,
        },
      ).pipe(Effect.flatMap((outcome) => fixture.ownerStore.recordOutcome(outcome)));

      // Discarding the provider result leaves this row IN_PROGRESS with no subject for good: the
      // Attempt can never derive completion and its reconciliation has nothing to correlate by.
      expect(yield* readEnrollmentAcceptanceOperations(fixture, attempt.portalEnrollmentAttemptId)).toStrictEqual([
        {
          outcome_code: 'provider_account_created',
          reconciliation_ref: null,
          result_reference: authorized.evidenceRef,
          status: 'SUCCEEDED',
          transition_key: PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
        },
      ]);
      expect(recorded.attempt.accountSubject).toStrictEqual({
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        providerSubjectId,
        subjectType: 'user',
      });

      // What the continuation reads next is the durable Attempt, and the subject is on it.
      const observed = yield* fixture.ownerStore.read({
        portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(tenantId),
      });
      expect(observed.accountSubject).toStrictEqual(recorded.attempt.accountSubject);
      expect(observed.state).toBe('IN_PROGRESS');

      // A retry presenting the same Idempotency-Key replays that `CLAIMED` answer verbatim. The
      // journal is what refuses it a second account: the transition is recorded, so the route
      // dispatches nothing, and the durable gate would refuse the provider call in any case.
      const replayed = yield* fixture.ownerStore.readOwnerOperation({
        ownerModuleKey: claim.ownerModuleKey,
        portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(tenantId),
        transitionKey: claim.transitionKey,
      });
      expect(commercePortalAuthEnrollmentOwesTransitionOutcome(replayed, claim)).toBe(false);
      expect(
        isAttemptConflict(
          yield* Effect.flip(
            authorizeAcceptanceAccountCreation(fixture, attempt.portalEnrollmentAttemptId, claim.ownerInvocationId),
          ),
        ),
      ).toBe(true);
    }),
  ),
);

it.live('replays the owner claim of a start retried under the same Idempotency-Key', () =>
  Effect.scoped(
    Effect.gen(function* retriedStartReplaysItsClaim() {
      const tenantId = randomUUID();
      const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const startInput = startInputFor(`enrollment-http-${randomUUID()}@example.test`);
      const attempt = yield* startAcceptanceEnrollment(fixture, startInput, actorPrincipalId);

      /** Exactly what a start mints for its first owner transition, once per request. */
      const mintClaim = () =>
        commercePortalAuthEnrollmentAccountCreationClaim(startInput, attempt.portalEnrollmentAttemptId);
      const claimFor = (claim: CommercePortalAuthEnrollmentTransitionClaim) =>
        fixture.ownerStore.claimTransition(
          Schema.decodeUnknownSync(ClaimEnrollmentTransitionInputSchema)({
            actorPrincipalId,
            expectedRevision: attempt.revision,
            leaseDurationMs: 30_000,
            ownerInvocationId: claim.ownerInvocationId,
            ownerModuleKey: claim.ownerModuleKey,
            portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
            requestDigest: claim.requestDigest,
            required: true,
            tenantId,
            transitionKey: claim.transitionKey,
            workerId: START_WORKER_ID,
          }),
        );

      const first = yield* mintClaim();
      const claimed = yield* claimFor(first);
      expect(claimed.outcome).toBe('CLAIMED');

      // The retry re-derives the identical claim, so the journal recognises its own transition and
      // replays it. Minting a fresh owner invocation identity per request breaks both halves: this
      // claim is refused as a conflict on a transition already claimed under another identity, and
      // the Action payload carrying that identity hashes differently, so the runtime refuses the
      // same Idempotency-Key as a different request rather than replaying the first answer.
      const retry = yield* mintClaim();
      const replayed = yield* claimFor(retry);

      expect(replayed.outcome).toBe('ALREADY_CLAIMED');
      if (replayed.outcome !== 'INDETERMINATE') {
        expect(replayed.operation.ownerInvocationId).toBe(first.ownerInvocationId);
      }
      expect(retry).toStrictEqual(first);
      // One owner operation, not two: the retry claimed nothing new and dispatched nothing.
      expect(yield* readEnrollmentAcceptanceOperations(fixture, attempt.portalEnrollmentAttemptId)).toHaveLength(1);
    }),
  ),
);

/**
 * The enrollment read is not a governed Action: it authenticates the caller's Bearer assertion and
 * then reads one durable Attempt, so the Tenant and the Principal it scopes by are the ones the
 * assertion names and nothing else. Everything below is the deployed composition but that issuer.
 */
const READ_AUDIENCE = 'commerce-customer-context';
const READ_ISSUER = 'http://gateway.enrollment-journeys-http.test';
const READ_KEY_ID = 'enrollment-journeys-http';

/** A redemption store that accepts each `jti` exactly once, as a deployed redemption store does. */
const singleUseRedemptionLive = Layer.sync(GatewayAssertionRedemptionService, () => {
  const consumed = new Set<string>();
  return {
    consume: ({ jti }) =>
      consumed.has(jti)
        ? Effect.fail(new GatewayAssertionReplayError({ reason: 'The Bearer assertion was already redeemed' }))
        : Effect.sync(() => {
            consumed.add(jti);
          }),
  };
});

const authenticatedRuntime = (gateway: AcceptanceGatewayIssuer) =>
  Effect.acquireRelease(
    Effect.gen(function* buildAuthenticatedRuntime() {
      const realmLive = yield* configuredRealmLive();
      return makeCommerceCustomerContextApiRuntime(
        productionReadRuntimeLive,
        productionActionRuntimeLive,
        singleUseRedemptionLive,
        realmLive,
        // The verification material is a composition input of the deployed verifier, so no ambient
        // environment is touched.
        gateway.verificationLive,
      ).createHandler();
    }),
    (runtime) => Effect.promise(async () => await runtime.dispose()),
  );

it.live(
  'answers a same-Tenant caller that did not start an Attempt exactly as an absent one',
  () =>
    Effect.scoped(
      Effect.gen(function* foreignPrincipalReadsNothing() {
        const tenantId = randomUUID();
        const creatorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(randomUUID());
        const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
        const gateway = yield* makeAcceptanceGatewayIssuer(READ_ISSUER, READ_KEY_ID);
        const runtime = yield* authenticatedRuntime(gateway);
        const attempt = yield* startAcceptanceEnrollment(
          fixture,
          startInputFor(`enrollment-http-${randomUUID()}@example.test`),
          creatorPrincipalId,
        );

        /** One portal session of this Tenant reading one Attempt id. */
        const readAs = Effect.fnUntraced(function* readAs(principalId: string, attemptId: string) {
          const assertion = yield* issueAcceptanceGatewayAssertion(fixture.admin, gateway, READ_AUDIENCE, {
            authBindingId: randomUUID(),
            authContextRef: `portal-session:${principalId}`,
            authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
            authMethod: 'session',
            legalEntityId: randomUUID(),
            principalId,
            tenantId,
          });
          return yield* Effect.promise(
            async () =>
              await runtime.handler(
                new Request(`${ORIGIN}/api/portal-auth/enrollment/${attemptId}`, {
                  headers: {
                    authorization: `Bearer ${assertion}`,
                    origin: ORIGIN,
                    'x-correlation-id': `enrollment-http-${randomUUID()}`,
                  },
                  method: 'GET',
                }),
              ),
          );
        });

        // A second customer of the very same Tenant, holding the Attempt id, and the same customer
        // asking for an Attempt that does not exist. The two answers must be indistinguishable.
        const foreign = yield* readAs(randomUUID(), attempt.portalEnrollmentAttemptId);
        const absent = yield* readAs(randomUUID(), randomUUID());
        expect(foreign.status).toBe(404);
        expect(absent.status).toBe(404);
        expect(foreign.headers.get('content-type')).toContain('application/problem+json');
        expect(yield* Effect.promise(async () => await foreign.clone().json())).toStrictEqual(
          yield* Effect.promise(async () => await absent.clone().json()),
        );

        // The foreign read resumed nothing either: the Attempt is untouched at the revision it was
        // started with. Scoping the read alone would leave that resume open to any caller.
        expect(yield* readEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId)).toStrictEqual({
          revision: attempt.revision,
          state: 'IN_PROGRESS',
        });

        // The customer who started it still reads it, so the 404 above is about the caller and not
        // about an unreadable Attempt.
        const owned = yield* readAs(creatorPrincipalId, attempt.portalEnrollmentAttemptId);
        expect(owned.status).toBe(200);
        expect(yield* Effect.promise(async () => await owned.clone().json())).toMatchObject({
          journey: 'RETAIL_SELF_ENROLLMENT',
          portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
          revision: attempt.revision,
          state: 'IN_PROGRESS',
        });
      }),
    ),
  180_000,
);

it.live('serves the enrollment start route from the installed realm under ordinary governance', () =>
  Effect.scoped(
    Effect.gen(function* governedEnrollmentStart() {
      const runtime = yield* configuredRuntime;
      const email = `enrollment-http-${randomUUID()}@example.test`;

      // A first-party caller from a trusted origin that presents no gateway assertion. The route
      // reaches the governed `start-portal-enrollment` Action and is refused there.
      const response = yield* Effect.promise(
        async () =>
          await runtime.handler(
            new Request(`${ORIGIN}/api/portal-auth/enrollment/start`, {
              body: JSON.stringify({
                displayName: 'Enrollment HTTP acceptance',
                email,
                journey: 'RETAIL_SELF_ENROLLMENT',
                password: 'P'.repeat(24),
                sellingLegalEntityId: randomUUID(),
              }),
              headers: {
                'content-type': 'application/json',
                origin: ORIGIN,
                'x-correlation-id': `enrollment-http-${randomUUID()}`,
              },
              method: 'POST',
            }),
          ),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(yield* Effect.promise(async () => await response.clone().json())).toMatchObject({
        status: 401,
      });

      // The refusal happened before any provider effect: an unauthenticated caller creates no
      // account. Removing the governance gate would leave a row here.
      expect(yield* portalAccountsFor(email)).toStrictEqual([]);
    }),
  ),
);

/**
 * The Existing-account journey, which binds an account someone already holds to a Tenant it has
 * never belonged to. Its start is the one place that decision is made, so these scenarios drive a
 * real Commerce portal account and a real browser session for it against the deployed realm: the
 * cookie is minted by Better Auth over the same provider database and the same deployment secret
 * the mounted realm reads, so the route resolves it exactly as a customer's browser would.
 */
const PORTAL_OWNER_PASSWORD = 'P'.repeat(24);

/** The provider account directory the ownership probe reads, over the deployment's own database. */
const portalAccountDirectoryLive = Effect.fnUntraced(function* portalAccountDirectoryLive() {
  const databaseUrl = yield* providerDatabaseUrl;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  return CommercePortalAuthAccountLookupLive.pipe(
    Layer.provide(
      CommercePortalAuthDatabaseLive.pipe(Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration))),
    ),
  );
});

interface SignedInPortalAccount {
  /** The `Cookie` header a browser would send after signing in. */
  readonly cookie: string;
  readonly email: string;
  readonly providerSubjectId: string;
}

/** A verified Commerce portal account and one live session for it, removed again on scope close. */
const makeSignedInPortalAccount = Effect.fnUntraced(function* makeSignedInPortalAccount() {
  const databaseUrl = yield* providerDatabaseUrl;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const database = yield* makeCommercePortalAuthDatabase(configuration).pipe(Effect.orDie);
  const verificationTokens: string[] = [];
  // The realm this fixture signs up through is configured exactly as the mounted one; only the
  // transactional email transport is replaced, so the verification token is observable here.
  const auth = yield* makeCommercePortalAuth({
    configuration,
    databaseAdapter: database.adapter,
    emailDelivery: {
      sendOTP: () => Promise.resolve(),
      sendResetPassword: () => Promise.resolve(),
      sendVerificationEmail: ({ token }) => {
        verificationTokens.push(token);
        return Promise.resolve();
      },
    },
  }).pipe(Effect.orDie);
  const email = `enrollment-owner-${randomUUID()}@example.test`;
  yield* Effect.addFinalizer(() =>
    database.executor
      .transaction((transaction) =>
        Effect.gen(function* deletePortalAccount() {
          yield* transaction.delete(user).where(eq(user.email, email));
          yield* transaction.delete(verification).where(eq(verification.identifier, email));
        }),
      )
      .pipe(Effect.orDie),
  );
  const headers = new Headers({ origin: ORIGIN });
  yield* Effect.promise(
    async () =>
      await auth.api.signUpEmail({
        body: { email, name: 'Enrollment owner', password: PORTAL_OWNER_PASSWORD },
        headers,
        returnHeaders: true,
      }),
  );
  const token = verificationTokens.at(-1);
  if (token === undefined) {
    return yield* Effect.die('The portal owner fixture received no email verification token');
  }
  // The owner's session evidence is refused for an unverified account, so the fixture completes the
  // verification the deployment's own policy requires before signing in.
  yield* Effect.promise(async () => await auth.api.verifyEmail({ headers, query: { token }, returnHeaders: true }));
  const signedIn = yield* Effect.promise(
    async () =>
      await auth.api.signInEmail({
        body: { email, password: PORTAL_OWNER_PASSWORD },
        headers,
        returnHeaders: true,
      }),
  );
  const cookie = signedIn.headers
    .getSetCookie()
    .map((header) => header.split(';')[0] ?? '')
    .filter((pair) => pair.length > 0)
    .join('; ');
  const [account] = yield* portalAccountsFor(email);
  if (account === undefined || cookie.length === 0) {
    return yield* Effect.die('The portal owner fixture produced no signed-in account');
  }
  return { cookie, email, providerSubjectId: account.id } satisfies SignedInPortalAccount;
});

/** Every Attempt of one Tenant, read with the owner role so RLS cannot mask a persisted row. */
const enrollmentAttemptCount = (fixture: EnrollmentAcceptanceFixture): Effect.Effect<number> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute<{ readonly attempts: string }>(
        sql`
          select count(*)::text as attempts
            from commerce_customer_context.portal_enrollment_attempts
           where tenant_id = ${fixture.scope.tenantId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(
      Effect.map((rows) => Number(rows[0]?.attempts ?? '0')),
      Effect.orDie,
    );

const existingAccountStartInputFor = (email: string) =>
  Schema.decodeUnknownSync(CommercePortalAuthEnrollmentStartInputSchema)({
    displayName: START_DISPLAY_NAME,
    email,
    journey: 'EXISTING_ACCOUNT',
    password: Redacted.make(PORTAL_OWNER_PASSWORD),
    sellingLegalEntityId: randomUUID(),
  });

/** One Existing-account start request, optionally carrying a browser session and an assertion. */
const startExistingAccountRequest = (
  email: string,
  options: { readonly assertion?: string; readonly cookie?: string },
): Request => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: ORIGIN,
    'x-correlation-id': `enrollment-http-${randomUUID()}`,
  });
  if (options.assertion !== undefined) {
    headers.set('authorization', `Bearer ${options.assertion}`);
  }
  if (options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }
  return new Request(`${ORIGIN}/api/portal-auth/enrollment/start`, {
    body: JSON.stringify({
      displayName: START_DISPLAY_NAME,
      email,
      journey: 'EXISTING_ACCOUNT',
      password: PORTAL_OWNER_PASSWORD,
      sellingLegalEntityId: randomUUID(),
    }),
    headers,
    method: 'POST',
  });
};

it.live(
  'records the authenticated owner account subject on the transition an Existing-account start claims',
  () =>
    Effect.scoped(
      Effect.gen(function* recordsTheAuthenticatedOwnerSubject() {
        const tenantId = randomUUID();
        const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(randomUUID());
        const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
        const owner = yield* makeSignedInPortalAccount();
        const scope = yield* Effect.scope;
        const realm = yield* Layer.buildWithScope(yield* configuredRealmLive(), scope);

        // The gate's own read, over the deployed realm: Better Auth resolves the request's cookie to
        // a session identity and the owner's lifecycle decides it is live evidence for that subject.
        const current = yield* commercePortalAuthEnrollmentSessionSubject(
          Context.get(realm, CommercePortalAuthService),
          Context.get(realm, CommercePortalAuthSessionLifecycle),
          new Headers({ cookie: owner.cookie }),
        );
        if (Option.isNone(current)) {
          throw new Error('The deployed realm must resolve a live browser session to its subject');
        }
        const accountSubject = current.value;
        expect(accountSubject.providerSubjectId).toBe(owner.providerSubjectId);
        expect(accountSubject.authenticationNamespaceId).toBe(COMMERCE_AUTHENTICATION_NAMESPACE_ID);

        // The directory decides whether that exact subject holds the address being enrolled. It is
        // the narrow probe the owner reconciler reads: a yes/no, never a user record.
        const accountLookup = Context.get(
          yield* Layer.buildWithScope(yield* portalAccountDirectoryLive(), scope),
          CommercePortalAuthAccountLookupService,
        );
        expect(
          yield* accountLookup.existsByProviderSubject({
            email: owner.email,
            providerSubjectId: accountSubject.providerSubjectId,
          }),
        ).toBe(true);
        expect(
          yield* accountLookup.existsByProviderSubject({
            email: `enrollment-http-${randomUUID()}@example.test`,
            providerSubjectId: accountSubject.providerSubjectId,
          }),
        ).toBe(false);

        const startInput = existingAccountStartInputFor(owner.email);
        const attempt = yield* startAcceptanceEnrollment(fixture, startInput, actorPrincipalId);
        const claim = yield* commercePortalAuthEnrollmentAccountVerificationClaim(
          startInput,
          attempt.portalEnrollmentAttemptId,
        );
        const claimed = yield* fixture.ownerStore
          .claimTransition(
            Schema.decodeUnknownSync(ClaimEnrollmentTransitionInputSchema)({
              actorPrincipalId,
              expectedRevision: attempt.revision,
              leaseDurationMs: 30_000,
              ownerInvocationId: claim.ownerInvocationId,
              ownerModuleKey: claim.ownerModuleKey,
              portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
              requestDigest: claim.requestDigest,
              required: true,
              tenantId,
              transitionKey: claim.transitionKey,
              workerId: START_WORKER_ID,
            }),
          )
          .pipe(
            Effect.flatMap(
              claimedOrIndeterminate({
                ownerInvocationId: claim.ownerInvocationId,
                portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
              }),
            ),
          );
        expect(claimed.outcome).toBe('CLAIMED');
        expect(commercePortalAuthEnrollmentOwesTransitionOutcome(claimed.operation, claim)).toBe(true);

        const recorded = yield* commercePortalAuthEnrollmentAccountVerificationOutcome(
          claim,
          claimed.attempt,
          claimed.operation,
          accountSubject,
        ).pipe(Effect.flatMap((outcome) => fixture.ownerStore.recordOutcome(outcome)));

        // The ownership proof is journalled under the transition the journey declares, and the
        // subject it proved is on the Attempt. Discarding either leaves the journey gated on a step
        // nothing can ever record, with no subject for the Core reservation to bind.
        expect(yield* readEnrollmentAcceptanceOperations(fixture, attempt.portalEnrollmentAttemptId)).toStrictEqual([
          {
            outcome_code: 'provider_account_verified',
            reconciliation_ref: null,
            result_reference: attempt.portalEnrollmentAttemptId,
            status: 'SUCCEEDED',
            transition_key: PORTAL_ACCOUNT_VERIFICATION_TRANSITION_KEY,
          },
        ]);
        expect(recorded.attempt.accountSubject).toStrictEqual({
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          providerSubjectId: owner.providerSubjectId,
          subjectType: 'user',
        });
        expect(recorded.attempt.state).toBe('IN_PROGRESS');

        // The continuation now gets past the subject it used to have none of: its first pass reaches
        // the Core identity transport (deliberately unreachable here) instead of refusing the
        // Attempt for want of a recorded provider subject, which is what left it IN_PROGRESS forever.
        const continuation = Context.get(
          yield* Layer.buildWithScope(yield* continuationLive(), scope),
          CommerceEnrollmentContinuation,
        );
        const halted = yield* Effect.flip(
          continuation.advance({
            portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
            tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(tenantId),
          }),
        );
        expect(halted.reason).not.toContain('provider account subject');
        expect(halted.reason).toContain('Core Principal Auth Binding');
      }),
    ),
  180_000,
);

it.live(
  'refuses an Existing-account start whose session owns a different account, before any Attempt',
  () =>
    Effect.scoped(
      Effect.gen(function* refusesAForeignAccountOwner() {
        const tenantId = randomUUID();
        const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
        const gateway = yield* makeAcceptanceGatewayIssuer(READ_ISSUER, READ_KEY_ID);
        const runtime = yield* authenticatedRuntime(gateway);
        const owner = yield* makeSignedInPortalAccount();
        const stranger = yield* makeSignedInPortalAccount();
        const assertion = yield* issueAcceptanceGatewayAssertion(fixture.admin, gateway, READ_AUDIENCE, {
          authBindingId: randomUUID(),
          authContextRef: `portal-session:${owner.providerSubjectId}`,
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          authMethod: 'session',
          legalEntityId: randomUUID(),
          principalId: randomUUID(),
          tenantId,
        });

        // The route's own gate, over the deployed realm and the real provider directory: a live,
        // verified portal session presented for an address that belongs to somebody else.
        const scope = yield* Effect.scope;
        const gateServices = Context.merge(
          yield* Layer.buildWithScope(yield* configuredRealmLive(), scope),
          yield* Layer.buildWithScope(yield* portalAccountDirectoryLive(), scope),
        );
        const ownerHeaders = new Headers({ cookie: owner.cookie });
        const refusal = yield* Effect.flip(
          commercePortalAuthEnrollmentAccountOwner(ownerHeaders, stranger.email).pipe(
            Effect.provideContext(gateServices),
          ),
        );
        expect(refusal).toMatchObject({ code: 'invalid_request', status: 400 });

        // The stranger's address does have an account, and the session presented is a real one, so
        // every fact the old check consulted still holds. Only the pairing is wrong, and that is
        // what refuses: a caller that knows an address cannot enroll its owner into its own Tenant.
        const accountLookup = Context.get(gateServices, CommercePortalAuthAccountLookupService);
        expect(yield* accountLookup.existsByEmail({ email: stranger.email })).toBe(true);
        expect(
          yield* commercePortalAuthEnrollmentAccountOwner(ownerHeaders, owner.email).pipe(
            Effect.provideContext(gateServices),
          ),
        ).toStrictEqual({
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          providerSubjectId: owner.providerSubjectId,
          subjectType: 'user',
        });

        // End to end, the same mismatched start persists no Attempt. This harness names no portal
        // realm in the deployment environment it reads, so the directory the mounted route probes
        // is the fail-closed leaf and the refusal it reaches the caller with is the retryable 503 —
        // upstream of the governed Action either way, which is what leaves the Tenant empty.
        const response = yield* Effect.promise(
          async () =>
            await runtime.handler(startExistingAccountRequest(stranger.email, { assertion, cookie: owner.cookie })),
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(yield* enrollmentAttemptCount(fixture)).toBe(0);
      }),
    ),
  180_000,
);

it.live(
  'answers an Existing-account start that carries no portal session with 401 and no Attempt',
  () =>
    Effect.scoped(
      Effect.gen(function* refusesAnUnauthenticatedExistingAccountStart() {
        const tenantId = randomUUID();
        const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
        const gateway = yield* makeAcceptanceGatewayIssuer(READ_ISSUER, READ_KEY_ID);
        const runtime = yield* authenticatedRuntime(gateway);
        const owner = yield* makeSignedInPortalAccount();
        const assertion = yield* issueAcceptanceGatewayAssertion(fixture.admin, gateway, READ_AUDIENCE, {
          authBindingId: randomUUID(),
          authContextRef: `portal-session:${owner.providerSubjectId}`,
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          authMethod: 'session',
          legalEntityId: randomUUID(),
          principalId: randomUUID(),
          tenantId,
        });

        // The caller's gateway assertion is valid and names this Tenant, so the governed Action would
        // be reached. It never is: this journey needs the account owner's own portal session, and the
        // request carries no cookie at all.
        const response = yield* Effect.promise(
          async () => await runtime.handler(startExistingAccountRequest(owner.email, { assertion })),
        );

        expect(response.status).toBe(401);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(yield* Effect.promise(async () => await response.clone().json())).toMatchObject({
          code: 'authentication_required',
          status: 401,
        });
        expect(yield* enrollmentAttemptCount(fixture)).toBe(0);
      }),
    ),
  180_000,
);
