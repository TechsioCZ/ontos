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
  defineDatabaseIdentityEnrollment,
  makeActionRuntimeLive,
  makeDatabaseIdentityEnrollmentLive,
  parseDatabaseConfig,
} from '@app/core-runtime';
import type {
  ActionRuntimeService,
  LegalEntityContextService,
  OperationalScope,
  PrincipalResolverService,
} from '@app/core-runtime';
import { makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import type { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
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
import type { Scope } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import type { ApiKeyServiceContract } from '../../api/auth/api-key-service.ts';
import type { IdentityLifecycleService } from '../../api/auth/identity-lifecycle.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import type { ModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';

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

/** The calling modules of the preproposal journey, each holding its own platform module credential. */
const MODULE_APP_IDS = ['catalog', 'commerce-customer-context', 'commerce-market-catalog', 'pricing'] as const;

class PreproposalIdentityUnavailable extends Schema.TaggedError<PreproposalIdentityUnavailable>()(
  'PreproposalIdentityUnavailable',
  { cause: Schema.optionalKey(Schema.Defect()), stage: Schema.String },
) {}
const unavailable = (stage: string) => new PreproposalIdentityUnavailable({ stage });

/** One module's provisioned credential with the binding the platform enrolled for it. */
const moduleIdentityOf = (
  provisioned: {
    readonly credentials: ReadonlyMap<string, Redacted.Redacted>;
    readonly providerKeyIds: ReadonlySet<string>;
  },
  enrolment: readonly ModuleCredentialEnrolment[],
  appId: string,
) => {
  const secret = provisioned.credentials.get(appId);
  const enrolled = enrolment.find(
    (credential) => credential.appId === appId && provisioned.providerKeyIds.has(credential.providerKeyId),
  );
  return secret === undefined || enrolled === undefined
    ? Effect.fail(unavailable(`module-credential:${appId}`))
    : Effect.succeed({
        authBindingId: enrolled.authBindingId,
        principalId: enrolled.principalId,
        providerKeyId: enrolled.providerKeyId,
        secret,
      });
};

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

/** The services the identity protocol drives; `serve` builds them over the owned database. */
export interface PreproposalIdentityParticipants {
  readonly authentication: Pick<
    AuthenticationServiceContract,
    'createFixtureUser' | 'resolveShellContext' | 'resolveTenantContext' | 'signIn'
  >;
  readonly keys: Pick<ApiKeyServiceContract, 'verify'>;
  /** Only the buyer's own key is issued through the identity lifecycle: the platform provisions every module key. */
  readonly lifecycle: Pick<IdentityLifecycleService, 'issue'>;
  /** The platform's module credentials for the given calling modules, with the bindings it enrolled for them. */
  readonly modules: {
    readonly provision: (
      appIds: readonly string[],
    ) => Effect.Effect<ProvisionedModuleCredentials, PreproposalIdentityUnavailable>;
  };
  /** The Shell origin every sign-in and session read presents. */
  readonly origin: string;
  readonly resolver: Pick<PrincipalResolverService, 'resolveBetterAuthApiKey'>;
}

/** What the platform provisioned for the journey's calling modules, and the bindings it enrolled. */
export interface ProvisionedModuleCredentials {
  readonly enrolment: readonly ModuleCredentialEnrolment[];
  readonly provisioned: {
    readonly credentials: ReadonlyMap<string, Redacted.Redacted>;
    readonly providerKeyIds: ReadonlySet<string>;
  };
}

/** The private command lines in and response lines out; `serve` binds them to fd 4 and fd 5. */
export interface PreproposalIdentityTransport<InputError, OutputError> {
  readonly commands: Stream.Stream<string, InputError>;
  readonly write: (line: string) => Effect.Effect<void, OutputError>;
}

type IdentityCommand = typeof CommandSchema.Type;
/** A response frame as the participants produce it; the response schema checks it as it is written. */
type IdentityFrame = Pick<typeof ResponseSchema.Type, 'operation' | 'protocol'>;

/** What one protocol run shares across its commands: the participants, the buyer and the writer. */
interface IdentitySetup<OutputError> {
  readonly email: string;
  readonly participants: PreproposalIdentityParticipants;
  readonly password: Redacted.Redacted;
  readonly send: <Frame extends IdentityFrame>(
    response: Frame,
  ) => Effect.Effect<void, OutputError | Schema.SchemaError>;
  readonly suffix: string;
}

/** The session cookies a sign-in set, as the browser sends them back. */
const sessionCookie = (setCookieHeaders: readonly string[]) =>
  setCookieHeaders.map((value) => value.split(';')[0]).join('; ');

/** Answers the one CREATE_SERVICE_KEYS command with the buyer's own key and the four platform module keys. */
const createServiceKeys = <OutputError>(
  setup: IdentitySetup<OutputError>,
  command: Extract<IdentityCommand, { readonly operation: 'CREATE_SERVICE_KEYS' }>,
) =>
  Effect.gen(function* createIdentityServiceKeys() {
    const { authentication, keys, lifecycle, modules, origin, resolver } = setup.participants;
    const { email, password, suffix } = setup;
    const session = yield* authentication.signIn(email, password, new Headers({ origin }));
    if (session.identity.principalId !== command.buyerPrincipalId || session.identity.tenantId !== command.tenantId) {
      return yield* unavailable('actual-human-session');
    }
    const headers = new Headers({ cookie: sessionCookie(session.setCookieHeaders), origin });
    const resolved = yield* authentication.resolveShellContext(headers);
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
    const boundBuyer = yield* resolver.resolveBetterAuthApiKey(verifiedBuyer.providerKeyId);
    if (
      boundBuyer.principalId !== principal.principalId ||
      boundBuyer.tenantId !== principal.tenantId ||
      boundBuyer.authBindingId !== buyerKey.authBindingId
    ) {
      return yield* unavailable('original-buyer-provider-binding');
    }
    // Each calling module's credential is provisioned by the platform, exactly as on every environment.
    const { enrolment, provisioned } = yield* modules.provision(MODULE_APP_IDS);
    const moduleIdentity = (appId: string) => moduleIdentityOf(provisioned, enrolment, appId);
    const cccReader = yield* moduleIdentity('commerce-customer-context');
    const pricingIssuer = yield* moduleIdentity('pricing');
    const catalog = yield* moduleIdentity('catalog');
    const marketRelay = yield* moduleIdentity('commerce-market-catalog');
    // A second sign-in stays in the Tenant: no Legal Entity is selected on that session.
    const tenantSession = yield* authentication.signIn(email, password, new Headers({ origin }));
    const tenantContext = yield* authentication.resolveTenantContext(
      new Headers({ cookie: sessionCookie(tenantSession.setCookieHeaders), origin }),
    );
    if (
      tenantContext.state !== 'authenticated' ||
      tenantContext.principal.principalId !== principal.principalId ||
      tenantContext.principal.legalEntityId !== undefined ||
      tenantContext.principal.authContextRef === undefined
    ) {
      return yield* unavailable('actual-tenant-session');
    }
    const servicePrincipals = [
      cccReader.principalId,
      pricingIssuer.principalId,
      catalog.principalId,
      marketRelay.principalId,
    ];
    if (new Set([principal.principalId, ...servicePrincipals]).size !== servicePrincipals.length + 1) {
      return yield* unavailable('distinct-service-identities');
    }
    return yield* setup.send({
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
  });

/** One command line as the protocol admits it: bounded, then decoded by the command schema. */
const decodeCommand = (line: string) =>
  line.length > 65_536
    ? Effect.fail(unavailable('command-size'))
    : Schema.decodeUnknownEffect(Schema.fromJsonString(CommandSchema))(line).pipe(
        Effect.mapError(() => unavailable('command-codec')),
      );

/**
 * The identity protocol: it creates the buyer's provider user, answers exactly one CREATE_SERVICE_KEYS
 * command with the buyer's own key and four managed service keys, and ends only on STOP.
 */
export const runPreproposalIdentityProtocol = <InputError, OutputError>(
  participants: PreproposalIdentityParticipants,
  transport: PreproposalIdentityTransport<InputError, OutputError>,
) =>
  Effect.gen(function* runPreproposalIdentity() {
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const email = `preproposal-${suffix}@fixture.invalid`;
    const password = Redacted.make(`${yield* crypto.randomUUIDv4()}${yield* crypto.randomUUIDv4()}`);
    const providerUserId = yield* participants.authentication.createFixtureUser(
      email,
      'Preproposal native human buyer',
      password,
    );
    const setup: IdentitySetup<OutputError> = {
      email,
      participants,
      password,
      send: (response) =>
        Schema.encodeUnknownEffect(Schema.fromJsonString(ResponseSchema))(response).pipe(
          Effect.flatMap((line) => transport.write(`${line}\n`)),
        ),
      suffix,
    };
    yield* setup.send({ operation: 'PROVIDER_USER_CREATED', protocol, providerUserId });
    let created = false;
    let stopped = false;
    yield* transport.commands.pipe(
      Stream.mapEffect(decodeCommand),
      Stream.takeUntil((command) => command.operation === 'STOP'),
      Stream.runForEach((command) => {
        if (command.operation === 'STOP') {
          stopped = true;
          return setup.send({ operation: 'STOPPED', protocol });
        }
        if (created) {
          return Effect.fail(unavailable('single-setup-command'));
        }
        created = true;
        return createServiceKeys(setup, command);
      }),
    );
    if (!stopped) {
      return yield* unavailable('stop-required');
    }
    return yield* Effect.void;
  });

/** What the identity runtime takes from Core, built over the owned database. */
type PreproposalIdentityCore = AccessDecisionGate | ActionRuntime | LegalEntityContext | PrincipalResolver;

/** The services every identity construction and command runs in. */
export type PreproposalIdentityRuntime = AuthenticationNamespaceRegistry | PreproposalIdentityCore;

/**
 * Builds the identity runtime and runs the protocol in it. Core's Actions and principal resolver
 * are built with the staff authentication registry the Shell admits, and that one runtime is the
 * context of the authentication service's construction and of every lifecycle command: Core
 * Actions read the registry from the fiber's context, so it must be there when a command runs.
 */
export const runPreproposalIdentityRuntime = <
  CoreError,
  CoreRequirements,
  AuthenticationError,
  InputError,
  OutputError,
>(options: {
  /** Built in the identity runtime; it may hold resources for the rest of the run. */
  readonly authentication: Effect.Effect<
    PreproposalIdentityParticipants['authentication'],
    AuthenticationError,
    PreproposalIdentityRuntime | Scope.Scope
  >;
  /** Core's Actions, access gate, companies and principal resolver, without the registry. */
  readonly core: Layer.Layer<PreproposalIdentityCore, CoreError, CoreRequirements>;
  readonly keys: ApiKeyServiceContract;
  readonly lifecycle: (
    ...dependencies: readonly [ActionRuntimeService, ApiKeyServiceContract, PrincipalResolverService]
  ) => PreproposalIdentityParticipants['lifecycle'];
  readonly modules: PreproposalIdentityParticipants['modules'];
  readonly origin: string;
  readonly transport: PreproposalIdentityTransport<InputError, OutputError>;
}) =>
  Effect.gen(function* runInIdentityRuntime() {
    const runtime = yield* Layer.build(
      options.core.pipe(Layer.provideMerge(staffAuthenticationNamespaceRegistryLayer(['shell-super-app']))),
    );
    const authentication = yield* options.authentication.pipe(Effect.provideContext(runtime));
    const resolver = Context.get(runtime, PrincipalResolver);
    const lifecycle = options.lifecycle(Context.get(runtime, ActionRuntime), options.keys, resolver);
    return yield* runPreproposalIdentityProtocol(
      { authentication, keys: options.keys, lifecycle, modules: options.modules, origin: options.origin, resolver },
      options.transport,
    ).pipe(Effect.provideContext(runtime));
  });

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
    const { ApiKeyService, makeApiKeyService } = yield* Effect.tryPromise({
      catch: () => unavailable('key-provider-import'),
      try: async () => await import('../../api/auth/api-key-service.ts'),
    });
    const { provisionModuleCredentials } = yield* Effect.tryPromise({
      catch: () => unavailable('module-credential-provisioning-import'),
      try: async () => await import('../../api/auth/module-credential-provisioning.service.ts'),
    });
    const { installedModuleCatalog, ShellInstalledModuleCatalogLive } = yield* Effect.tryPromise({
      catch: () => unavailable('installed-module-catalog-import'),
      try: async () => await import('../../api/modules/installed-module-catalog.ts'),
    });
    const { moduleCredentialReleaseOf } = yield* Effect.tryPromise({
      catch: () => unavailable('module-credential-attestation-import'),
      try: async () => await import('../../api/auth/module-credential-attestation.ts'),
    });
    const { loadModuleCredentialEnrolment } = yield* Effect.tryPromise({
      catch: () => unavailable('module-credential-enrolment-import'),
      try: async () => await import('@app/core-runtime/auth/module-credentials'),
    });
    const { CoreDatabase } = yield* Effect.tryPromise({
      catch: () => unavailable('core-database-import'),
      try: async () => await import('@app/core-runtime/db/client'),
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
      // This Shell fixture installs no dedicated database identities.
      makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([])),
      accessEnforcement,
      LegalEntityContextLive.pipe(Layer.provide(persistence)),
      composition,
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
        ),
      ),
    );
    const keys = yield* makeApiKeyService().pipe(
      Effect.provideService(AuthConfig, authConfiguration),
      Effect.provideService(AuthDatabase, authDatabase),
    );
    const output = yield* Effect.acquireRelease(
      Effect.sync(() => createWriteStream('', { autoClose: false, fd: 5 })),
      (stream) =>
        Effect.tryPromise(async () => {
          const completion = finished(stream, { cleanup: true });
          stream.end();
          await completion;
        }).pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => stream.destroy()))),
    );
    const send = (line: string) =>
      Stream.make(line).pipe(
        Stream.run(
          NodeSink.fromWritable({
            endOnDone: false,
            evaluate: () => output,
            onError: () => unavailable('private-output'),
          }),
        ),
      );
    const crypto = yield* Crypto.Crypto;
    // Each calling module's credential is provisioned by the platform, exactly as on every environment.
    const provisionModules = (appIds: readonly string[]) =>
      Effect.scoped(
        Effect.gen(function* provisionModuleCredentialsOnce() {
          const coreDatabase = Context.get(yield* Layer.build(persistence), CoreDatabase);
          // Attested for the release this composition serves, read exactly as the Shell reads it.
          const installed = yield* installedModuleCatalog.pipe(
            Effect.provide(ShellInstalledModuleCatalogLive.pipe(Layer.provide(composition))),
          );
          const provisioned = yield* provisionModuleCredentials({
            appIds,
            bootId: yield* crypto.randomUUIDv4(),
            hostId: 'preproposal-basis-identity',
            operationId: yield* crypto.randomUUIDv4(),
            release: moduleCredentialReleaseOf(installed),
          }).pipe(
            Effect.provideService(ApiKeyService, keys),
            Effect.provideService(AuthDatabase, authDatabase),
            Effect.provideService(CoreDatabase, coreDatabase),
          );
          return { enrolment: yield* loadModuleCredentialEnrolment(coreDatabase.executor), provisioned };
        }),
      ).pipe(Effect.mapError((cause) => new PreproposalIdentityUnavailable({ cause, stage: 'module-credentials' })));
    return yield* runPreproposalIdentityRuntime({
      // The authentication framework is built over the identity runtime, so the staff registry is in its context.
      authentication: Effect.gen(function* buildAuthentication() {
        const runtime = yield* Effect.context<PreproposalIdentityRuntime>();
        const authenticationContext = yield* Layer.build(
          shellAuthenticationFrameworkLive({ allowFixtureSignUp: true }).pipe(
            Layer.provideMerge(Layer.succeedContext(runtime)),
            Layer.provideMerge(persistence),
            Layer.provideMerge(
              Layer.mergeAll(Layer.succeed(AuthConfig, authConfiguration), Layer.succeed(AuthDatabase, authDatabase)),
            ),
          ),
        );
        return yield* makeAuthenticationService().pipe(Effect.provideContext(authenticationContext));
      }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      core: Layer.mergeAll(actions.pipe(Layer.provide(common)), resolver, common),
      keys,
      lifecycle: makeIdentityLifecycleService,
      modules: { provision: provisionModules },
      origin: authConfiguration.baseUrl,
      transport: {
        commands: NodeStream.fromReadable({
          evaluate: () => createReadStream('', { autoClose: false, fd: 4 }),
          onError: () => unavailable('private-input'),
        }).pipe(Stream.decodeText(), Stream.splitLines),
        write: send,
      },
    });
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
