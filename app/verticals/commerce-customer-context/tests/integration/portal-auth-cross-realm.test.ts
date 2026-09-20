import { randomUUID } from 'node:crypto';

import { ContextAccess, PrincipalResolver } from '@app/core-runtime';
import { ResendEmailDeliveryConfig } from '@app/email-delivery/resend';
import { eq } from 'drizzle-orm';
import { Config, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  commercePortalAuthRealmLive,
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { session as portalSession, user as portalUser } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { AuthConfig, loadAuthConfig } from '../../../../apps/shell-super-app/api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../../../apps/shell-super-app/api/auth/db/client.ts';
import { session as staffSession, user as staffUser } from '../../../../apps/shell-super-app/api/auth/db/schema.ts';
import { makeAuthenticationService } from '../../../../apps/shell-super-app/api/auth/service.ts';
import type { AuthenticationService } from '../../../../apps/shell-super-app/api/auth/service.ts';
import { makePrincipalResolverDouble } from '../../../../apps/shell-super-app/tests/support/identity-service-doubles.ts';

/**
 * Two realms, two audiences, no shared admission. Both realms are the production Better Auth
 * deployments on their own migrated PostgreSQL schemas. Lives in this vertical's owned tests, not
 * in the Shell app: module-contracts keeps `apps/*` generic, and only an owner root may import
 * another realm's private construction source.
 */

const SHELL_ORIGIN = 'http://localhost:3020';
const PORTAL_ORIGIN = 'http://localhost:3020';
const PORTAL_SECRET = 'x'.repeat(64);
const PASSWORD = 'P'.repeat(24);

const providerDatabaseUrl = Config.redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.redacted('DATABASE_URL')),
);

const portalConfiguration = Effect.gen(function* portalConfiguration() {
  const databaseUrl = yield* providerDatabaseUrl;
  return yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: PORTAL_SECRET,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: PORTAL_ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: PORTAL_ORIGIN,
  });
});

const emailDeliveryConfiguration = Layer.succeed(ResendEmailDeliveryConfig, {
  apiKey: Redacted.make('re_commerce_portal_auth_cross_realm_test'),
  endpoint: 'https://api.resend.com/emails',
  from: 'no-reply@commerce.example.test',
});

const allowedContextResults = (keys: readonly string[]) =>
  Effect.succeed(keys.map((key) => ({ decision: 'allowed' as const, key })));

