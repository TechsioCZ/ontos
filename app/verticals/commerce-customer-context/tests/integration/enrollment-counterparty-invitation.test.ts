import { randomUUID } from 'node:crypto';

import { ActionAuthorizationPreflightDatabaseLive, CorePersistenceLive, DatabaseConfigLive } from '@app/core-runtime';
import { ResendEmailDeliveryConfig } from '@app/email-delivery/resend';
import { FetchHttpClient } from 'effect/unstable/http';
import { eq } from 'drizzle-orm';
import { Config, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '../../../../packages/core-runtime/src/auth/gateway-assertion-redemption.ts';
import {
  commerceCustomerContextActionRuntimeAwaitingOwnerPreparation,
  commercePortalAuthRealmLive,
  makeCommerceCustomerContextApiRuntime,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { CommercePortalAuthEnrollmentAttemptProjectionSchema } from '../../api/portal-auth/enrollment/contracts.ts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { CommercePortalAuthAccountCreationReconciliationService } from '../../api/portal-auth/provider/account-creation-reconciliation-service.ts';
import { CommercePortalAuthAccountCreationProviderLive } from '../../api/portal-auth/provider/account-create.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { CommerceCoreIdentityClientLive } from '../../api/portal-auth/provider/core-identity-client.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import { CommercePortalAuthAccountCreationReconciliationLive } from '../../src/portal-auth/persistence/portal-auth-account-creation-reconciliation.ts';
import {
  CommerceEnrollmentContinuation,
  CommerceEnrollmentContinuationLive,
} from '../../src/enrollment/continuation/enrollment-continuation.ts';
import { CommerceEnrollmentOwnerEffectRegistryLive } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY } from '../../src/enrollment/journeys/counterparty-invitation.ts';
import {
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
} from '../../src/enrollment/journeys/existing-account.ts';
import { retailPartyCandidateDigest } from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { RetailSelfEnrollmentPreparationSubject } from '../../src/enrollment/journeys/retail-self-enrollment-preparation.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../../src/enrollment/orchestration/owner-transaction-runner.ts';
import { commerceEnrollmentOwnerTransitionPreparationLive } from '../../src/enrollment/orchestration/owner-transition-composition.ts';
import {
  CommerceEnrollmentPreparationSubjectResolver,
  CommerceEnrollmentPreparationSubjectResolverLive,
} from '../../src/enrollment/orchestration/preparation-subject.ts';
import { PORTAL_ACCOUNT_CREATION_TRANSITION_KEY } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  CommercePortalAuthDatabaseLive,
  makeCommercePortalAuthDatabase,
} from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { user, verification } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import {
  EnrollmentAttemptIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import {
  expireEnrollmentAcceptanceLeases,
  makeEnrollmentAcceptanceFixture,
  readEnrollmentAcceptanceAttempt,
  readEnrollmentAcceptanceOperations,
} from '../support/enrollment-acceptance-fixture.ts';
import type { EnrollmentAcceptanceFixture } from '../support/enrollment-acceptance-fixture.ts';
import {
  issueAcceptanceGatewayAssertion,
  makeAcceptanceGatewayIssuer,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import type { AcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import { makeEnrollmentContinuationHarness } from '../support/enrollment-continuation-harness.ts';
import { makeCapturingCounterpartyInvitationProofDelivery } from '../support/counterparty-invitation-proof-capture.ts';
import {
  countCounterpartyInvitationClaims,
  issueCounterpartyAccessInvitation,
  loseCounterpartyInvitationClaimAnswer,
  makeCounterpartyInvitationRealm,
  readCounterpartyInvitationClaimProof,
  readCounterpartyInvitationRow,
} from '../support/counterparty-invitation-acceptance.ts';
import type { CounterpartyInvitationRealm } from '../support/counterparty-invitation-acceptance.ts';
import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';

/**
 * The Counterparty invitation enrollment journey, end to end on the deployed composition.
 *
 * Everything the recipient's claim depends on is real: the invitation and its one-time proof are
 * created through the owner port the governed create Action calls, the provider account is the one
 * the enrollment start route really signs up, the recipient's browser session is a Better Auth
 * session over the deployment's own secret and database, the gateway assertion is verified by the
 * deployed audience-bound verifier, and the claim itself runs the governed
 * `claim-counterparty-access-invitation` Action against real SpiceDB relationships.
 *
 * Only the two Core identity transitions are scripted: their owner is an HTTP transport to Shell
 * that is not reachable from this sandbox, so the dispatch seam is where the script sits — exactly
 * as the Retail acceptance places it. The reservation answers with the recipient's real Core
 * Principal Auth Binding, which is what the claim route compares the caller's assertion against.
 */

const ORIGIN = 'http://localhost:3020';
const SECRET = 'd'.repeat(64);
const AUDIENCE = 'commerce-customer-context';
const ISSUER = 'http://gateway.enrollment-counterparty-invitation.test';
const KEY_ID = 'enrollment-counterparty-invitation';
const PORTAL_PASSWORD = 'P'.repeat(24);
const DISPLAY_NAME = 'Counterparty invitation recipient';

const START_ACTION_KEY = 'commerce.customer-context.start-portal-enrollment';
const CLAIM_TRANSITION_ACTION_KEY = 'commerce.customer-context.claim-portal-enrollment-transition';
const CLAIM_INVITATION_ACTION_KEY = 'commerce.customer-context.claim-counterparty-access-invitation';

const BINDING_RESERVED_OUTCOME_CODE = 'principal_binding_reserved';
const BINDING_ACTIVATED_OUTCOME_CODE = 'principal_binding_activated';

const providerDatabaseUrl = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);

/** Resend is answered locally: creation now awaits delivery, so the transport must accept. */
const acceptingResendFetch: typeof fetch = () => Promise.resolve(Response.json({ id: 'accepted' }));

const emailDeliveryConfiguration = Layer.mergeAll(
  Layer.succeed(ResendEmailDeliveryConfig, {
    apiKey: Redacted.make('re_commerce_enrollment_counterparty_invitation'),
    endpoint: 'https://api.resend.com/emails',
    from: 'no-reply@commerce.example.test',
  }),
  Layer.succeed(FetchHttpClient.Fetch, acceptingResendFetch),
);

const portalAuthConfiguration = Effect.fnUntraced(function* portalAuthConfiguration() {
  const databaseUrl = yield* providerDatabaseUrl;
  return yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
});

/** The realm a host that opted in gets, assembled from the same layer the composition root uses. */
const configuredRealmLive = Effect.fnUntraced(function* configuredRealmLive() {
  const configuration = yield* portalAuthConfiguration();
  return commercePortalAuthRealmLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.succeed(CommercePortalAuthConfig, configuration), emailDeliveryConfiguration),
    ),
  );
});

