import {
  ContextAccess,
  DatabaseIdentityEnrollmentContext,
  LegalEntityContext,
  PrincipalResolver,
  SHARED_RUNTIME_IDENTITY,
  makeLegalEntityContext,
  makePrincipalResolver,
} from '@app/core-runtime';
import type {
  DatabaseIdentityConnections,
  DatabaseIdentityEnrollment,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService } from '@app/core-runtime/access/enforcement';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { DATABASE_IDENTITIES } from '../../../../database/identity-enrollment.ts';
import { bootstrapRuntimeRoles } from '../../../../scripts/postgres/runtime-role-bootstrap.mts';
import { AuthConfig, parseAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { session, user } from '../../api/auth/db/schema.ts';
import { makeShellTestAuthentication } from './shell-authentication.ts';

export class NativeHumanSessionFixtureError extends Schema.TaggedError<NativeHumanSessionFixtureError>()(
  'NativeHumanSessionFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) =>
  new NativeHumanSessionFixtureError({
    cause: Redacted.make(cause),
    reason: 'The isolated native human session fixture is unavailable',
  });
export interface NativeHumanSessionIdentity {
  readonly authBindingId: string;
  readonly principal: TrustedPrincipalContext;
  readonly providerSubjectId: string;
  readonly sessionId: string;
}
export interface NativeHumanSessionHandle {
  readonly authenticate: (
    expected?: NativeHumanSessionExpectation,
  ) => Effect.Effect<NativeHumanSessionIdentity, NativeHumanSessionFixtureError>;
  readonly authenticateTenant: () => Effect.Effect<NativeHumanSessionIdentity, NativeHumanSessionFixtureError>;
  readonly revokeBinding: () => Effect.Effect<void, NativeHumanSessionFixtureError>;
  readonly signOut: () => Effect.Effect<void, NativeHumanSessionFixtureError>;
}
export interface NativeHumanSessionExpectation {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
export interface NativeHumanSessionInput extends NativeHumanSessionExpectation {
  readonly displayName: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
export interface NativeHumanSessionProviderOptions {
  readonly accessDecision: AccessDecisionService;
  readonly bindHumanProviderSubject: (input: {
    readonly authenticationNamespaceId: string;
    readonly principalId: string;
    readonly providerSubjectId: string;
    readonly tenantId: string;
    readonly verifyProviderSubject: Effect.Effect<void, NativeHumanSessionFixtureError>;
  }) => Effect.Effect<{ readonly authBindingId: string }, NativeHumanSessionFixtureError>;
  readonly connections: DatabaseIdentityConnections;
  readonly contextAccess: (typeof ContextAccess)['Service'];
  readonly coreDatabase: (typeof CoreDatabase)['Service'];
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly revokeBinding: (authBindingId: string) => Effect.Effect<void, NativeHumanSessionFixtureError>;
}
export interface NativeHumanSessionProvider {
  readonly create: (
    input: NativeHumanSessionInput,
  ) => Effect.Effect<NativeHumanSessionHandle, NativeHumanSessionFixtureError>;
}

/** No ambient environment or shared database is accepted by this public TEST-only constructor. */
export const validateNativeHumanSessionConnections = Effect.fn('NativeHumanSessions.validateConnections')(
  function* validate(connections: DatabaseIdentityConnections) {
    const { admin } = connections;
    const runtime = connections.runtime[SHARED_RUNTIME_IDENTITY.id];
    if (
      runtime === undefined ||
      !['127.0.0.1', 'localhost'].includes(admin.host) ||
      !/^action_live_v2_[\da-f]{32}$/u.test(admin.database) ||
      runtime.host !== admin.host ||
      runtime.port !== admin.port ||
      runtime.database !== admin.database ||
      runtime.expectedRole !== SHARED_RUNTIME_IDENTITY.role ||
      admin.expectedRole === runtime.expectedRole ||
      Object.values(connections.runtime).some(
        (connection) =>
          connection.database !== admin.database || connection.host !== admin.host || connection.port !== admin.port,
      )
    ) {
      return yield* unavailable();
    }
    return runtime;
  },
);

const installAuth = Effect.fn('NativeHumanSessions.installAuth')(function* install(
  options: NativeHumanSessionProviderOptions,
  migrationsDirectory: URL,
) {
  const fs = yield* FileSystem.FileSystem;
  const client = yield* PgClient.makeClient({ url: Redacted.make(options.connections.admin.connectionString) });
  const root = migrationsDirectory;
  if (root.protocol !== 'file:') {
    return yield* unavailable();
  }
  const directories = (yield* fs.readDirectory(root.pathname)).toSorted();
  let count = 0;
  for (const directory of directories) {
    const file = new URL(`${directory}/migration.sql`, root).pathname;
    if (!(yield* fs.exists(file))) {
      continue;
    }
    for (const sql of (yield* fs.readFileString(file)).split('--> statement-breakpoint')) {
      if (sql.trim().length > 0) {
        yield* client.unsafe(sql).pipe(Effect.mapError(unavailable));
      }
    }
    count += 1;
  }
  if (count !== 11) {
    return yield* unavailable();
  }
  const passwords = new Map<string, Redacted.Redacted>();
  for (const identity of DATABASE_IDENTITIES) {
    const configuration = options.connections.runtime[identity.id];
    if (configuration === undefined) {
      return yield* unavailable();
    }
    const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(configuration.connectionString).pipe(
      Effect.mapError(unavailable),
    );
    const password = yield* Effect.try({ catch: unavailable, try: () => decodeURIComponent(url.password) });
    passwords.set(identity.role, Redacted.make(password));
  }
  yield* bootstrapRuntimeRoles(client, options.connections, passwords, 'reconcile').pipe(Effect.mapError(unavailable));
  return yield* Effect.void;
}, Effect.mapError(unavailable));

/** Real Shell framework, native adapter, provider session and Core binding resolution, never gateway provenance. */
export const makeNativeHumanSessionProvider = Effect.fn('NativeHumanSessions.make')(function* makeProvider(
  options: NativeHumanSessionProviderOptions,
  migrationsDirectory: URL,
): Effect.fn.Return<
  NativeHumanSessionProvider,
  NativeHumanSessionFixtureError,
  Crypto.Crypto | FileSystem.FileSystem | Scope.Scope
> {
  const runtime = yield* validateNativeHumanSessionConnections(options.connections);
  yield* installAuth(options, migrationsDirectory).pipe(Effect.provide(Reactivity.layer));
  const crypto = yield* Crypto.Crypto;
  const secret = `${yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable))}${yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable))}`;
  const configuration = yield* parseAuthConfig({
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: 'http://localhost',
    DATABASE_URL: runtime.connectionString,
  }).pipe(Effect.mapError(unavailable));
  const authDatabase = yield* makeAuthDatabase(runtime).pipe(Effect.mapError(unavailable));
  const resolver = makePrincipalResolver(options.coreDatabase, {
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
  });
  const base = Layer.mergeAll(
    Layer.succeed(AuthConfig, configuration),
    Layer.succeed(AuthDatabase, authDatabase),
    Layer.succeed(CoreDatabase, options.coreDatabase),
    Layer.succeed(DatabaseIdentityEnrollmentContext, options.enrollment),
    Layer.succeed(PrincipalResolver, resolver),
  );
  const authentication = yield* makeShellTestAuthentication({ allowFixtureSignUp: true }).pipe(
    Effect.provide(base),
    Effect.mapError(unavailable),
  );
  const access = Layer.mergeAll(
    Layer.succeed(AccessDecisionGate, options.accessDecision),
    Layer.succeed(ContextAccess, options.contextAccess),
    Layer.succeed(LegalEntityContext, makeLegalEntityContext(options.coreDatabase)),
  );
  const create = Effect.fn('NativeHumanSessions.create')(function* createHuman(input: NativeHumanSessionInput) {
    const suffix = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const password = Redacted.make(
      `${yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable))}${yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable))}`,
    );
    const email = `native-session-${suffix}@example.invalid`;
    const providerSubjectId = yield* authentication
      .createFixtureUser(email, input.displayName, password)
      .pipe(Effect.mapError(unavailable));
    const binding = yield* options.bindHumanProviderSubject({
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      principalId: input.principalId,
      providerSubjectId,
      tenantId: input.tenantId,
      verifyProviderSubject: authDatabase.executor
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.id, providerSubjectId), eq(user.email, email)))
        .pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((found) =>
            found.length === 1 && found[0]?.id === providerSubjectId ? Effect.void : Effect.fail(unavailable()),
          ),
        ),
    });
    const signedIn = yield* authentication
      .signIn(email, password, new Headers({ origin: configuration.baseUrl }))
      .pipe(Effect.mapError(unavailable));
    const cookies = Redacted.make(signedIn.setCookieHeaders.map((cookie) => cookie.split(';')[0]).join('; '));
    const headers = () => new Headers({ cookie: Redacted.value(cookies), origin: configuration.baseUrl });
    const authenticate = Effect.fn('NativeHumanSessions.authenticate')(function* authenticateHuman(
      expected: NativeHumanSessionExpectation = input,
    ) {
      const resolved = yield* authentication
        .resolveShellContext(headers())
        .pipe(Effect.provide(access), Effect.mapError(unavailable));
      if (resolved.state !== 'authenticated') {
        return yield* unavailable();
      }
      const { principal } = resolved;
      if (
        principal.authMethod !== 'session' ||
        principal.authenticationNamespaceId !== STAFF_AUTHENTICATION_NAMESPACE_ID ||
        principal.tenantId !== input.tenantId ||
        principal.principalId !== input.principalId ||
        principal.authBindingId !== binding.authBindingId ||
        principal.legalEntityId !== input.legalEntityId ||
        principal.tenantId !== expected.tenantId ||
        principal.principalId !== expected.principalId ||
        principal.legalEntityId !== expected.legalEntityId ||
        principal.authContextRef === undefined ||
        !principal.authContextRef.startsWith('better-auth-session:')
      ) {
        return yield* unavailable();
      }
      const sessionId = principal.authContextRef.slice('better-auth-session:'.length);
      const [persisted] = yield* authDatabase.executor
        .select({
          activeLegalEntityId: session.activeLegalEntityId,
          activeTenantId: session.activeTenantId,
          expiresAt: session.expiresAt,
        })
        .from(session)
        .where(and(eq(session.id, sessionId), eq(session.userId, providerSubjectId)))
        .pipe(Effect.mapError(unavailable));
      const now = yield* DateTime.nowAsDate;
      if (
        persisted === undefined ||
        persisted.expiresAt <= now ||
        persisted.activeTenantId !== input.tenantId ||
        persisted.activeLegalEntityId !== input.legalEntityId
      ) {
        return yield* unavailable();
      }
      return { authBindingId: binding.authBindingId, principal, providerSubjectId, sessionId };
    });
    const originalIdentity = yield* authenticate();
    const authenticateTenant = Effect.fn('NativeHumanSessions.authenticateTenant')(function* authenticateTenantHuman() {
      const resolved = yield* authentication
        .resolveTenantContext(headers())
        .pipe(Effect.provide(access), Effect.mapError(unavailable));
      if (resolved.state !== 'authenticated') {
        return yield* unavailable();
      }
      const { principal } = resolved;
      if (
        principal.authMethod !== 'session' ||
        principal.authenticationNamespaceId !== STAFF_AUTHENTICATION_NAMESPACE_ID ||
        principal.tenantId !== input.tenantId ||
        principal.principalId !== input.principalId ||
        principal.authBindingId !== binding.authBindingId ||
        principal.legalEntityId !== undefined ||
        principal.authContextRef !== `better-auth-session:${originalIdentity.sessionId}` ||
        resolved.identity.tenantId !== input.tenantId ||
        resolved.identity.principalId !== input.principalId
      ) {
        return yield* unavailable();
      }
      const sessionId = principal.authContextRef.slice('better-auth-session:'.length);
      const [persisted] = yield* authDatabase.executor
        .select({ activeTenantId: session.activeTenantId, expiresAt: session.expiresAt })
        .from(session)
        .where(and(eq(session.id, sessionId), eq(session.userId, providerSubjectId)))
        .pipe(Effect.mapError(unavailable));
      if (
        persisted === undefined ||
        persisted.expiresAt <= (yield* DateTime.nowAsDate) ||
        persisted.activeTenantId !== input.tenantId
      ) {
        return yield* unavailable();
      }
      return {
        authBindingId: principal.authBindingId,
        principal,
        providerSubjectId,
        sessionId,
      };
    });
    return {
      authenticate,
      authenticateTenant,
      revokeBinding: () => options.revokeBinding(binding.authBindingId),
      signOut: () => authentication.signOut(headers()).pipe(Effect.asVoid, Effect.mapError(unavailable)),
    };
  }, Effect.mapError(unavailable));
  return { create };
});
