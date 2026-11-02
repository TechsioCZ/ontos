import {
  ActionRuntime,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  LegalEntityContextLive,
  PrincipalResolver,
  PrincipalResolverLive,
  TenantModuleStateServiceLive,
  defineDatabaseIdentityEnrollment,
  makeActionRuntimeLive,
  makeDatabaseIdentityEnrollmentLive,
  parseDatabaseConfig,
} from '@app/core-runtime';
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
const ResponseSchema = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal('PROVIDER_USER_CREATED'),
    protocol: Schema.Literal(protocol),
    providerUserId: ProviderSubjectIdSchema,
  }),
  Schema.Struct({
    buyerPrincipalId: PrincipalIdSchema,
    cccReader: Schema.Struct(identity),
    operation: Schema.Literal('SERVICE_KEYS_CREATED'),
    pricingIssuer: Schema.Struct(identity),
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
    const { shellAuthenticationFrameworkLive } = yield* Effect.tryPromise({
      catch: () => unavailable('authentication-framework-import'),
      try: async () => await import('./shell-authentication.ts'),
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
    const authDatabase = yield* makeAuthDatabase({
      connectionString: authConfiguration.connectionString,
      expectedRole: databaseConfig.expectedRole,
    });
    const persistence = CorePersistenceLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, databaseConfig)));
    const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
    const gate = ModuleStateGateLive.pipe(Layer.provide(states));
    const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
    const scopes = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)));
    const resolver = PrincipalResolverLive({ authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID }).pipe(
      Layer.provide(persistence),
    );
    const composition = ActiveApplicationCompositionConfigLive.pipe(
      Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer))),
    );
    const common = Layer.mergeAll(
      ContextAccessLive,
      // This Shell fixture installs no dedicated database identities.
      makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([])),
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
          ActionPermissionLive,
          ActionRepositoryLive,
          staffAuthenticationNamespaceRegistryLayer(['shell-super-app']),
        ),
      ),
    );
    const runtime = yield* Layer.build(Layer.mergeAll(actions.pipe(Layer.provide(common)), resolver, common));
    const authenticationContext = yield* Layer.build(
      shellAuthenticationFrameworkLive({ allowFixtureSignUp: true }).pipe(
        Layer.provideMerge(Layer.succeedContext(runtime)),
        Layer.provideMerge(persistence),
        Layer.provideMerge(
          Layer.mergeAll(Layer.succeed(AuthConfig, authConfiguration), Layer.succeed(AuthDatabase, authDatabase)),
        ),
      ),
    );
    const authentication = yield* makeAuthenticationService().pipe(Effect.provideContext(authenticationContext));
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
              // A service principal's key is tenant-managed; company-agent keys need an agent principal.
              managedScope: 'tenant-managed',
              name,
              principal,
              requestHeaders: headers,
            });
            if (createdService.principalId === principal.principalId || key.cleanupPending) {
              return yield* unavailable('managed-service-binding');
            }
            return { authBindingId: key.authBindingId, principalId: createdService.principalId, secret: key.secret };
          });
          const cccReader = yield* produceService('ccc-reader');
          const pricingIssuer = yield* produceService('pricing-issuer');
          if (cccReader.principalId === pricingIssuer.principalId) {
            return yield* unavailable('distinct-service-identities');
          }
          return yield* send({
            buyerPrincipalId: principal.principalId,
            cccReader,
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