/**
 * The enrollment owner preparation authority, assembled from the very layers `api/index.ts`
 * composes for a deployment that opted into both halves of the realm.
 */
const preparationAuthorityLive = Effect.fnUntraced(function* preparationAuthorityLive() {
  const configuration = yield* portalAuthConfiguration();
  const coreIdentityConfigurationLive = Layer.succeed(CommerceCoreIdentityClientConfig, {
    apiKey: Redacted.make('enrollment-counterparty-invitation-core-identity'),
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
  const databaseLive = CommercePortalAuthDatabaseLive.pipe(
    Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration)),
  );
  const accountLookupLive = CommercePortalAuthAccountLookupLive.pipe(Layer.provide(databaseLive));
  const realmLive = yield* configuredRealmLive();
  const accountCreationReconciliationLive = CommercePortalAuthAccountCreationReconciliationLive.pipe(
    Layer.provide(
      Layer.mergeAll(databaseLive, CommercePortalAuthAccountCreationProviderLive.pipe(Layer.provide(realmLive))),
    ),
  );
  const subjectResolverLive = CommerceEnrollmentPreparationSubjectResolverLive.pipe(
    Layer.provide(Layer.mergeAll(transactionRunnerLive, coreIdentityLive, coreIdentityConfigurationLive)),
  );
  return commerceEnrollmentOwnerTransitionPreparationLive.pipe(
    Layer.provide(
      Layer.mergeAll(transactionRunnerLive, accountLookupLive, accountCreationReconciliationLive, subjectResolverLive),
    ),
  );
});

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

/** The deployed handler tree with both halves of the realm and the configured owner preparation. */
const deployedRuntime = (gateway: AcceptanceGatewayIssuer) =>
  Effect.acquireRelease(
    Effect.gen(function* buildDeployedRuntime() {
      const realmLive = yield* configuredRealmLive();
      const preparationLive = yield* preparationAuthorityLive();
      return makeCommerceCustomerContextApiRuntime(
        productionReadRuntimeLive,
        commerceCustomerContextActionRuntimeAwaitingOwnerPreparation.pipe(Layer.provide(preparationLive)),
        singleUseRedemptionLive,
        realmLive,
        gateway.verificationLive,
      ).createHandler();
    }),
    (runtime) => Effect.promise(async () => await runtime.dispose()),
  );

/** The provider account directory, read directly so a created row cannot hide behind the port. */
const portalAccountsFor = Effect.fnUntraced(function* portalAccountsFor(email: string) {
  const databaseUrl = yield* providerDatabaseUrl;
  const database = yield* acquireOutlivingCleanup(
    makeCommercePortalAuthDatabase({ connectionString: databaseUrl }),
  ).pipe(Effect.orDie);
  return yield* database.executor.select({ id: user.id }).from(user).where(eq(user.email, email)).pipe(Effect.orDie);
});