const openContextAccess = Layer.succeed(ContextAccess, {
  legalEntities: ({ legalEntityIds }) => allowedContextResults(legalEntityIds),
  modules: ({ moduleIds }) => allowedContextResults(moduleIds),
  resources: ({ resources }) =>
    allowedContextResults(
      resources.map(({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`),
    ),
  tenants: ({ tenantIds }) => allowedContextResults(tenantIds),
});

const cookieHeader = (setCookieHeaders: readonly string[]): string =>
  setCookieHeaders.map((header) => header.split(';')[0]).join('; ');

/** The customer realm's deployed handler, built from the vertical's own composition root. */
const portalRuntime = Effect.acquireRelease(
  Effect.gen(function* buildPortalRuntime() {
    const configuration = yield* portalConfiguration;
    return makeCommerceCustomerContextApiRuntime(
      productionReadRuntimeLive,
      productionActionRuntimeLive,
      GatewayAssertionRedemptionLive,
      commercePortalAuthRealmLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(Layer.succeed(CommercePortalAuthConfig, configuration), emailDeliveryConfiguration),
        ),
      ),
      Layer.empty,
    ).createHandler();
  }),
  (runtime) => Effect.promise(async () => await runtime.dispose()),
);

interface PortalSession {
  readonly cookie: string;
  readonly email: string;
  readonly userId: string;
}

/** A real customer session: the account is signed up and signed in through the portal realm. */
const makePortalSession = Effect.fnUntraced(function* makePortalSession(
  runtime: Effect.Success<typeof portalRuntime>,
): Effect.fn.Return<PortalSession, unknown, Scope.Scope> {
  const configuration = yield* portalConfiguration;
  const database = yield* makeCommercePortalAuthDatabase(configuration);
  const email = `cross-realm-customer-${randomUUID()}@example.test`;
  const auth = yield* makeCommercePortalAuth({
    configuration,
    databaseAdapter: database.adapter,
    emailDelivery: {
      sendOTP: () => Promise.resolve(),
      sendResetPassword: () => Promise.resolve(),
      sendVerificationEmail: () => Promise.resolve(),
    },
  });
  yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: async () =>
      await auth.api.signUpEmail({
        body: { email, name: 'Cross-realm customer', password: PASSWORD },
        headers: { origin: PORTAL_ORIGIN },
      }),
  });
  const rows = yield* database.executor
    .select({ id: portalUser.id })
    .from(portalUser)
    .where(eq(portalUser.email, email))
    .limit(1);
  const enrolled = rows.at(0);
  if (enrolled === undefined) {
    return yield* Effect.fail(new Error('The cross-realm customer account was not persisted'));
  }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* removeCustomer() {
      yield* database.executor.delete(portalSession).where(eq(portalSession.userId, enrolled.id));
      yield* database.executor.delete(portalUser).where(eq(portalUser.id, enrolled.id));
    }).pipe(Effect.orDie),
  );
  // The realm refuses an unverified sign-in; this fixture completes verification directly rather
  // than replaying the recovery transport, which `portal-auth-recovery.test.ts` already proves.
  yield* database.executor.update(portalUser).set({ emailVerified: true }).where(eq(portalUser.id, enrolled.id));
  const signIn = yield* Effect.promise(
    async () =>
      await runtime.handler(
        new Request(`${PORTAL_ORIGIN}/api/portal-auth/sign-in/email`, {
          body: JSON.stringify({ email, password: PASSWORD }),
          headers: { 'content-type': 'application/json', origin: PORTAL_ORIGIN },
          method: 'POST',
        }),
      ),
  );
  const issued = signIn.headers.getSetCookie();
  if (signIn.status !== 200 || issued.length === 0) {
    return yield* Effect.fail(
      new Error(`The cross-realm customer sign-in did not issue a session (${String(signIn.status)})`),
    );
  }
  return { cookie: cookieHeader(issued), email, userId: enrolled.id };
});

interface StaffSession {
  readonly cookie: string;
  readonly email: string;
}

/**
 * A real staff session in the Shell realm. The principal resolution seam is a double: what
 * crosses the realm boundary is the cookie, issued by the real Shell Better Auth instance.
 */
const makeStaffSession = Effect.fnUntraced(function* makeStaffSession(
  authentication: typeof AuthenticationService.Service,
  database: Effect.Success<ReturnType<typeof makeAuthDatabase>>,
): Effect.fn.Return<StaffSession, unknown, Scope.Scope> {
  const email = `cross-realm-staff-${randomUUID()}@example.test`;
  const userId = yield* authentication.createFixtureUser(email, 'Cross-realm staff', Redacted.make(PASSWORD));
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* removeStaff() {
      yield* database.executor.delete(staffSession).where(eq(staffSession.userId, userId));
      yield* database.executor.delete(staffUser).where(eq(staffUser.id, userId));
    }).pipe(Effect.orDie),
  );
  const signedIn = yield* authentication.signIn(email, Redacted.make(PASSWORD), new Headers({ origin: SHELL_ORIGIN }));
  if (signedIn.setCookieHeaders.length === 0) {
    return yield* Effect.fail(new Error('The Shell realm issued no staff session cookie'));
  }
  return { cookie: cookieHeader(signedIn.setCookieHeaders), email };
});

const shellAuthentication = Effect.fnUntraced(function* shellAuthentication() {
  const configuration = yield* loadAuthConfig();
  const database = yield* makeAuthDatabase(configuration);
  const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
    Effect.provideService(AuthConfig, configuration),
    Effect.provideService(AuthDatabase, database),
    Effect.provideService(
      PrincipalResolver,
      makePrincipalResolverDouble({
        resolveDefaultBetterAuthUser: () =>
          Effect.succeed({
            authBindingId: randomUUID(),
            displayName: 'Cross-realm staff',
            principalId: randomUUID(),
            principalKind: 'human' as const,
            tenantId: randomUUID(),
          }),
      }),
    ),
  );
  return { authentication, database };
});

it.live('refuses a staff Shell session presented to the Commerce portal realm', () =>
  Effect.scoped(
    Effect.gen(function* staffSessionAtCommerceRealm() {
      const runtime = yield* portalRuntime;
      const shell = yield* shellAuthentication();
      const staff = yield* makeStaffSession(shell.authentication, shell.database);

      const answer = yield* Effect.promise(
        async () =>
          await runtime.handler(
            new Request(`${PORTAL_ORIGIN}/api/portal-auth/get-session`, {
              headers: { cookie: staff.cookie, origin: PORTAL_ORIGIN },
            }),
          ),
      );
      const body: unknown = yield* Effect.promise(async () => await answer.clone().json());

      // The Commerce realm may answer "anonymous" or refuse outright, but it must never admit a
      // session another realm issued, and it must never mint one of its own from it.
      expect([200, 401, 403]).toContain(answer.status);
      if (answer.status === 200) {
        expect(body).toStrictEqual({ state: 'anonymous' });
      }
      expect(answer.headers.getSetCookie()).toStrictEqual([]);
    }),
  ),
);

it.live('refuses a Commerce portal session presented to the staff Shell realm', () =>
  Effect.scoped(
    Effect.gen(function* customerSessionAtShellRealm() {
      const runtime = yield* portalRuntime;
      const shell = yield* shellAuthentication();
      const customer = yield* makePortalSession(runtime);

      const current = yield* shell.authentication
        .currentSession(new Headers({ cookie: customer.cookie, origin: SHELL_ORIGIN }))
        .pipe(Effect.provide(openContextAccess));

      // The staff realm does not know this token: it resolves no identity and grants no admission.
      expect(current.identity).toBeNull();
    }),
  ),
);
