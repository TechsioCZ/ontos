import { randomUUID } from 'node:crypto';

import { ActionAuthorizationPreflightDatabaseLive, CorePersistenceLive, DatabaseConfigLive } from '@app/core-runtime';
import { ResendEmailDeliveryConfig } from '@app/email-delivery/resend';
import { eq, sql } from 'drizzle-orm';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
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
import { CommercePortalAuthAccountCreationProviderLive } from '../../api/portal-auth/provider/account-create.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { CommerceCoreIdentityClientLive } from '../../api/portal-auth/provider/core-identity-client.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import { CommercePortalAuthAccountCreationReconciliationLive } from '../../src/portal-auth/persistence/portal-auth-account-creation-reconciliation.ts';
import { portalEnrollmentAttempts } from '../../src/database/schema.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../../src/enrollment/orchestration/owner-transaction-runner.ts';
import { commerceEnrollmentOwnerTransitionPreparationLive } from '../../src/enrollment/orchestration/owner-transition-composition.ts';
import { CommerceEnrollmentPreparationSubjectResolverLive } from '../../src/enrollment/orchestration/preparation-subject.ts';
import {
  CommercePortalAuthDatabaseLive,
  makeCommercePortalAuthDatabase,
} from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { user, verification } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import {
  makeEnrollmentAcceptanceFixture,
  readEnrollmentAcceptanceOperations,
} from '../support/enrollment-acceptance-fixture.ts';
import type { EnrollmentAcceptanceFixture } from '../support/enrollment-acceptance-fixture.ts';
import {
  issueAcceptanceGatewayAssertion,
  makeAcceptanceGatewayIssuer,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import type { AcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import { makeCapturingCounterpartyInvitationProofDelivery } from '../support/counterparty-invitation-proof-capture.ts';
import {
  issueCounterpartyAccessInvitation,
  makeCounterpartyInvitationRealm,
  readCounterpartyInvitationRow,
} from '../support/counterparty-invitation-acceptance.ts';
import type { CounterpartyInvitationRealm } from '../support/counterparty-invitation-acceptance.ts';

/**
 * The claimability gate a COUNTERPARTY_INVITATION start must clear before it spends any budget or
 * creates an Attempt: an unknown invitation is refused with the same non-enumerating answer a
 * consumed or expired one gets, and a real claimable invitation lets the start through to create its
 * Attempt and provider account.
 */

const ORIGIN = 'http://localhost:3020';
const SECRET = 'd'.repeat(64);
const AUDIENCE = 'commerce-customer-context';
const ISSUER = 'http://gateway.enrollment-invitation-claimability.test';
const KEY_ID = 'enrollment-invitation-claimability';
const PORTAL_PASSWORD = 'P'.repeat(24);
const DISPLAY_NAME = 'Counterparty invitation claimability recipient';

const START_ACTION_KEY = 'commerce.customer-context.start-portal-enrollment';
/** A COUNTERPARTY_INVITATION start also runs the claim-transition Action on the Storefront's behalf. */
const CLAIM_TRANSITION_ACTION_KEY = 'commerce.customer-context.claim-portal-enrollment-transition';

const providerDatabaseUrl = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);

/** Resend is answered locally: creation now awaits delivery, so the transport must accept. */
const acceptingResendFetch: typeof fetch = () => Promise.resolve(Response.json({ id: 'accepted' }));

const emailDeliveryConfiguration = Layer.mergeAll(
  Layer.succeed(ResendEmailDeliveryConfig, {
    apiKey: Redacted.make('re_commerce_enrollment_invitation_claimability'),
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

const configuredRealmLive = Effect.fnUntraced(function* configuredRealmLive() {
  const configuration = yield* portalAuthConfiguration();
  return commercePortalAuthRealmLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.succeed(CommercePortalAuthConfig, configuration), emailDeliveryConfiguration),
    ),
  );
});

const preparationAuthorityLive = Effect.fnUntraced(function* preparationAuthorityLive() {
  const configuration = yield* portalAuthConfiguration();
  const coreIdentityConfigurationLive = Layer.succeed(CommerceCoreIdentityClientConfig, {
    apiKey: Redacted.make('enrollment-invitation-claimability-core-identity'),
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

const portalAccountsFor = Effect.fnUntraced(function* portalAccountsFor(email: string) {
  const databaseUrl = yield* providerDatabaseUrl;
  const database = yield* makeCommercePortalAuthDatabase({ connectionString: databaseUrl }).pipe(Effect.orDie);
  return yield* database.executor.select({ id: user.id }).from(user).where(eq(user.email, email)).pipe(Effect.orDie);
});

const removePortalAccountsOnClose = Effect.fnUntraced(function* removePortalAccountsOnClose(email: string) {
  const databaseUrl = yield* providerDatabaseUrl;
  const database = yield* makeCommercePortalAuthDatabase({ connectionString: databaseUrl }).pipe(Effect.orDie);
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

/** How many Attempts this Tenant has, so a refused start can be shown to have created none. */
const countAttemptsForTenant = (fixture: EnrollmentAcceptanceFixture, tenantId: string) =>
  fixture.admin
    .transaction((transaction) =>
      transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(portalEnrollmentAttempts)
        .where(eq(portalEnrollmentAttempts.tenantId, tenantId)),
    )
    .pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.orDie,
    );

const startInvitationRequest = (body: Record<string, string>, assertion: string): Request =>
  new Request(`${ORIGIN}/api/portal-auth/enrollment/start`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${assertion}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      origin: ORIGIN,
      'x-correlation-id': `invitation-claimability-${randomUUID()}`,
    },
    method: 'POST',
  });

const StartedEnrollmentResponseSchema = Schema.Struct({
  attempt: CommercePortalAuthEnrollmentAttemptProjectionSchema,
  outcome: Schema.Literals(['CREATED', 'EXISTING']),
});

const responseBody = (response: Response) => Effect.promise(async () => await response.clone().json());

type DeployedInvitationRuntime = Effect.Success<ReturnType<typeof deployedRuntime>>;

interface ClaimabilityScenario {
  readonly fixture: EnrollmentAcceptanceFixture;
  readonly gateway: AcceptanceGatewayIssuer;
  readonly realm: CounterpartyInvitationRealm;
  readonly runtime: DeployedInvitationRuntime;
  readonly tenantId: string;
}

/** A deployed runtime and a real Counterparty realm, with no invitation issued yet. */
const claimabilityScenario = Effect.fnUntraced(function* claimabilityScenario() {
  const tenantId = randomUUID();
  const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
  const realm = yield* makeCounterpartyInvitationRealm(fixture, {
    recipientActionKeys: [],
    storefrontActionKeys: [START_ACTION_KEY, CLAIM_TRANSITION_ACTION_KEY],
  });
  const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, KEY_ID);
  const runtime = yield* deployedRuntime(gateway);
  const scenario: ClaimabilityScenario = { fixture, gateway, realm, runtime, tenantId };
  return scenario;
});

/** The Storefront client's own assertion: a start on the recipient's behalf carries no Legal Entity. */
const storefrontStartAssertion = (scenario: ClaimabilityScenario) =>
  issueAcceptanceGatewayAssertion(scenario.fixture.admin, scenario.gateway, AUDIENCE, {
    authBindingId: scenario.realm.storefrontAuthBindingId,
    authContextRef: `portal-session:${scenario.realm.storefrontPrincipalId}`,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    principalId: scenario.realm.storefrontPrincipalId,
    tenantId: scenario.tenantId,
  });

it.live(
  'refuses a start naming an invitation id nobody ever issued, without creating an Attempt or account',
  () =>
    Effect.scoped(
      Effect.gen(function* refusesAnUnknownInvitation() {
        const scenario = yield* claimabilityScenario();
        const email = `invitation-claimability-unknown-${randomUUID()}@example.test`;
        yield* removePortalAccountsOnClose(email);
        const before = yield* countAttemptsForTenant(scenario.fixture, scenario.tenantId);

        const assertion = yield* storefrontStartAssertion(scenario);
        const response = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              startInvitationRequest(
                {
                  displayName: DISPLAY_NAME,
                  email,
                  invitationId: randomUUID(),
                  journey: 'COUNTERPARTY_INVITATION',
                  password: PORTAL_PASSWORD,
                  sellingLegalEntityId: scenario.realm.legalEntityId,
                },
                assertion,
              ),
            ),
        );

        expect(response.status).toBe(422);
        expect(yield* responseBody(response)).toMatchObject({ code: 'enrollment_journey_unavailable', status: 422 });

        // No Attempt was created and no provider account was left behind for an invitation that
        // could never have completed.
        expect(yield* countAttemptsForTenant(scenario.fixture, scenario.tenantId)).toBe(before);
        expect(yield* portalAccountsFor(email)).toHaveLength(0);
      }),
    ),
  120_000,
);

it.live(
  'refuses a start naming an invitation another Tenant issued exactly as an unknown one',
  () =>
    Effect.scoped(
      Effect.gen(function* refusesAForeignTenantInvitation() {
        const scenario = yield* claimabilityScenario();
        const foreignFixture = yield* makeEnrollmentAcceptanceFixture({ tenantId: randomUUID() });
        const foreignRealm = yield* makeCounterpartyInvitationRealm(foreignFixture, {
          recipientActionKeys: [],
          storefrontActionKeys: [],
        });
        const capture = makeCapturingCounterpartyInvitationProofDelivery();
        const foreignInvitation = yield* issueCounterpartyAccessInvitation(
          foreignRealm,
          capture,
          `invitation-claimability-foreign-${randomUUID()}@example.test`,
        );
        const email = `invitation-claimability-cross-tenant-${randomUUID()}@example.test`;
        yield* removePortalAccountsOnClose(email);

        const assertion = yield* storefrontStartAssertion(scenario);
        const response = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              startInvitationRequest(
                {
                  displayName: DISPLAY_NAME,
                  email,
                  invitationId: foreignInvitation.invitationId,
                  journey: 'COUNTERPARTY_INVITATION',
                  password: PORTAL_PASSWORD,
                  sellingLegalEntityId: scenario.realm.legalEntityId,
                },
                assertion,
              ),
            ),
        );

        expect(response.status).toBe(422);
        expect(yield* responseBody(response)).toMatchObject({ code: 'enrollment_journey_unavailable', status: 422 });
        expect(yield* portalAccountsFor(email)).toHaveLength(0);

        // The foreign invitation itself is untouched: this Tenant's refusal never reached it.
        const foreignRow = yield* readCounterpartyInvitationRow(
          foreignFixture,
          foreignRealm,
          foreignInvitation.invitationId,
        );
        expect(foreignRow.lifecycle).toBe('PENDING');
      }),
    ),
  120_000,
);