/** Removes the provider account a start really created, so the directory is left as it was found. */
const removePortalAccountsOnClose = Effect.fnUntraced(function* removePortalAccountsOnClose(email: string) {
  const databaseUrl = yield* providerDatabaseUrl;
  const database = yield* acquireOutlivingCleanup(
    makeCommercePortalAuthDatabase({ connectionString: databaseUrl }),
  ).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() =>
    database.executor
      .transaction((transaction) =>
        Effect.gen(function* deleteCreatedAccount() {
          yield* transaction.delete(user).where(eq(user.email, email));
          yield* transaction.delete(verification).where(eq(verification.identifier, email));
        }),
      )
      .pipe(Effect.orDie),
  );
});

interface SignedInPortalAccount {
  /** The `Cookie` header a browser would send after signing in. */
  readonly cookie: string;
  readonly providerSubjectId: string;
}

/**
 * Verifies and signs in an account the enrollment start route already created.
 *
 * The realm this fixture drives is configured exactly as the mounted one; only the transactional
 * email transport is replaced, so the verification token the deployment's own policy requires is
 * observable here instead of leaving with a Resend request.
 */
const signInPortalAccount = Effect.fnUntraced(function* signInPortalAccount(email: string) {
  const configuration = yield* portalAuthConfiguration();
  const database = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration)).pipe(Effect.orDie);
  const verificationTokens: string[] = [];
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
  const headers = new Headers({ origin: ORIGIN });
  yield* Effect.promise(
    async () => await auth.api.sendVerificationEmail({ body: { email }, headers, returnHeaders: true }),
  );
  const token = verificationTokens.at(-1);
  if (token === undefined) {
    return yield* Effect.die('The enrolled portal account received no email verification token');
  }
  yield* Effect.promise(async () => await auth.api.verifyEmail({ headers, query: { token }, returnHeaders: true }));
  const signedIn = yield* Effect.promise(
    async () =>
      await auth.api.signInEmail({ body: { email, password: PORTAL_PASSWORD }, headers, returnHeaders: true }),
  );
  const cookie = signedIn.headers
    .getSetCookie()
    .map((header) => header.split(';')[0] ?? '')
    .filter((pair) => pair.length > 0)
    .join('; ');
  const [account] = yield* portalAccountsFor(email);
  if (account === undefined || cookie.length === 0) {
    return yield* Effect.die('The enrolled portal account could not be signed in');
  }
  return { cookie, providerSubjectId: account.id } satisfies SignedInPortalAccount;
});

const startInvitationRequest = (body: Record<string, string>, assertion: string): Request =>
  new Request(`${ORIGIN}/api/portal-auth/enrollment/start`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${assertion}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      origin: ORIGIN,
      'x-correlation-id': `counterparty-invitation-${randomUUID()}`,
    },
    method: 'POST',
  });

const claimInvitationRequest = (
  portalEnrollmentAttemptId: string,
  body: Record<string, string>,
  options: {
    readonly assertion: string;
    readonly cookie?: string;
    readonly omitCorrelationId?: boolean;
    readonly omitIdempotencyKey?: boolean;
  },
): Request => {
  const headers = new Headers({
    authorization: `Bearer ${options.assertion}`,
    'content-type': 'application/json',
    origin: ORIGIN,
  });
  if (options.omitCorrelationId !== true) {
    headers.set('x-correlation-id', `counterparty-invitation-${randomUUID()}`);
  }
  if (options.omitIdempotencyKey !== true) {
    headers.set('idempotency-key', randomUUID());
  }
  if (options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }
  return new Request(`${ORIGIN}/api/portal-auth/enrollment/${portalEnrollmentAttemptId}/claim-invitation`, {
    body: JSON.stringify(body),
    headers,
    method: 'POST',
  });
};

const StartedEnrollmentResponseSchema = Schema.Struct({
  attempt: CommercePortalAuthEnrollmentAttemptProjectionSchema,
  outcome: Schema.Literals(['CREATED', 'EXISTING']),
});

type DeployedHandler = ReturnType<ReturnType<typeof makeCommerceCustomerContextApiRuntime>['createHandler']>;

const responseBody = (response: Response) => Effect.promise(async () => await response.clone().json());

/** The two Core identity answers a Counterparty invitation journey needs before its claim. */
const coreIdentityAnswers = (authBindingId: string) => ({
  [ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY]: {
    kind: 'SUCCEEDED' as const,
    outcomeCode: BINDING_ACTIVATED_OUTCOME_CODE,
    resultReference: authBindingId,
  },
  [RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY]: {
    kind: 'SUCCEEDED' as const,
    outcomeCode: BINDING_RESERVED_OUTCOME_CODE,
    resultReference: authBindingId,
  },
});

