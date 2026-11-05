import {
  ActionRuntime,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  LegalEntityContext,
  LegalEntityContextLive,
  PrincipalResolver,
  PrincipalResolverLive,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
  parseDatabaseConfig,
} from '@app/core-runtime';
import type { LegalEntityContextService, OperationalScope } from '@app/core-runtime';
import { makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  AuthBindingIdSchema,
  PrincipalIdSchema,
  ProviderSubjectIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { NodeCrypto, NodeRuntime, NodeServices, NodeSink, NodeStream } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { createReadStream, createWriteStream } from 'node:fs';
import { inspect } from 'node:util';
import { finished } from 'node:stream/promises';
import { Cause, Config, Context, Crypto, Effect, Layer, Logger, Redacted, Schema, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

const protocol = 'ontos.shell.preproposal-basis.identity.v1' as const;

const CommandSchema = Schema.Union([
  Schema.Struct({
    buyerPrincipalId: PrincipalIdSchema,
    operation: Schema.Literal('CREATE_SERVICE_KEYS'),
    protocol: Schema.Literal(protocol),
    tenantId: TenantIdSchema,
  }).annotate({ parseOptions: { onExcessProperty: 'error' } }),
  Schema.Struct({ operation: Schema.Literal('STOP'), protocol: Schema.Literal(protocol) }).annotate({
    parseOptions: { onExcessProperty: 'error' },
  }),
]);
const identity = {
  authBindingId: AuthBindingIdSchema,
  principalId: PrincipalIdSchema,
  secret: Schema.RedactedFromValue(Schema.String),
};
// A module deployment credential is a service principal's managed key plus the provider key id the Shell binds it by.
const moduleServiceIdentity = Schema.Struct({ ...identity, providerKeyId: ProviderSubjectIdSchema });
// The buyer's actual signed-in Shell sessions, one with its Legal Entity selected and one in the Tenant only: a
// module that relays the buyer's request assertion has it rechecked against the live session it names.
const humanSessions = Schema.Struct({
  legalEntity: Schema.Struct({ authContextRef: Schema.String, legalEntityId: LegalEntityIdSchema }),
  tenant: Schema.Struct({ authContextRef: Schema.String }),
});
const ResponseSchema = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal('PROVIDER_USER_CREATED'),
    protocol: Schema.Literal(protocol),
    providerUserId: ProviderSubjectIdSchema,
  }),
  Schema.Struct({
    buyer: Schema.Struct(identity),
    buyerPrincipalId: PrincipalIdSchema,
    buyerSessions: humanSessions,
    catalog: moduleServiceIdentity,
    cccReader: moduleServiceIdentity,
    marketRelay: moduleServiceIdentity,
    operation: Schema.Literal('SERVICE_KEYS_CREATED'),
    pricingIssuer: moduleServiceIdentity,
    protocol: Schema.Literal(protocol),
    tenantId: TenantIdSchema,
  }),
  Schema.Struct({ operation: Schema.Literal('STOPPED'), protocol: Schema.Literal(protocol) }),
]);

class PreproposalIdentityUnavailable extends Schema.TaggedError<PreproposalIdentityUnavailable>()(
  'PreproposalIdentityUnavailable',
  { stage: Schema.String },
) {}
const unavailable = (stage: string) => new PreproposalIdentityUnavailable({ stage });

/** The companies the select check answers with: the Tenant's own active ones (O28). */
const tenantCompaniesOf =
  (legalEntityContext: LegalEntityContextService) => (input: { readonly scope: OperationalScope }) =>
    legalEntityContext.listActiveForTenant(input.scope.tenantId).pipe(
      Effect.map((entities) => entities.map((entity) => LegalEntityIdSchema.make(entity.legalEntityId))),
      Effect.orDie,
    );

/**
 * The owned database carries no v2 access intent, so the gate is scripted like the Core fixture's own
 * (`access: 'allowed'`), as the other Shell native children do: every capability is ALLOWED and the
 * selectable companies are the Tenant's own active ones.
 */