it.live(
  'lets a start proceed for a real, unclaimed, unexpired invitation with a staged proof',
  () =>
    Effect.scoped(
      Effect.gen(function* proceedsForAClaimableInvitation() {
        const scenario = yield* claimabilityScenario();
        const capture = makeCapturingCounterpartyInvitationProofDelivery();
        const email = `invitation-claimability-claimable-${randomUUID()}@example.test`;
        const invitation = yield* issueCounterpartyAccessInvitation(scenario.realm, capture, email);
        yield* removePortalAccountsOnClose(email);

        const assertion = yield* storefrontStartAssertion(scenario);
        const response = yield* Effect.promise(
          async () =>
            await scenario.runtime.handler(
              startInvitationRequest(
                {
                  displayName: DISPLAY_NAME,
                  email,
                  invitationId: invitation.invitationId,
                  journey: 'COUNTERPARTY_INVITATION',
                  password: PORTAL_PASSWORD,
                  sellingLegalEntityId: scenario.realm.legalEntityId,
                },
                assertion,
              ),
            ),
        );

        expect(response.status).toBe(200);
        const started = Schema.decodeUnknownSync(StartedEnrollmentResponseSchema)(yield* responseBody(response));
        expect(started.outcome).toBe('CREATED');

        // The claimability gate having let this through, a real Attempt and provider account exist.
        expect(yield* portalAccountsFor(email)).toHaveLength(1);
        const operations = yield* readEnrollmentAcceptanceOperations(
          scenario.fixture,
          started.attempt.portalEnrollmentAttemptId,
        );
        expect(operations.length).toBeGreaterThan(0);

        // The invitation is still PENDING and unclaimed: the start only reads claimability, it never
        // consumes the invitation itself.
        const invitationRow = yield* readCounterpartyInvitationRow(
          scenario.fixture,
          scenario.realm,
          invitation.invitationId,
        );
        expect(invitationRow.lifecycle).toBe('PENDING');
        expect(invitationRow.claimed_by_principal_id).toBeNull();
      }),
    ),
  120_000,
);