/** The preparation subject the continuation resolves; the Core transitions never read it. */
const preparationSubjectFor = (
  realm: CounterpartyInvitationRealm,
  portalEnrollmentAttemptId: string,
): RetailSelfEnrollmentPreparationSubject => {
  const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(realm.tenantId);
  return {
    partyCandidateDigest: retailPartyCandidateDigest(['PERSON', 'counterparty-invitation-acceptance']),
    partyRef: Option.none(),
    portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(portalEnrollmentAttemptId),
    principalRef: {
      moduleId: 'core.identity',
      resourceId: realm.recipientPrincipalId,
      resourceType: 'core.identity.principal',
      tenantId,
    },
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: realm.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  };
};

interface InvitationScenario {
  readonly attemptId: string;
  readonly claimProofReference: string;
  readonly email: string;
  readonly fixture: EnrollmentAcceptanceFixture;
  readonly gateway: AcceptanceGatewayIssuer;
  readonly invitationId: string;
  readonly realm: CounterpartyInvitationRealm;
  readonly runtime: DeployedHandler;
  readonly secret: string;
  readonly session: SignedInPortalAccount;
}

/**
 * Everything up to the claim: a real invitation, a started Attempt with its provider account, the
 * journey advanced as far as the scenario asks, and the recipient signed in.
 */
const invitationScenario = Effect.fnUntraced(function* invitationScenario(options: {
  readonly advanceBinding: 'ACTIVATED' | 'RESERVED_ONLY';
}) {
  const tenantId = randomUUID();
  const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
  const realm = yield* makeCounterpartyInvitationRealm(fixture, {
    recipientActionKeys: [CLAIM_INVITATION_ACTION_KEY],
    storefrontActionKeys: [START_ACTION_KEY, CLAIM_TRANSITION_ACTION_KEY],
  });
  const capture = makeCapturingCounterpartyInvitationProofDelivery();
  const email = `counterparty-invitation-${randomUUID()}@example.test`;
  const invitation = yield* issueCounterpartyAccessInvitation(realm, capture, email);
  yield* removePortalAccountsOnClose(email);

  const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, KEY_ID);
  const runtime = yield* deployedRuntime(gateway);
  // The shared Storefront client starts the enrollment on the recipient's behalf, so its assertion
  // carries no Legal Entity: both governed Actions of a start forbid one in the caller's scope.
  const startAssertion = yield* issueAcceptanceGatewayAssertion(fixture.admin, gateway, AUDIENCE, {
    authBindingId: realm.storefrontAuthBindingId,
    authContextRef: `portal-session:${realm.storefrontPrincipalId}`,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    principalId: realm.storefrontPrincipalId,
    tenantId,
  });
  const startResponse = yield* Effect.promise(
    async () =>
      await runtime.handler(
        startInvitationRequest(
          {
            displayName: DISPLAY_NAME,
            email,
            invitationId: invitation.invitationId,
            journey: 'COUNTERPARTY_INVITATION',
            password: PORTAL_PASSWORD,
            sellingLegalEntityId: realm.legalEntityId,
          },
          startAssertion,
        ),
      ),
  );
  if (startResponse.status !== 200) {
    return yield* Effect.die(
      `The Counterparty invitation start answered ${startResponse.status}: ${JSON.stringify(yield* responseBody(startResponse))}`,
    );
  }
  const started = Schema.decodeUnknownSync(StartedEnrollmentResponseSchema)(yield* responseBody(startResponse));
  const attemptId = started.attempt.portalEnrollmentAttemptId;

  const answers = coreIdentityAnswers(realm.recipientAuthBindingId);
  const harness = yield* makeEnrollmentContinuationHarness(fixture.run, fixture.runWorker, {
    actorPrincipalId: Schema.decodeSync(EnrollmentPrincipalIdSchema)(realm.storefrontPrincipalId),
    answers:
      options.advanceBinding === 'ACTIVATED'
        ? answers
        : { [RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY]: answers[RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY] },
    subject: preparationSubjectFor(realm, attemptId),
    unregistered:
      options.advanceBinding === 'ACTIVATED'
        ? [CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY]
        : [ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY, CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY],
  });
  yield* harness.continuation.advance({
    portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(attemptId),
    tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(tenantId),
  });

  const session = yield* signInPortalAccount(email);
  const scenario: InvitationScenario = {
    attemptId,
    claimProofReference: invitation.claimProofReference,
    email,
    fixture,
    gateway,
    invitationId: invitation.invitationId,
    realm,
    runtime,
    secret: invitation.secret,
    session,
  };
  return { continuation: harness.continuation, scenario };
});

/** One fresh, single-use assertion for the recipient's own portal session. */
const recipientAssertion = (scenario: InvitationScenario) =>
  issueAcceptanceGatewayAssertion(scenario.fixture.admin, scenario.gateway, AUDIENCE, {
    authBindingId: scenario.realm.recipientAuthBindingId,
    authContextRef: `portal-session:${scenario.realm.recipientPrincipalId}`,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId: scenario.realm.legalEntityId,
    principalId: scenario.realm.recipientPrincipalId,
    tenantId: scenario.realm.tenantId,
  });