const scriptedIdentityAccessGate = Layer.unwrap(
  Effect.gen(function* scriptedIdentityAccessGateLayers() {
    const legalEntityContext = yield* LegalEntityContext;
    const scripted = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
    return makeTestAccessGateLayers({
      scopeAccess: { decide: scripted.decide, selectableLegalEntities: tenantCompaniesOf(legalEntityContext) },
      spec: { defaultAnswer: { outcome: 'ALLOWED' } },
    });
  }),
);
const describe = Effect.sync(() =>
  process.stdout.write(
    `${JSON.stringify({
      marker: ultramodernDeliveryUnit,
      operations: ['PROVIDER_USER_CREATED', 'CREATE_SERVICE_KEYS', 'STOP'],
      protocol,
      type: 'description',
    })}\n`,
  ),
);

/**
 * Parent must create the disposable database through Core's creator-owned native fixture and
 * provide its exact catalog identity privately. No identity table or binding is written here.
 * All provider mechanics remain in Shell and all canonical identity writes use Core Actions.
 */
export const serve = Effect.scoped(
  Effect.gen(function* servePreproposalIdentity() {
    const configuration = yield* Config.all({
      authOrigin: Config.String('BETTER_AUTH_URL'),
      authSecret: Config.Redacted('BETTER_AUTH_SECRET'),
      databaseOid: Config.Int('ONTOS_PREPROPOSAL_DATABASE_OID'),
      databaseOwner: Config.String('ONTOS_PREPROPOSAL_DATABASE_OWNER'),
      databaseUrl: Config.Redacted('DATABASE_URL'),
      expectedDatabase: Config.String('ONTOS_PREPROPOSAL_OWNED_DATABASE'),
      sourceDatabase: Config.String('ONTOS_PREPROPOSAL_SOURCE_DATABASE'),
    });
    const databaseConfig = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(configuration.databaseUrl) });
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseConfig.host) ||
      databaseConfig.user !== 'ontos_runtime' ||
      !/^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(configuration.expectedDatabase) ||
      databaseConfig.database !== configuration.expectedDatabase ||
      databaseConfig.database === configuration.sourceDatabase ||
      configuration.databaseOwner === databaseConfig.user
    ) {
      return yield* unavailable('creator-owned-route');
    }
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: configuration.databaseUrl }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const identityRows = yield* client
      .unsafe(`select current_database() as database, current_user as role,
      d.oid::integer as oid, pg_get_userbyid(d.datdba) as owner, r.rolsuper or r.rolbypassrls as unsafe
      from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.rolname=current_user
      where d.datname=current_database()`)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Tuple([
              Schema.Struct({
                database: Schema.String,
                oid: Schema.Int,
                owner: Schema.String,
                role: Schema.String,
                unsafe: Schema.Boolean,
              }),
            ]),
          ),
        ),
      );
    const [observed] = identityRows;
    if (
      observed.database !== configuration.expectedDatabase ||
      observed.oid !== configuration.databaseOid ||
      observed.owner !== configuration.databaseOwner ||
      observed.role !== databaseConfig.user ||
      observed.unsafe
    ) {
      return yield* unavailable('creator-owned-catalog-identity');
    }
    // Private runtime imports are lazy: metadata discovery never loads Auth or constructs pools.
    const { AuthConfig, parseAuthConfig } = yield* Effect.tryPromise({
      catch: () => unavailable('auth-config-import'),
      try: async () => await import('../../api/auth/config.ts'),
    });
    const { AuthDatabase, makeAuthDatabase } = yield* Effect.tryPromise({
      catch: () => unavailable('auth-database-import'),
      try: async () => await import('../../api/auth/db/client.ts'),
    });
    const { makeAuthenticationService } = yield* Effect.tryPromise({
      catch: () => unavailable('authentication-import'),
      try: async () => await import('../../api/auth/service.ts'),
    });
    const { makeApiKeyService } = yield* Effect.tryPromise({
      catch: () => unavailable('key-provider-import'),
      try: async () => await import('../../api/auth/api-key-service.ts'),
    });
    const { makeIdentityLifecycleService } = yield* Effect.tryPromise({
      catch: () => unavailable('identity-lifecycle-import'),
      try: async () => await import('../../api/auth/identity-lifecycle.ts'),
    });
    const authConfiguration = yield* parseAuthConfig({
      BETTER_AUTH_SECRET: Redacted.value(configuration.authSecret),
      BETTER_AUTH_URL: configuration.authOrigin,
      DATABASE_URL: Redacted.value(configuration.databaseUrl),
      NODE_ENV: 'test',
    });
    const authDatabase = yield* makeAuthDatabase(authConfiguration);
    const persistence = CorePersistenceLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, databaseConfig)));
    const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
    const gate = ModuleStateGateLive.pipe(Layer.provide(states));
    const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
    // The one access gate of this composition: the scope resolver and both runtimes ask it, so the
    // fixture builds it once and shares it, exactly as the Shell root does.
    const accessEnforcement = scriptedIdentityAccessGate.pipe(
      Layer.provide(LegalEntityContextLive.pipe(Layer.provide(persistence))),
    );
    const scopes = OperationalScopeResolverLive.pipe(
      Layer.provide(Layer.mergeAll(persistence, ContextAccessLive, accessEnforcement)),
    );
    const resolver = PrincipalResolverLive({ authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID }).pipe(
      Layer.provide(persistence),
    );
    const composition = ActiveApplicationCompositionConfigLive.pipe(
      Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer))),
    );
    const common = Layer.mergeAll(
      ContextAccessLive,
      accessEnforcement,
      LegalEntityContextLive.pipe(Layer.provide(persistence)),
      composition,
      staffAuthenticationNamespaceRegistryLayer(['shell-super-app']),
    );
    const actions = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
      Layer.provide(
        Layer.mergeAll(
          persistence,
          gate,
          gateway,
          scopes,
          ContextAccessLive,
          accessEnforcement,
          ActionPermissionLive,
          ActionRepositoryLive,
          staffAuthenticationNamespaceRegistryLayer(['shell-super-app']),
        ),
      ),
    );
    const runtime = yield* Layer.build(Layer.mergeAll(actions.pipe(Layer.provide(common)), resolver, common));
    const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
      Effect.provideService(AuthConfig, authConfiguration),
      Effect.provideService(AuthDatabase, authDatabase),
      Effect.provideContext(runtime),
    );
    const keys = yield* makeApiKeyService().pipe(
      Effect.provideService(AuthConfig, authConfiguration),
      Effect.provideService(AuthDatabase, authDatabase),
    );
    const lifecycle = makeIdentityLifecycleService(
      Context.get(runtime, ActionRuntime),
      keys,
      Context.get(runtime, PrincipalResolver),
    );
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const email = `preproposal-${suffix}@fixture.invalid`;
    const password = Redacted.make(`${yield* crypto.randomUUIDv4()}${yield* crypto.randomUUIDv4()}`);
    const providerUserId = yield* authentication.createFixtureUser(email, 'Preproposal native human buyer', password);
    const output = yield* Effect.acquireRelease(
      Effect.sync(() => createWriteStream('', { autoClose: false, fd: 3 })),
      (stream) =>
        Effect.tryPromise(async () => {
          const completion = finished(stream, { cleanup: true });
          stream.end();
          await completion;
        }).pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => stream.destroy()))),
    );
    const send = <Frame extends Pick<typeof ResponseSchema.Type, 'operation' | 'protocol'>>(response: Frame) =>
      Schema.encodeUnknownEffect(Schema.fromJsonString(ResponseSchema))(response).pipe(
        Effect.flatMap((line) =>
          Stream.make(`${line}\n`).pipe(
            Stream.run(
              NodeSink.fromWritable({
                endOnDone: false,
                evaluate: () => output,
                onError: () => unavailable('private-output'),
              }),
            ),
          ),
        ),
      );
    yield* send({ operation: 'PROVIDER_USER_CREATED', protocol, providerUserId });
    let created = false;
    let stopped = false;
    yield* NodeStream.fromReadable({
      evaluate: () => createReadStream('', { autoClose: false, fd: 4 }),
      onError: () => unavailable('private-input'),
    }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect((line) =>
        line.length > 65_536
          ? Effect.fail(unavailable('command-size'))
          : Schema.decodeUnknownEffect(Schema.fromJsonString(CommandSchema))(line).pipe(
              Effect.mapError(() => unavailable('command-codec')),
            ),
      ),
      Stream.takeUntil((command) => command.operation === 'STOP'),
      Stream.runForEach((command) =>
        Effect.gen(function* executeIdentityCommand() {
          if (command.operation === 'STOP') {
            stopped = true;
            return yield* send({ operation: 'STOPPED', protocol });
          }
          if (created) {
            return yield* unavailable('single-setup-command');
          }
          created = true;
          const session = yield* authentication
            .signIn(email, password, new Headers({ origin: authConfiguration.baseUrl }))
            .pipe(Effect.provideContext(runtime));
          if (
            session.identity.principalId !== command.buyerPrincipalId ||
            session.identity.tenantId !== command.tenantId
          ) {
            return yield* unavailable('actual-human-session');
          }
          const headers = new Headers({
            cookie: session.setCookieHeaders.map((value) => value.split(';')[0]).join('; '),
            origin: authConfiguration.baseUrl,
          });
          const resolved = yield* authentication.resolveShellContext(headers).pipe(Effect.provideContext(runtime));
          if (resolved.state !== 'authenticated' || resolved.principal.principalId !== command.buyerPrincipalId) {
            return yield* unavailable('actual-operator-context');
          }
          const { principal } = resolved;
          if (principal.authContextRef === undefined || principal.legalEntityId === undefined) {
            return yield* unavailable('actual-operator-session');
          }
          const buyerKey = yield* lifecycle.issue({
            correlationId: `${suffix}:buyer:key`,
            idempotencyKey: `${suffix}:buyer:key`,
            name: 'Preproposal original buyer',
            principal,
            requestHeaders: headers,
          });
          if (buyerKey.cleanupPending) {
            return yield* unavailable('buyer-self-binding');
          }
          const verifiedBuyer = yield* keys.verify(Redacted.value(buyerKey.secret));
          const boundBuyer = yield* Context.get(runtime, PrincipalResolver).resolveBetterAuthApiKey(
            verifiedBuyer.providerKeyId,
          );
          if (
            boundBuyer.principalId !== principal.principalId ||
            boundBuyer.tenantId !== principal.tenantId ||
            boundBuyer.authBindingId !== buyerKey.authBindingId
          ) {
            return yield* unavailable('original-buyer-provider-binding');
          }
          const produceService = Effect.fn('PreproposalIdentity.produceService')(function* produceService(
            name: string,
          ) {
            const createdService = yield* lifecycle.createNonHumanPrincipal({
              correlationId: `${suffix}:${name}:create`,
              idempotencyKey: `${suffix}:${name}:create`,
              payload: { displayName: `Preproposal ${name}`, kind: 'service' },
              principal,
            });
            const key = yield* lifecycle.issue({
              correlationId: `${suffix}:${name}:key`,
              idempotencyKey: `${suffix}:${name}:key`,
              managedPrincipalId: createdService.principalId,
              name,
              principal,
              requestHeaders: headers,
            });
            if (createdService.principalId === principal.principalId || key.cleanupPending) {
              return yield* unavailable('managed-service-binding');
            }
            const verified = yield* keys.verify(Redacted.value(key.secret));
            return {
              authBindingId: key.authBindingId,
              principalId: createdService.principalId,
              providerKeyId: verified.providerKeyId,
              secret: key.secret,
            };
          });
          const cccReader = yield* produceService('ccc-reader');
          const pricingIssuer = yield* produceService('pricing-issuer');
          const catalog = yield* produceService('catalog');
          const marketRelay = yield* produceService('market-relay');
          // A second sign-in stays in the Tenant: no Legal Entity is selected on that session.
          const tenantSession = yield* authentication.signIn(
            email,
            password,
            new Headers({ origin: authConfiguration.baseUrl }),
          );
          const tenantContext = yield* authentication.resolveTenantContext(
            new Headers({
              cookie: tenantSession.setCookieHeaders.map((value) => value.split(';')[0]).join('; '),
              origin: authConfiguration.baseUrl,
            }),
          );
          if (
            tenantContext.state !== 'authenticated' ||
            tenantContext.principal.principalId !== principal.principalId ||
            tenantContext.principal.legalEntityId !== undefined ||
            tenantContext.principal.authContextRef === undefined
          ) {
            return yield* unavailable('actual-tenant-session');
          }
          const servicePrincipals = [cccReader, pricingIssuer, catalog, marketRelay].map(
            (service) => service.principalId,
          );
          if (new Set([principal.principalId, ...servicePrincipals]).size !== servicePrincipals.length + 1) {
            return yield* unavailable('distinct-service-identities');
          }
          return yield* send({
            buyer: {
              authBindingId: buyerKey.authBindingId,
              principalId: principal.principalId,
              secret: buyerKey.secret,
            },
            buyerPrincipalId: principal.principalId,
            buyerSessions: {
              legalEntity: { authContextRef: principal.authContextRef, legalEntityId: principal.legalEntityId },
              tenant: { authContextRef: tenantContext.principal.authContextRef },
            },
            catalog,
            cccReader,
            marketRelay,
            operation: 'SERVICE_KEYS_CREATED',
            pricingIssuer,
            protocol,
            tenantId: principal.tenantId,
          });
        }).pipe(Effect.provideContext(runtime)),
      ),
    );
    if (!stopped) {
      return yield* unavailable('stop-required');
    }
    return yield* Effect.void;
  }),
);

