import type { Server } from 'node:http';
import { format as formatLine } from 'node:util';

import { NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import {
  DatabaseConfig,
  makeSystemPrincipalContextResolver,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
  registerSystemWorkload,
} from '@app/core-runtime';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { AccessDecisionLive } from '@app/core-runtime/access/enforcement';
import { TenantAccessBootstrapLive } from '@app/core-runtime/access/bootstrap';
import { AccessChangesStoreLive } from '@app/core-runtime/access/changes/persistence/drizzle-store';
import { writeRoleCreation } from '@app/core-runtime/access/changes/role-revision';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '@app/core-runtime/access/compiler/spice-db-compiler';
import { AccessCatalogSnapshotWriterLive } from '@app/core-runtime/access/intent/catalog-snapshot-writer';
import { AccessMembershipStore, AccessMembershipStoreLive } from '@app/core-runtime/access/intent/memberships';
import { AccessPeopleStore, AccessPeopleStoreLive } from '@app/core-runtime/access/intent/people-store';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import { AccessProjectionWriterLive } from '@app/core-runtime/access/intent/projection-writer';
import { AccessTeamStore, makeAccessTeamDrizzleStore } from '@app/core-runtime/access/intent/teams';
import { TenantIntentLoaderLive } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { AccessWriteJournalStoreLive } from '@app/core-runtime/access/lifecycle/persistence/journal-store';
import { AccessPeopleCommands, AccessPeopleCommandsLive } from '@app/core-runtime/access/lifecycle/people-service';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { AccessEnforcementPortsLive } from '@app/core-runtime/actions/runtime-wiring';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { CoreDatabase, CoreDatabaseLive } from '@app/core-runtime/db/client';
import { reconcileStageContextBootstraps } from '@app/core-runtime/install/stage-context-bootstrap';
import type { StageTenantBootstrap } from '@app/core-runtime/install/stage-context-bootstrap';
import { ObjectStorage, loadS3ObjectStorageConfig, makeS3ObjectStorage } from '@app/core-runtime/media/edge';
import {
  ActiveApplicationCompositionSnapshotSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { createEffectBffTestHandler } from '@modern-js/bff-effect/effect-edge';
import { Config, Context, Crypto, DateTime, Effect, Layer, Match, Option, Schema, Stream } from 'effect';
import type { Scope } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

import { AuthenticationService } from '../../api/auth/service.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';
import { shellProductionRuntimeArguments } from '../../api/index.ts';
import type { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import { compileFullAccessRole } from '../../../../packages/core-runtime/src/access/bootstrap/full-access-role.ts';
import { tenantContextScopeId } from '../../../../packages/core-runtime/src/access/bootstrap/persistence.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  PrincipalIdSchema,
  RecordKeySchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../../../packages/core-runtime/src/access/ids.ts';
import type { AssignmentIncarnationId } from '../../../../packages/core-runtime/src/access/ids.ts';
import { AccessMembershipIdSchema } from '../../../../packages/core-runtime/src/access/intent/memberships.ts';
import type { Cell } from '../../../../packages/core-runtime/src/access/model.ts';
import type { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import type { ActionRuntimeService, makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { TRUST_ROUTINES } from '../../../../packages/core-runtime/src/db/database-identity-manifest.ts';
import type { CoreDatabaseExecutor } from '../../../../packages/core-runtime/src/db/types.ts';
import type { ObjectStorageService } from '../../../../packages/core-runtime/src/media/object-storage.ts';
import { EMPTY_PAYLOAD_SHA256, signS3Request } from '../../../../packages/core-runtime/src/media/s3-signing.ts';
import { deriveMediaStorageKey } from '../../../../packages/core-runtime/src/media/storage-key.ts';
import {
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { bindLiveAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import type { OperationalScope } from '../../../../packages/core-runtime/src/operations/context.ts';
import type { makeReadRuntime, ReadRuntimeService } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from '../../../../packages/core-runtime/tests/support/open-module-state-gate.ts';
import { startS3FaultProxy } from '../../../../packages/core-runtime/tests/support/s3-fault-proxy.ts';
import type { S3FaultProxy } from '../../../../packages/core-runtime/tests/support/s3-fault-proxy.ts';
import type { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  cloneDatabase,
  dropDatabase,
  ensureTemplate,
  loadCatalog,
  openPgPool,
  replacedDatabase,
  serverAdminUrl,
  serverConnections,
  writeEngineSchema,
} from './access-admin-real-gate-fixture.ts';
import { startNativeHttpServer } from './native-http-server.ts';
import { startTcpFaultProxy } from './tcp-fault-proxy.ts';
import type { TcpFaultProxy } from './tcp-fault-proxy.ts';

/*
 * The D20 Core Media end-to-end world (#1446). Everything a request touches is the production piece:
 *
 *  - PostgreSQL: one database cloned per case from the committed schema (core and Shell staff-auth migrations).
 *  - SpiceDB: the integration engine. The tenant is created by the real stage install path
 *    (`reconcileStageContextBootstraps`: identity rows, the derived `core.media` installation row, the owner's
 *    "Plny pristup"), and every narrower grant or revoke is a real command (`writeRoleCreation`,
 *    `AccessPeopleCommands.assignRole` / `unassignRole`). No tuple and no assignment row is written by hand.
 *  - The Shell BFF: the production runtime composition (`makeShellAuthenticationApiRuntime`) mounted on a real
 *    loopback HTTP server. The byte routes, the metadata read and the object store come from it.
 *  - The object store: the real S3 adapter configured from `CORE_MEDIA_S3_*` (an S3-compatible emulator, NOT R2).
 *
 * The one substitute is AUTHENTICATION: `resolveTenantContext` answers the seeded principal that an `x-e2e-actor`
 * header names, because signing in is not what this suite tests. Every authorization answer is the engine's.
 * The Action runtime used for the steps that have no client route (reserve, rename, integrity) is composed here over
 * the same database and engine with the real access gate; its module-state and entrypoint gateways are the open
 * test seams the Core suites use.
 *
 * The runtime constructors are handed in by the test file (`E2ePlatform`): a support module does not import service
 * constructors, a test file composes them.
 */

export const ACTOR_HEADER = 'x-e2e-actor';
const { apiPrefix } = shellAuthenticationApiContract;
const MEMBERSHIP_HEADROOM = { days: 1 } as const;

export interface E2ePlatform {
  readonly makeActionRepository: typeof makeActionRepository;
  readonly makeActionRuntime: typeof makeActionRuntime;
  readonly makeCompositionSnapshot: typeof makeCompositionSnapshot;
  readonly makeReadRuntime: typeof makeReadRuntime;
  readonly makeShellAuthenticationApiRuntime: typeof makeShellAuthenticationApiRuntime;
}

export class MediaE2eFixtureFailure extends Schema.TaggedError<MediaE2eFixtureFailure>()('MediaE2eFixtureFailure', {
  reason: Schema.String,
}) {}

const failure = (reason: string) => new MediaE2eFixtureFailure({ reason });

export interface E2eActor {
  readonly authBindingId: string;
  readonly name: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const PEOPLE = ['owner', 'metadataOnly', 'downloader', 'uploader', 'currentOnly', 'outsider'] as const;

const MEDIA_CAPABILITIES = {
  confirm: 'core.media.asset.confirm',
  current: 'core.media.asset-current.read',
  download: 'core.media.asset-download.read',
  metadata: 'core.media.asset-metadata.read',
  rename: 'core.media.display-filename.rename',
  upload: 'core.media.asset.upload',
} as const;
export { MEDIA_CAPABILITIES };

/** The trusted request scope of one actor: tenant context, no selected company. */
export const principalOf = (actor: E2eActor) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId: actor.authBindingId,
    authContextRef: `session:e2e:${actor.principalId}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    principalId: actor.principalId,
    tenantId: actor.tenantId,
  }).pipe(Effect.orDie);

const scopeOf = (actor: E2eActor) =>
  principalOf(actor).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'core-media-e2e' }) satisfies OperationalScope),
  );

const required = <Value>(value: Value | undefined, what: string): Effect.Effect<Value> =>
  value === undefined ? Effect.die(failure(`The world has no ${what}`)) : Effect.succeed(value);

// ---------------------------------------------------------------------------------------------
// The people of a tenant
// ---------------------------------------------------------------------------------------------

const rosterOf = (tenantId: string, label: string) =>
  Effect.gen(function* makeRoster() {
    const crypto = yield* Crypto.Crypto;
    const actors = new Map<string, E2eActor>();
    const accounts = [];
    for (const name of PEOPLE) {
      const actor = {
        authBindingId: yield* crypto.randomUUIDv4(),
        name,
        principalId: yield* crypto.randomUUIDv4(),
        tenantId,
      } satisfies E2eActor;
      actors.set(name, actor);
      accounts.push({
        authBindingId: actor.authBindingId,
        displayName: `E2E ${label} ${name}`,
        owner: name === 'owner',
        principalId: actor.principalId,
        providerUserId: `e2e-${label}-${name}-${actor.principalId}`,
        roles: name === 'owner' ? (['full_access'] as const) : ([] as const),
      });
    }
    const bootstrap = {
      accounts,
      tenant: {
        defaultLocale: 'cs',
        displayName: `E2E ${label} tenant`,
        legalEntity: {
          legalEntityId: yield* crypto.randomUUIDv4(),
          legalName: `E2E ${label} s.r.o.`,
          registrationCountry: 'CZ',
          registrationNumber: `E2E-${tenantId.slice(-8)}`,
        },
        moduleKey: 'party.registry',
        moduleStateId: yield* crypto.randomUUIDv4(),
        slug: `e2e-${label}-${tenantId.slice(-8)}`,
        tenantId,
      },
    } satisfies StageTenantBootstrap;
    return { actors, bootstrap };
  });

// ---------------------------------------------------------------------------------------------
// Authentication: the one substitute
// ---------------------------------------------------------------------------------------------

const unsupported = (operation: string) => Effect.die(failure(`${operation} is not part of the E2E authentication`));

/** Signs in whichever seeded actor the request header names; nothing else of authentication is used. */
const actorAuthentication = (principals: ReadonlyMap<string, TrustedPrincipalContext>) => {
  const service: AuthenticationServiceContract = {
    availableTenants: () => unsupported('availableTenants'),
    createFixtureUser: () => unsupported('createFixtureUser'),
    currentSession: () => unsupported('currentSession'),
    resolveShellContext: () => unsupported('resolveShellContext'),
    resolveTenantContext: (headers) =>
      Effect.succeed(
        Option.match(Option.fromNullishOr(principals.get(headers.get(ACTOR_HEADER) ?? '')), {
          onNone: () => ({ setCookieHeaders: [], state: 'anonymous' as const }),
          onSome: (principal) => ({
            identity: {
              displayName: 'E2E person',
              email: 'e2e@example.test',
              principalId: principal.principalId,
              tenantId: principal.tenantId,
            },
            principal,
            setCookieHeaders: [],
            state: 'authenticated' as const,
          }),
        }),
      ),
    signIn: () => unsupported('signIn'),
    signOut: () => unsupported('signOut'),
    switchLegalEntity: () => unsupported('switchLegalEntity'),
    switchTenant: () => unsupported('switchTenant'),
  };
  return Layer.succeed(AuthenticationService, service);
};

// ---------------------------------------------------------------------------------------------
// The active Application Composition
// ---------------------------------------------------------------------------------------------

const portOfUrl = (endpoint: URL): number => (endpoint.port === '' ? 0 : Number(endpoint.port));

const listenOn = (port: number, document: string) =>
  Effect.callback<Server>((resume) => {
    const http = process.getBuiltinModule('http');
    const created = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(document);
    });
    created.listen(port, '127.0.0.1', () => {
      resume(Effect.succeed(created));
    });
  });

const closeServer = (created: Server) =>
  Effect.callback<undefined>((resume) => {
    created.closeAllConnections();
    created.close(() => {
      resume(Effect.undefined);
    });
  });

const serveDocument = (port: number, document: string) => Effect.acquireRelease(listenOn(port, document), closeServer);

/** One sealed composition: the Shell is the receiving deployment, with the module contracts the scenario installs. */
const publishComposition = (platform: E2ePlatform, admin: CoreDatabaseExecutor, contracts: readonly unknown[]) =>
  Effect.gen(function* publishActiveComposition() {
    const snapshot = yield* platform
      .makeCompositionSnapshot(contracts, 3_600_000)
      .pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot), Effect.orDie);
    const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
      snapshot,
    ).pipe(Effect.orDie);
    // The runtime cannot write the authority row: the privileged identity publishes it, as a release does.
    yield* admin
      .transaction(
        Effect.fn('MediaE2e.publishComposition')(function* publish(transaction) {
          yield* lockApplicationCompositionPublication(transaction);
          return yield* publishApplicationCompositionAuthority(transaction, snapshot);
        }),
      )
      .pipe(Effect.orDie);
    // The runtime reads this URL from the process environment (a snapshot taken when the run starts), so the run is
    // started with it; the harness serves exactly that loopback address.
    const url = new URL(yield* Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL').pipe(Effect.orDie));
    yield* serveDocument(portOfUrl(url), document);
    return snapshot;
  });

// ---------------------------------------------------------------------------------------------
// The object store and the fault relays
// ---------------------------------------------------------------------------------------------

/*
 * The production Shell reads the object store and the engine from the process environment, a snapshot taken when the
 * run starts. To inject faults between the Shell and those services, the run is started with the Shell-facing
 * endpoints (`CORE_MEDIA_S3_ENDPOINT`, `SPICEDB_ENDPOINT`) pointing at relays this harness starts, and with the real
 * services named in `D20_E2E_S3_UPSTREAM` and `D20_E2E_ENGINE_UPSTREAM`. The harness itself observes the emulator
 * directly. Without the upstream variables there is no relay and the fault scenarios report themselves as BLOCKED.
 */
const upstreamsOf = Effect.gen(function* readUpstreams() {
  const [s3, engine] = yield* Effect.all([
    Config.option(Config.String('D20_E2E_S3_UPSTREAM')),
    Config.option(Config.String('D20_E2E_ENGINE_UPSTREAM')),
  ]);
  return Option.all({ engine, s3 });
}).pipe(Effect.orDie);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const openStorage = Effect.gen(function* openObjectStorage() {
  // What the Shell is configured with. A reservation records the provider identity derived from it, so the Actions
  // run against that very identity.
  const shellFacing = yield* loadS3ObjectStorageConfig({ envPath: '/nonexistent/core-media-e2e.env' }).pipe(
    Effect.orDie,
  );
  if (!LOOPBACK_HOSTS.has(shellFacing.endpoint.hostname)) {
    return yield* Effect.die(failure('The E2E suite writes only to a loopback S3-compatible emulator'));
  }
  const upstream = yield* upstreamsOf;
  const direct = Option.match(upstream, {
    onNone: () => shellFacing,
    onSome: ({ s3 }) => ({ ...shellFacing, endpoint: new URL(s3) }),
  });
  const services = Layer.mergeAll(FetchHttpClient.layer, NodeCrypto.layer);
  return {
    direct,
    directStorage: yield* makeS3ObjectStorage(direct).pipe(Effect.provide(services)),
    shellFacing,
    shellFacingStorage: yield* makeS3ObjectStorage(shellFacing).pipe(Effect.provide(services)),
    upstream,
  };
});

type OpenedStorage = Effect.Success<typeof openStorage>;

const targetOf = (endpoint: string) => {
  const [host = 'localhost', port = '0'] = endpoint.replace(/^[a-z]+:\/\//u, '').split(':');
  return { host, port: Number(port) };
};

export interface FaultInjection {
  readonly engine: TcpFaultProxy;
  readonly faults: S3FaultProxy;
}

const openFaultInjection = (storage: OpenedStorage) =>
  Effect.gen(function* openRelays() {
    if (Option.isNone(storage.upstream)) {
      return Option.none<FaultInjection>();
    }
    const engineFacing = (yield* loadSpiceDbConfig().pipe(Effect.orDie)).endpoint;
    return Option.some({
      engine: yield* startTcpFaultProxy(targetOf(engineFacing).port, targetOf(storage.upstream.value.engine)),
      faults: yield* startS3FaultProxy(storage.direct.endpoint, portOfUrl(storage.shellFacing.endpoint)),
    });
  });

// ---------------------------------------------------------------------------------------------
// The shell on loopback
// ---------------------------------------------------------------------------------------------

export interface ShellRequest {
  readonly actor: E2eActor | undefined;
  readonly body?: Uint8Array<ArrayBuffer> | string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
}

export interface ShellEdge {
  /** The same request, answered as an open response whose body the caller reads at its own pace. */
  readonly open: (input: ShellRequest) => Effect.Effect<Response>;
  /** The loopback origin the production Shell BFF answers on. */
  readonly origin: string;
  readonly request: (
    input: ShellRequest,
  ) => Effect.Effect<{ readonly bytes: Uint8Array; readonly headers: Headers; readonly status: number }>;
}

const initOf = (input: ShellRequest): RequestInit => {
  const headers = new Headers(input.headers);
  if (input.actor !== undefined) {
    headers.set(ACTOR_HEADER, input.actor.principalId);
  }
  const init: RequestInit = { headers, method: input.method, redirect: 'manual' };
  if (input.body !== undefined) {
    init.body = input.body;
  }
  return init;
};

const readAll = (response: Response) =>
  Effect.promise(async () => ({
    bytes: new Uint8Array(await response.arrayBuffer()),
    headers: response.headers,
    status: response.status,
  }));

const edgeOf = (origin: string): ShellEdge => {
  const open = (input: ShellRequest) =>
    Effect.promise(async () => await fetch(`${origin}${apiPrefix}${input.path}`, initOf(input)));
  return { open, origin, request: (input) => Effect.flatMap(open(input), readAll) };
};

/** Receives every line the in-process Shell writes to the console (a sink the scenario reads back). */
export type ShellLogSink = (entry: string) => void;

/**
 * The Shell's default logger writes to the console of this process, and the request fibers of the mounted handler do
 * not see a logger layer added to the runtime layer, so a scenario that has to read what an operator reads taps the
 * console for its scope. The lines still reach the console.
 */
const tapConsole = (sink: ShellLogSink) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const methods = ['debug', 'error', 'info', 'log', 'warn'] as const;
      const originals = methods.map((method) => [method, console[method]] as const);
      for (const [method, original] of originals) {
        console[method] = (...args: unknown[]) => {
          sink(formatLine(...args));
          original.apply(console, args);
        };
      }
      return originals;
    }),
    (originals) =>
      Effect.sync(() => {
        for (const [method, original] of originals) {
          console[method] = original;
        }
      }),
  );

const mountShell = (
  platform: E2ePlatform,
  input: {
    readonly databases: DatabaseConnectionPair;
    readonly principals: ReadonlyMap<string, TrustedPrincipalContext>;
  },
) =>
  Effect.gen(function* mountShellEffect() {
    const [, issuer, moduleStates] = shellProductionRuntimeArguments;
    const runtime = platform.makeShellAuthenticationApiRuntime(
      actorAuthentication(input.principals),
      issuer,
      moduleStates,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      input.databases,
    );
    const handler = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: () => failure('The Shell API handler could not be created'),
        try: async () => await createEffectBffTestHandler({ module: { default: runtime }, prefix: apiPrefix }),
      }),
      (created) => Effect.promise(created.dispose.bind(created)),
    );
    const source = yield* startNativeHttpServer(async (request) => await handler.handler(request));
    return edgeOf(source.origin);
  }).pipe(Effect.orDie);

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

export interface MediaE2eWorld {
  readonly actions: ActionRuntimeService;
  readonly admin: PgClient.PgClient;
  /**
   * Fixture only (throwaway database): enrols ONE `system` principal in this world's tenant and binds it to exactly the
   * named workload key, the way an operator's stage `workloads` entry does. It holds no role and no grant of any kind.
   */
  readonly bindSystemWorkload: (
    workloadKey: string,
  ) => Effect.Effect<{ readonly principal: TrustedPrincipalContext; readonly principalId: string }>;
  /** The revision of the active Application Composition every request of this world runs under. */
  readonly compositionRevision: string;
  readonly databases: DatabaseConnectionPair;
  readonly enrolSystemWorkload: (
    workloadKey: string,
    tenantId: string,
    options?: SystemWorkloadEnrolmentOptions,
  ) => Effect.Effect<{ readonly principalId: string }>;
  /**
   * CONTROLLED FAULT INJECTION: the relays between the Shell and the emulator (`faults`, forwarding until a rule is
   * set) and between the Shell and the engine (`engine`, `setDown(true)` partitions it). Absent when the run did not
   * name the real services behind them, which makes every scenario that needs them BLOCKED.
   */
  readonly faultInjection: Option.Option<FaultInjection>;
  readonly foreign: ReadonlyMap<string, E2eActor>;
  /** A real command: a role of exactly these capabilities, assigned to the person in the tenant context. */
  readonly grant: (
    person: E2eActor,
    capabilityKeys: readonly string[],
    options?: { readonly mode?: 'propose' | 'run'; readonly targets?: readonly [string, ...string[]] },
  ) => Effect.Effect<{ readonly incarnationId: AssignmentIncarnationId }>;
  readonly people: ReadonlyMap<string, E2eActor>;
  /** The Read runtime over the same database and engine (the Core owner reads that have no Shell route). */
  readonly reads: ReadRuntimeService;
  /** CONTROLLED FAULT INJECTION: replaces the stored bytes of an asset out of band (the row and the digest stay). */
  readonly replaceStoredObject: (mediaAssetId: string, bytes: Uint8Array) => Effect.Effect<void>;
  /** A real command: ends one assignment, then the tenant is reconciled. */
  readonly revoke: (incarnationId: AssignmentIncarnationId) => Effect.Effect<void>;
  /** The production Shell BFF mounted on loopback, for the scope of the caller. */
  readonly shell: Effect.Effect<ShellEdge, never, Scope.Scope>;
  /** The same Shell, with every log entry it writes handed to the sink (to prove what an operator can read). */
  readonly shellWithLogs: (sink: ShellLogSink) => Effect.Effect<ShellEdge, never, Scope.Scope>;
  /** The real S3 adapter straight on the emulator: observations that bypass the Shell. */
  readonly storage: ObjectStorageService;
  readonly tenantId: string;
  /** Runs an Action or Read effect that needs the object store with the real adapter. */
  readonly withStorage: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, ObjectStorage>>;
}

/** The case's own database: cloned from the committed schema, with the runtime's trust routines granted. */
const openCaseDatabase = Effect.gen(function* openDatabase() {
  const crypto = yield* Crypto.Crypto;
  const suffix = (yield* crypto.randomUUIDv4()).replaceAll('-', '');
  const caseDatabase = `d20_media_e2e_${suffix}`;
  const adminUrl = yield* serverAdminUrl;
  yield* ensureTemplate;
  const server = yield* openPgPool(adminUrl, 1);
  yield* cloneDatabase(server, caseDatabase);
  yield* Effect.addFinalizer(() => dropDatabase(server, caseDatabase));
  const caseAdminUrl = replacedDatabase(adminUrl, caseDatabase);
  const admin = yield* openPgPool(caseAdminUrl, 2);
  // The trust routines the runtime bootstrap lets the shared runtime execute (the Action fence lock).
  yield* admin.unsafe('grant usage on schema trust to ontos_runtime').pipe(Effect.orDie);
  for (const { executableBy, signature } of TRUST_ROUTINES) {
    if (executableBy.includes('ontos_runtime')) {
      yield* admin.unsafe(`grant execute on function ${signature} to ontos_runtime`).pipe(Effect.orDie);
    }
  }
  const runtimeUrl = replacedDatabase((yield* serverConnections).runtime.connectionString, caseDatabase);
  const databases = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: caseAdminUrl,
    DATABASE_URL: runtimeUrl,
  }).pipe(Effect.orDie);
  return { admin, caseAdminUrl, databases, runtimeUrl };
});

/** The access graph over the runtime identity: the real stores, projection writer, bootstrap, gate and people commands. */
const openAccessGraph = (runtimeUrl: string) =>
  Effect.gen(function* openGraph() {
    const configuration = yield* loadSpiceDbConfig().pipe(Effect.orDie);
    const runtimeConfiguration = yield* parseDatabaseConfig({ DATABASE_URL: runtimeUrl }).pipe(Effect.orDie);
    const database = CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, runtimeConfiguration)));
    const engine = Layer.effect(
      AccessProjectionCompiler,
      Effect.acquireRelease(
        Effect.sync(() => makeAccessProjectionTransport(configuration)),
        (transport) => Effect.sync(() => transport.close()),
      ).pipe(Effect.map((transport) => makeAccessProjectionCompiler(transport))),
    );
    const platforms = Layer.mergeAll(database, engine, NodeServices.layer);
    const platformContext = yield* Layer.build(platforms);
    const { executor } = Context.get(platformContext, CoreDatabase);
    const stores = Layer.mergeAll(
      platforms,
      TenantIntentLoaderLive.pipe(Layer.provide(platforms)),
      AccessWriteJournalStoreLive.pipe(Layer.provide(platforms)),
      AccessChangesStoreLive.pipe(Layer.provide(platforms)),
      AccessMembershipStoreLive.pipe(Layer.provide(platforms)),
      AccessPeopleStoreLive.pipe(Layer.provide(platforms)),
      Layer.succeed(AccessTeamStore, makeAccessTeamDrizzleStore({ executor })),
    );
    const base = Layer.mergeAll(
      stores,
      AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores)),
      AccessProjectionWriterLive.pipe(Layer.provide(stores)),
    );
    const context = yield* Layer.build(
      Layer.mergeAll(
        base,
        TenantAccessBootstrapLive.pipe(Layer.provide(base)),
        AccessDecisionLive.pipe(Layer.provideMerge(AccessEnforcementPortsLive), Layer.provide(base)),
        AccessPeopleCommandsLive.pipe(Layer.provide(base)),
      ),
    );
    return { context, executor };
  });

type AccessGraph = Effect.Success<ReturnType<typeof openAccessGraph>>;

const ownerAllowedOverlay = { authorize: () => Effect.succeed('allowed' as const) };

const openRuntimes = (platform: E2ePlatform, graph: AccessGraph) =>
  Effect.gen(function* openRuntimeServices() {
    const crypto = yield* Crypto.Crypto;
    const boundGate = yield* bindLiveAccessGate.pipe(Effect.provideContext(graph.context));
    const actions = platform.makeActionRuntime(
      { executor: graph.executor },
      platform.makeActionRepository(crypto),
      { checkActionPermission: () => Effect.succeed('allowed' as const) },
      testOperationalScopeResolver,
      {
        accessDecision: boundGate,
        lockCompositionAuthority: () => Effect.succeed([]),
        moduleEntrypointGateway: openModuleEntrypointGateway,
        moduleStateGate: openModuleStateGate,
        ownerAuthorizationOverlay: ownerAllowedOverlay,
        resolveCompositionRevision: () => Effect.succeed('a'.repeat(64)),
      },
    );
    const reads = platform.makeReadRuntime(
      { executor: graph.executor },
      openModuleEntrypointGateway,
      testOperationalScopeResolver,
      {
        legalEntities: () => Effect.succeed([]),
        modules: () => Effect.succeed([]),
        resources: () => Effect.succeed([]),
        tenants: () => Effect.succeed([]),
      },
      { accessDecision: boundGate, ownerAuthorizationOverlay: ownerAllowedOverlay },
    );
    return { actions, reads };
  });

const recordKeysOf = ([head, ...tail]: readonly [string, ...string[]]) =>
  [RecordKeySchema.make(head), ...tail.map((key) => RecordKeySchema.make(key))] as const;

/** A cell that reaches every record is narrowed to the named records of its scope (Resource scope); others stay. */
const aimCell = (cell: Cell, targets: readonly [string, ...string[]]): Cell =>
  Match.value(cell.selector).pipe(
    Match.tag('all', () => ({
      ...cell,
      selector: { _tag: 'targets' as const, recordKeys: recordKeysOf(targets) },
    })),
    Match.orElse(() => cell),
  );

/** The real commands that give a person a narrower role, and take it away. */
const openAccessCommands = (graph: AccessGraph, ownerScope: OperationalScope) =>
  Effect.gen(function* openCommands() {
    const crypto = yield* Crypto.Crypto;
    const release = Option.getOrThrow(
      yield* Context.get(graph.context, AccessPeopleStore).loadCatalogSnapshot(ownerScope).pipe(Effect.orDie),
    );
    const { cells } = yield* Effect.fromResult(compileFullAccessRole(release)).pipe(Effect.orDie);
    const people = Context.get(graph.context, AccessPeopleCommands);
    const tenantScope = tenantContextScopeId(TenantIdSchema.make(ownerScope.tenantId));
    const cellsOf = (
      capabilityKeys: readonly string[],
      mode?: 'propose' | 'run',
      targets?: readonly [string, ...string[]],
    ): readonly Cell[] =>
      cells
        .filter((cell) => capabilityKeys.includes(cell.capabilityKey) && (mode === undefined || cell.mode === mode))
        .map((cell) => (targets === undefined ? cell : aimCell(cell, targets)));
    const grant: MediaE2eWorld['grant'] = (person, capabilityKeys, options = {}) =>
      Effect.gen(function* grantRole() {
        const [roleUuid, revisionUuid, incarnationUuid] = yield* Effect.all([
          crypto.randomUUIDv4(),
          crypto.randomUUIDv4(),
          crypto.randomUUIDv4(),
        ]);
        const role = yield* writeRoleCreation({
          catalogSnapshotId: release.id,
          cells: cellsOf(capabilityKeys, options.mode, options.targets),
          decidedAt: yield* DateTime.nowAsDate,
          name: `E2E ${capabilityKeys.join('+')}`,
          scope: ownerScope,
          targetRevisionId: RoleRevisionIdSchema.make(revisionUuid),
          targetRoleId: RoleIdSchema.make(roleUuid),
        }).pipe(Effect.provideContext(graph.context));
        const incarnationId = AssignmentIncarnationIdSchema.make(incarnationUuid);
        yield* people.assignRole(ownerScope, {
          incarnationId,
          principalId: PrincipalIdSchema.make(person.principalId),
          roleId: role.roleId,
          roleRevisionId: role.roleRevisionId,
          scopeId: tenantScope,
        });
        return { incarnationId };
      }).pipe(Effect.orDie);
    const revoke: MediaE2eWorld['revoke'] = (incarnationId) =>
      people.unassignRole(ownerScope, { incarnationId }).pipe(Effect.asVoid, Effect.orDie);
    return { grant, revoke, tenantScope };
  });

/** The named people are members of the tenant (the owner's own act, through the real store) and hold nothing yet. */
const recordMembers = (
  graph: AccessGraph,
  ownerScope: OperationalScope,
  tenantScope: ReturnType<typeof tenantContextScopeId>,
  members: readonly E2eActor[],
) =>
  Effect.gen(function* recordTenantMembers() {
    const crypto = yield* Crypto.Crypto;
    const now = yield* DateTime.now;
    const memberships = [];
    for (const actor of members) {
      memberships.push({
        createdAt: DateTime.toDateUtc(now),
        holder: { _tag: 'Principal' as const, principalId: PrincipalIdSchema.make(actor.principalId) },
        id: AccessMembershipIdSchema.make(yield* crypto.randomUUIDv4()),
        kind: 'member' as const,
        recordedBy: PrincipalIdSchema.make(ownerScope.principalId),
        scopeId: AccessScopeIdSchema.make(tenantScope),
        status: 'active' as const,
        tenantId: TenantIdSchema.make(ownerScope.tenantId),
        validFrom: DateTime.toDateUtc(DateTime.subtract(now, MEMBERSHIP_HEADROOM)),
      });
    }
    yield* Context.get(graph.context, AccessMembershipStore).recordMemberships(ownerScope, { memberships });
  }).pipe(Effect.orDie);

/**
 * What an enrolment of the fixture may differ in, to show which look-alikes are NOT an enrolment: the principal kind
 * (the stage accounts file's `workloads` entry binds a person or a service, never a `system` principal) and its status.
 */
export interface SystemWorkloadEnrolmentOptions {
  readonly kind?: 'service' | 'system';
  readonly status?: 'active' | 'archived' | 'disabled';
}

/** A principal of the tenant (a `system` one by default) with one active binding for one workload key, written as the operator's install would. */
const enrolSystemWorkloadOf = (admin: PgClient.PgClient) =>
  Effect.fn('MediaE2e.enrolSystemWorkload')(function* enrolSystemWorkload(
    workloadKey: string,
    tenantId: string,
    options: SystemWorkloadEnrolmentOptions = {},
  ) {
    const crypto = yield* Crypto.Crypto;
    const [principalId, bindingId, incarnation] = yield* Effect.all([
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
    ]);
    yield* admin.unsafe(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
           values ($1::uuid, $2::uuid, $3, $4, $5)`,
      [principalId, tenantId, options.kind ?? 'system', `E2E workload ${workloadKey}`, options.status ?? 'active'],
    );
    yield* admin.unsafe(
      `insert into core.access_workload_bindings (binding_id, tenant_id, principal_id, workload_key, incarnation, status)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'active')`,
      [bindingId, tenantId, principalId, workloadKey, incarnation],
    );
    return { principalId };
  }, Effect.orDie);

/** Enrols the one principal, then obtains the trusted context only Core's own resolver can construct (as the Shell host does). */
const bindSystemWorkloadOf = (
  admin: PgClient.PgClient,
  resolver: ReturnType<typeof makeSystemPrincipalContextResolver>,
  tenantId: string,
) =>
  Effect.fn('MediaE2e.bindSystemWorkload')(function* bindSystemWorkload(workloadKey: string) {
    const { principalId } = yield* enrolSystemWorkloadOf(admin)(workloadKey, tenantId);
    const principal = yield* resolver.resolveEnrolled({
      registration: registerSystemWorkload({ jobKey: workloadKey }),
      runReference: 'e2e',
      tenantId,
    });
    return { principal, principalId };
  }, Effect.orDie);

/** CONTROLLED FAULT INJECTION: the stored bytes of one asset are replaced at the emulator, outside every Core path. */
const replaceStored = (storage: OpenedStorage, tenantId: string) =>
  Effect.fn('MediaE2e.replaceStoredObject')(
    function* replaceStoredObject(mediaAssetId: string, bytes: Uint8Array) {
      const settings = storage.direct;
      const key = deriveMediaStorageKey({ mediaAssetId, tenantId });
      const client = yield* HttpClient.HttpClient;
      const url = new URL(`${settings.endpoint.origin}/${settings.bucket}/${key}`);
      const clock = yield* client.execute(HttpClientRequest.get(settings.endpoint.href));
      const headers = signS3Request({
        accessKeyId: settings.accessKeyId,
        headers: {},
        method: 'DELETE',
        now: DateTime.makeUnsafe(clock.headers['date'] ?? ''),
        payloadSha256: EMPTY_PAYLOAD_SHA256,
        region: settings.region,
        secretAccessKey: settings.secretAccessKey,
        url,
      });
      yield* client.execute(HttpClientRequest.make('DELETE')(url.href).pipe(HttpClientRequest.setHeaders(headers)));
      yield* storage.directStorage.put({ body: Stream.make(bytes), contentType: 'application/octet-stream', key });
    },
    Effect.provide(FetchHttpClient.layer),
    Effect.orDie,
  );

/** What the run must be configured with; without it the scenario is skipped (BLOCKED), never run against a guess. */
const REQUIRED_ENVIRONMENT = [
  'CORE_MEDIA_S3_ENDPOINT',
  'ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL',
  'SPICEDB_ENDPOINT',
] as const;

/**
 * A scenario the run cannot execute is skipped (BLOCKED), unless the run states it must execute them all
 * (`D20_E2E_REQUIRED=1`, the gated run): then a skip is a failure, so a missing relay or emulator can never read as green.
 */
export const skipScenario = (ctx: { readonly skip: (note?: string) => void }, note: string) =>
  Effect.gen(function* skipOrFail() {
    const mustRun = yield* Config.option(Config.String('D20_E2E_REQUIRED')).pipe(Effect.orDie);
    if (Option.isSome(mustRun) && mustRun.value === '1') {
      return yield* Effect.die(`D20_E2E_REQUIRED is set but the scenario cannot run: ${note}`);
    }
    yield* Effect.sync(() => {
      ctx.skip(note);
    });
    return yield* Effect.never;
  });

const requireEnvironment = (ctx: { readonly skip: (note?: string) => void }, names: readonly string[]) =>
  Effect.gen(function* checkEnvironment() {
    const missing: string[] = [];
    for (const name of names) {
      if (Option.isNone(yield* Config.option(Config.String(name)).pipe(Effect.orDie))) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      yield* skipScenario(ctx, `BLOCKED: the run is not configured with ${missing.join(', ')}`);
    }
  });

/** One E2E world: a cloned database, two tenants through the real install path, and the real engine. */
export const withMediaE2eWorld = <Value, Failure>(
  ctx: { readonly skip: (note?: string) => void },
  platform: E2ePlatform,
  run: (world: MediaE2eWorld) => Effect.Effect<Value, Failure>,
  options: { readonly contracts?: readonly unknown[]; readonly requires?: readonly string[] } = {},
) =>
  Effect.scoped(
    Effect.gen(function* mediaE2eWorld() {
      yield* requireEnvironment(ctx, [...REQUIRED_ENVIRONMENT, ...(options.requires ?? [])]);
      const crypto = yield* Crypto.Crypto;
      const catalog = yield* loadCatalog;
      const storage = yield* openStorage;
      const faultInjection = yield* openFaultInjection(storage);
      yield* writeEngineSchema(yield* loadSpiceDbConfig().pipe(Effect.orDie));
      const { admin, caseAdminUrl, databases, runtimeUrl } = yield* openCaseDatabase;
      const graph = yield* openAccessGraph(runtimeUrl);
      const adminConfiguration = yield* parseDatabaseConfig({ DATABASE_URL: caseAdminUrl }).pipe(Effect.orDie);
      const adminContext = yield* Layer.build(
        CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, adminConfiguration))),
      );
      const composition = yield* publishComposition(
        platform,
        Context.get(adminContext, CoreDatabase).executor,
        options.contracts ?? [],
      );

      const tenantId = yield* crypto.randomUUIDv4();
      const foreignTenantId = yield* crypto.randomUUIDv4();
      const roster = yield* rosterOf(tenantId, 'own');
      const foreignRoster = yield* rosterOf(foreignTenantId, 'foreign');
      // The real install path: identity rows, the derived `core.media` installation row and the owner's access.
      yield* reconcileStageContextBootstraps(
        { retiredTenants: [], tenants: [roster.bootstrap, foreignRoster.bootstrap] },
        { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID, modules: catalog },
      ).pipe(
        Effect.provide(graph.context),
        Effect.mapError((cause) => failure(`stage install refused: ${cause.message}`)),
        Effect.orDie,
      );
      const ownerScope = yield* scopeOf(yield* required(roster.actors.get('owner'), 'owner'));
      const commands = yield* openAccessCommands(graph, ownerScope);
      yield* recordMembers(
        graph,
        ownerScope,
        commands.tenantScope,
        [...roster.actors.values()].filter((actor) => actor.name !== 'owner'),
      );
      const runtimes = yield* openRuntimes(platform, graph);

      const principals = new Map<string, TrustedPrincipalContext>();
      for (const actor of [...roster.actors.values(), ...foreignRoster.actors.values()]) {
        principals.set(actor.principalId, yield* principalOf(actor));
      }

      return yield* run({
        actions: runtimes.actions,
        admin,
        bindSystemWorkload: (workloadKey) =>
          bindSystemWorkloadOf(
            admin,
            makeSystemPrincipalContextResolver({ executor: Context.get(adminContext, CoreDatabase).executor }),
            tenantId,
          )(workloadKey).pipe(Effect.provideService(Crypto.Crypto, crypto)),
        compositionRevision: composition.composition.revision,
        databases,
        enrolSystemWorkload: (workloadKey, enrolledTenantId, enrolment) =>
          enrolSystemWorkloadOf(admin)(workloadKey, enrolledTenantId, enrolment).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          ),
        faultInjection,
        foreign: foreignRoster.actors,
        grant: commands.grant,
        people: roster.actors,
        reads: runtimes.reads,
        replaceStoredObject: replaceStored(storage, tenantId),
        revoke: commands.revoke,
        shell: mountShell(platform, { databases, principals }),
        shellWithLogs: (logs) => tapConsole(logs).pipe(Effect.andThen(mountShell(platform, { databases, principals }))),
        storage: storage.directStorage,
        tenantId,
        withStorage: (effect) => Effect.provideService(effect, ObjectStorage, storage.shellFacingStorage),
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