type EnrollmentOperationRow = Effect.Success<ReturnType<typeof readEnrollmentAcceptanceOperations>>[number];

const claimTransitionRow = (rows: readonly EnrollmentOperationRow[]) =>
  rows.find((row) => row.transition_key === CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY);

const claimTransitionFor = (scenario: InvitationScenario) =>
  readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId).pipe(Effect.map(claimTransitionRow));

/**
 * The continuation a deployed sweeper runs, with this deployment's own owner-effect registry.
 *
 * Only the journey subject is supplied directly: resolving it calls Core, which is not reachable
 * from this sandbox. Everything the claim transition itself is settled by — the registry entry, the
 * owner transaction runner, the invitation routine and the driver's reconciliation phases — is the
 * deployed one, so this is the sweep that would run with no recipient present at all.
 */
const sweepingContinuation = Effect.fnUntraced(function* sweepingContinuation(scenario: InvitationScenario) {
  const configuration = yield* portalAuthConfiguration();
  const coreIdentityConfigurationLive = Layer.succeed(CommerceCoreIdentityClientConfig, {
    apiKey: Redacted.make('enrollment-counterparty-invitation-core-identity'),
    baseUrl: 'https://core-identity.invalid',
  });
  const transactionRunnerLive = Layer.succeed(CommerceEnrollmentOwnerTransactionRunner, {
    run: scenario.fixture.run,
    runWorker: scenario.fixture.runWorker,
  });
  const registryLive = CommerceEnrollmentOwnerEffectRegistryLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        CommercePortalAuthAccountLookupLive.pipe(
          Layer.provide(
            CommercePortalAuthDatabaseLive.pipe(Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration))),
          ),
        ),
        CommerceCoreIdentityClientLive.pipe(Layer.provide(coreIdentityConfigurationLive)),
        coreIdentityConfigurationLive,
        Layer.succeed(CommercePortalAuthAccountCreationReconciliationService, {
          reissueVerificationEmail: () => Effect.die('reissueVerificationEmail is not part of this scenario'),
        }),
        transactionRunnerLive,
      ),
    ),
  );
  const subjectLive = Layer.succeed(CommerceEnrollmentPreparationSubjectResolver, {
    resolve: (input) =>
      Effect.succeed({
        ...preparationSubjectFor(scenario.realm, scenario.attemptId),
        portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
      }),
  });
  return yield* CommerceEnrollmentContinuation.pipe(
    Effect.provide(
      CommerceEnrollmentContinuationLive.pipe(
        Layer.provide(Layer.mergeAll(transactionRunnerLive, registryLive, subjectLive)),
      ),
    ),
  );
});

it.live(
  'claims a Counterparty invitation for the Principal its own journey bound and completes the Attempt',
  () =>
    Effect.scoped(
      Effect.gen(function* claimsTheInvitation() {
        const { continuation, scenario } = yield* invitationScenario({ advanceBinding: 'ACTIVATED' });

        // The start really created the provider account the journey then binds.
        expect(yield* portalAccountsFor(scenario.email)).toHaveLength(1);
        expect(scenario.session.providerSubjectId).toBe((yield* portalAccountsFor(scenario.email))[0]?.id);

        // Both Core transitions are SUCCEEDED before the claim is reachable at all.
        const beforeClaim = yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId);
        expect(beforeClaim.map((row) => [row.transition_key, row.status])).toStrictEqual([
          [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, 'SUCCEEDED'],
          [RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY, 'SUCCEEDED'],
          [ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY, 'SUCCEEDED'],
        ]);

        const assertion = yield* recipientAssertion(scenario);
        const response = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(
                scenario.attemptId,
                { claimProofReference: scenario.claimProofReference, invitationSecret: scenario.secret },
                { assertion, cookie: scenario.session.cookie },
              ),
            ),
        );
        expect(response.status).toBe(200);

        // The claim is journalled under the journey's own transition, and its result reference is
        // the exact proof the redemption resolved the secret to.
        const claimed = claimTransitionRow(
          yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId),
        );
        expect(claimed).toMatchObject({
          outcome_code: 'counterparty_invitation_claimed',
          result_reference: scenario.claimProofReference,
          status: 'SUCCEEDED',
        });

        // The invitation itself records the recipient's own Principal as its claimant.
        const invitationRow = yield* readCounterpartyInvitationRow(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );
        expect(invitationRow.claimed_by_principal_id).toBe(scenario.realm.recipientPrincipalId);

        // The proof the recipient presented is spent, and the claim the invitation durably carries
        // is the attestation that redemption verified rather than the reference it was presented as.
        const consumedProof = yield* readCounterpartyInvitationClaimProof(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );
        expect(consumedProof).toMatchObject({
          claimant_principal_id: scenario.realm.recipientPrincipalId,
          lifecycle: 'CONSUMED',
        });
        expect(invitationRow.claim_proof_reference).toBe(consumedProof.attestation_reference);

        // Every required transition is now SUCCEEDED, so the journey derives completion.
        const advanced = yield* continuation.advance({
          portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(scenario.attemptId),
          tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(scenario.realm.tenantId),
        });
        expect(advanced.outcome).toBe('COMPLETE');
        expect(yield* readEnrollmentAcceptanceAttempt(scenario.fixture, scenario.attemptId)).toMatchObject({
          state: 'COMPLETE',
        });
      }),
    ),
  300_000,
);