if (process.argv.includes('--describe-preproposal-basis')) {
  NodeRuntime.runMain(describe);
} else if (process.argv.includes('--serve-preproposal-basis')) {
  NodeRuntime.runMain(
    Effect.gen(function* reportIdentityFailure() {
      const secrets = yield* Effect.forEach(
        ['BETTER_AUTH_SECRET', 'DATABASE_URL', 'ONTOS_GATEWAY_PRIVATE_JWK', 'RESEND_API_KEY', 'SPICEDB_PRESHARED_KEY'],
        (name) => Config.Redacted(name).pipe(Config.withDefault(Redacted.make(''))),
      );
      return yield* serve.pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer, Logger.layer([]))),
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            // Preserve the original cause, including typed fields omitted from Error.stack.
            const redacted = '[REDACTED]';
            let diagnostic = `${Cause.pretty(cause)}\n${inspect(cause, { colors: false, depth: 5 })}`;
            for (const secret of secrets) {
              const value = Redacted.value(secret);
              if (value.length > 0) {
                diagnostic = diagnostic
                  .replaceAll(value, redacted)
                  .replaceAll(JSON.stringify(value).slice(1, -1), redacted);
                const credential = URL.canParse(value) ? new URL(value).password : '';
                if (credential.length > 0) {
                  diagnostic = diagnostic.replaceAll(credential, redacted);
                }
                const privateKey = /"d"\s*:\s*"(?<secret>[^"]+)"/u.exec(value)?.[1];
                if (privateKey !== undefined) {
                  diagnostic = diagnostic.replaceAll(privateKey, redacted);
                }
              }
            }
            diagnostic = diagnostic
              .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$<scheme>[REDACTED]@')
              .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, redacted)
              .replaceAll(/(?<field>"d"\s*:\s*")[^"]+"/gu, '$<field>[REDACTED]"');
            process.stderr.write(`${diagnostic}\n`);
          }),
        ),
      );
    }),
    { disableErrorReporting: true },
  );
}
