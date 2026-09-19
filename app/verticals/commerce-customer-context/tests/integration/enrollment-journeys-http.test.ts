import { randomUUID } from 'node:crypto';

import { ActionAuthorizationPreflightDatabaseLive, CorePersistenceLive, DatabaseConfigLive } from '@app/core-runtime';
import { ResendEmailDeliveryConfig } from '@app/email-delivery/resend';
import { eq } from 'drizzle-orm';
import { Config, Context, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  commercePortalAuthRealmLive,
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { CommercePortalAuthAccountCreationRejected } from '../../api/portal-auth/provider/account-creation-rejected.ts';
import { CommercePortalAuthAccountCreationService } from '../../api/portal-auth/provider/account-creation-service.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../../api/portal-auth/provider/account-creation-unavailable.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { CommerceCoreIdentityClientLive } from '../../api/portal-auth/provider/core-identity-client.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
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
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
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
import { user } from '../../src/portal-auth/persistence/portal-auth-tables.ts';

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