it.live(
  'refuses a claim presenting the wrong secret and journals the refusal as a typed failure',
  () =>
    Effect.scoped(
      Effect.gen(function* refusesTheWrongSecret() {
        const { scenario } = yield* invitationScenario({ advanceBinding: 'ACTIVATED' });

        const assertion = yield* recipientAssertion(scenario);
        const response = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(
                scenario.attemptId,
                {
                  claimProofReference: scenario.claimProofReference,
                  invitationSecret: 'f'.repeat(scenario.secret.length),
                },
                { assertion, cookie: scenario.session.cookie },
              ),
            ),
        );

        // The owner's own closed vocabulary about this proof, answered as a typed 4xx that names
        // neither the owner rule nor the secret.
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(response.headers.get('content-type')).toContain('application/problem+json');

        const refused = claimTransitionRow(
          yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId),
        );
        expect(refused?.status).toBe('FAILED');
        expect(refused?.outcome_code).toBe('invitation_claim_proof_invalid');
        expect(refused?.result_reference).toBeNull();

        // The invitation is untouched: a wrong secret consumes nothing and claims nobody.
        const invitationRow = yield* readCounterpartyInvitationRow(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );
        expect(invitationRow.lifecycle).toBe('PENDING');
        expect(invitationRow.claimed_by_principal_id).toBeNull();
      }),
    ),
  300_000,
);

it.live(
  'converges a claim retried after its proof was already consumed, without claiming twice',
  () =>
    Effect.scoped(
      Effect.gen(function* convergesARetriedClaim() {
        const { scenario } = yield* invitationScenario({ advanceBinding: 'ACTIVATED' });
        const body = { claimProofReference: scenario.claimProofReference, invitationSecret: scenario.secret };

        const firstAssertion = yield* recipientAssertion(scenario);
        const first = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: firstAssertion,
                cookie: scenario.session.cookie,
              }),
            ),
        );
        expect(first.status).toBe(200);
        const settled = yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId);
        const claims = yield* countCounterpartyInvitationClaims(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );

        // The recipient's client retries the very same claim. The proof is spent, so a route that
        // dispatched again would be refused by the redemption — and would journal that refusal over
        // a transition the journal already proved. Instead the journal answers it.
        const retriedAssertion = yield* recipientAssertion(scenario);
        const retried = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: retriedAssertion,
                cookie: scenario.session.cookie,
              }),
            ),
        );
        expect(retried.status).toBe(200);
        expect(yield* responseBody(retried)).toMatchObject({
          journey: 'COUNTERPARTY_INVITATION',
          portalEnrollmentAttemptId: scenario.attemptId,
        });

        // Byte-identical journal and no second claim mutation on the invitation.
        expect(yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId)).toStrictEqual(settled);
        expect(yield* countCounterpartyInvitationClaims(scenario.fixture, scenario.realm, scenario.invitationId)).toBe(
          claims,
        );
      }),
    ),
  300_000,
);

it.live(
  'answers a claim carrying another customer session exactly as an absent Attempt, recording nothing',
  () =>
    Effect.scoped(
      Effect.gen(function* refusesAForeignClaimant() {
        const { scenario } = yield* invitationScenario({ advanceBinding: 'ACTIVATED' });
        const body = { claimProofReference: scenario.claimProofReference, invitationSecret: scenario.secret };

        // A second customer of this very Tenant, holding its own verifiable assertion and its own
        // live portal session, presenting the Attempt id it happens to know.
        const strangerAssertion = yield* issueAcceptanceGatewayAssertion(
          scenario.fixture.admin,
          scenario.gateway,
          AUDIENCE,
          {
            authBindingId: randomUUID(),
            authContextRef: `portal-session:${randomUUID()}`,
            authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
            authMethod: 'session',
            legalEntityId: scenario.realm.legalEntityId,
            principalId: randomUUID(),
            tenantId: scenario.realm.tenantId,
          },
        );
        const foreign = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: strangerAssertion,
                cookie: scenario.session.cookie,
              }),
            ),
        );
        const absentAssertion = yield* recipientAssertion(scenario);
        const absent = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(randomUUID(), body, {
                assertion: absentAssertion,
                cookie: scenario.session.cookie,
              }),
            ),
        );

        // Non-enumerating: an Attempt this caller may not claim and one that does not exist are
        // answered with the same status and the same body.
        expect(foreign.status).toBe(404);
        expect(absent.status).toBe(404);
        expect(yield* responseBody(foreign)).toStrictEqual(yield* responseBody(absent));

        // Nothing was recorded and nothing was claimed.
        expect(
          claimTransitionRow(yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId)),
        ).toBeUndefined();
        const invitationRow = yield* readCounterpartyInvitationRow(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );
        expect(invitationRow.lifecycle).toBe('PENDING');
        expect(invitationRow.claimed_by_principal_id).toBeNull();
      }),
    ),
  300_000,
);

it.live(
  'refuses a claim whose Principal Auth Binding the journey has reserved but not activated',
  () =>
    Effect.scoped(
      Effect.gen(function* refusesAPendingBinding() {
        const { scenario } = yield* invitationScenario({ advanceBinding: 'RESERVED_ONLY' });

        // The reservation named this caller's binding, so the claimant is recognised; the binding it
        // names is not one anybody can authenticate through yet.
        const operations = yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId);
        expect(operations.map((row) => [row.transition_key, row.status])).toStrictEqual([
          [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, 'SUCCEEDED'],
          [RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY, 'SUCCEEDED'],
        ]);

        const assertion = yield* recipientAssertion(scenario);
        const response = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(
                scenario.attemptId,
                { claimProofReference: scenario.claimProofReference, invitationSecret: scenario.secret },
                { assertion, cookie: scenario.session.cookie },
              ),
            ),
        );

        expect(response.status).toBe(409);
        expect(yield* responseBody(response)).toMatchObject({ code: 'enrollment_binding_pending', status: 409 });

        // The refusal is upstream of every owner effect: nothing is journalled and the invitation
        // keeps its unclaimed secret.
        expect(
          claimTransitionRow(yield* readEnrollmentAcceptanceOperations(scenario.fixture, scenario.attemptId)),
        ).toBeUndefined();
        expect(
          (yield* readCounterpartyInvitationRow(scenario.fixture, scenario.realm, scenario.invitationId)).lifecycle,
        ).toBe('PENDING');
      }),
    ),
  300_000,
);

it.live(
  'converges a claim whose recorded answer was lost, from the invitation the claim committed against',
  () =>
    Effect.scoped(
      Effect.gen(function* convergesALostClaimAnswer() {
        const { scenario } = yield* invitationScenario({ advanceBinding: 'ACTIVATED' });
        const body = { claimProofReference: scenario.claimProofReference, invitationSecret: scenario.secret };

        const firstAssertion = yield* recipientAssertion(scenario);
        const first = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: firstAssertion,
                cookie: scenario.session.cookie,
              }),
            ),
        );
        expect(first.status).toBe(200);
        const claims = yield* countCounterpartyInvitationClaims(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );
        const claimedInvitation = yield* readCounterpartyInvitationRow(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );

        // The claim committed and its answer was lost on the way to the journal: the transition is
        // back to dispatched-under-a-lease-that-has-since-lapsed, which the next claim fences.
        yield* loseCounterpartyInvitationClaimAnswer(
          scenario.fixture,
          scenario.realm,
          scenario.attemptId,
          CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
        );
        expect((yield* claimTransitionFor(scenario))?.status).toBe('IN_PROGRESS');

        const retriedAssertion = yield* recipientAssertion(scenario);
        const retried = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: retriedAssertion,
                cookie: scenario.session.cookie,
              }),
            ),
        );
        expect(retried.status).toBe(200);

        // Settled from the invitation rather than by claiming again: the result reference is the
        // attestation the claim itself stamped, and the reconciliation is journalled as one.
        const settled = yield* claimTransitionFor(scenario);
        expect(settled).toMatchObject({
          outcome_code: 'counterparty_invitation_claimed',
          result_reference: claimedInvitation.claim_proof_reference,
          status: 'SUCCEEDED',
        });
        expect(settled?.reconciliation_ref).not.toBeNull();
        expect(yield* countCounterpartyInvitationClaims(scenario.fixture, scenario.realm, scenario.invitationId)).toBe(
          claims,
        );
        expect(
          yield* readCounterpartyInvitationRow(scenario.fixture, scenario.realm, scenario.invitationId),
        ).toStrictEqual(claimedInvitation);
      }),
    ),
  300_000,
);

it.live(
  'settles a lost claim answer from a continuation pass, with no request from the recipient',
  () =>
    Effect.scoped(
      Effect.gen(function* sweepSettlesALostClaimAnswer() {
        const { scenario } = yield* invitationScenario({ advanceBinding: 'ACTIVATED' });
        const body = { claimProofReference: scenario.claimProofReference, invitationSecret: scenario.secret };

        const assertion = yield* recipientAssertion(scenario);
        const claimed = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, { assertion, cookie: scenario.session.cookie }),
            ),
        );
        expect(claimed.status).toBe(200);
        const claims = yield* countCounterpartyInvitationClaims(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );
        const claimedInvitation = yield* readCounterpartyInvitationRow(
          scenario.fixture,
          scenario.realm,
          scenario.invitationId,
        );

        yield* loseCounterpartyInvitationClaimAnswer(
          scenario.fixture,
          scenario.realm,
          scenario.attemptId,
          CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
        );
        const continuation = yield* sweepingContinuation(scenario);
        const advanced = yield* continuation.advance({
          portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(scenario.attemptId),
          tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(scenario.realm.tenantId),
        });

        expect(advanced.outcome).toBe('COMPLETE');
        expect(yield* claimTransitionFor(scenario)).toMatchObject({
          outcome_code: 'counterparty_invitation_claimed',
          result_reference: claimedInvitation.claim_proof_reference,
          status: 'SUCCEEDED',
        });
        expect(yield* countCounterpartyInvitationClaims(scenario.fixture, scenario.realm, scenario.invitationId)).toBe(
          claims,
        );
      }),
    ),
  300_000,
);

it.live(
  'refuses a claim carrying no Idempotency-Key before it redeems anything, leaving the secret usable',
  () =>
    Effect.scoped(
      Effect.gen(function* refusesAMissingIdempotencyKey() {
        const { scenario } = yield* invitationScenario({ advanceBinding: 'ACTIVATED' });
        const body = { claimProofReference: scenario.claimProofReference, invitationSecret: scenario.secret };

        const keylessAssertion = yield* recipientAssertion(scenario);
        const keyless = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: keylessAssertion,
                cookie: scenario.session.cookie,
                omitIdempotencyKey: true,
              }),
            ),
        );

        // The Action requires the key, so the request is refused where a request defect belongs:
        // upstream of the durable claim, the redemption and the journal.
        expect(keyless.status).toBe(400);
        expect(yield* responseBody(keyless)).toMatchObject({ code: 'invalid_request', status: 400 });
        expect(yield* claimTransitionFor(scenario)).toBeUndefined();
        expect(
          (yield* readCounterpartyInvitationClaimProof(scenario.fixture, scenario.realm, scenario.invitationId))
            .lifecycle,
        ).toBe('ISSUED');

        // The same secret still claims, which is what "nothing was spent" means here.
        const keyedAssertion = yield* recipientAssertion(scenario);
        const keyed = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: keyedAssertion,
                cookie: scenario.session.cookie,
              }),
            ),
        );
        expect(keyed.status).toBe(200);
        expect((yield* claimTransitionFor(scenario))?.status).toBe('SUCCEEDED');
      }),
    ),
  300_000,
);

it.live(
  'answers an Action-core failure after redemption as retryable, and converges on the retry',
  () =>
    Effect.scoped(
      Effect.gen(function* retriesAnActionCoreFailure() {
        const { scenario } = yield* invitationScenario({ advanceBinding: 'ACTIVATED' });
        const body = { claimProofReference: scenario.claimProofReference, invitationSecret: scenario.secret };

        // The Action runtime refuses an unusable correlation, and it refuses it where every
        // Action-core failure lands: after this route has already committed the redemption.
        const refusedAssertion = yield* recipientAssertion(scenario);
        const refused = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: refusedAssertion,
                cookie: scenario.session.cookie,
                omitCorrelationId: true,
              }),
            ),
        );

        // Nothing about the invitation was decided, so nothing about it is journalled: a refusal
        // recorded here would strand an Attempt whose redemption has already committed.
        expect(refused.status).toBe(503);
        expect(yield* responseBody(refused)).toMatchObject({ code: 'enrollment_unavailable', retryable: true });
        expect((yield* claimTransitionFor(scenario))?.status).toBe('IN_PROGRESS');
        expect(
          (yield* readCounterpartyInvitationRow(scenario.fixture, scenario.realm, scenario.invitationId)).lifecycle,
        ).toBe('PENDING');

        yield* expireEnrollmentAcceptanceLeases(scenario.fixture, scenario.attemptId);
        const retriedAssertion = yield* recipientAssertion(scenario);
        const retried = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              claimInvitationRequest(scenario.attemptId, body, {
                assertion: retriedAssertion,
                cookie: scenario.session.cookie,
              }),
            ),
        );

        expect(retried.status).toBe(200);
        expect(yield* claimTransitionFor(scenario)).toMatchObject({
          outcome_code: 'counterparty_invitation_claimed',
          status: 'SUCCEEDED',
        });
        expect(
          (yield* readCounterpartyInvitationRow(scenario.fixture, scenario.realm, scenario.invitationId))
            .claimed_by_principal_id,
        ).toBe(scenario.realm.recipientPrincipalId);
      }),
    ),
  300_000,
);
