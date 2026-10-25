import {
  DATABASE_IDENTITIES,
  TRUST_ROUTINES,
  APP_DATABASE_IDENTITY_ENROLLMENT,
} from '../../database/identity-enrollment.ts';
import {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
} from '@app/party-registry/database-identities';
import { randomBytes, randomUUID } from 'node:crypto';

import { PgAuth, PgProtocol } from '@effect/sql-pg';
import type { PgClient } from '@effect/sql-pg';
import { NodeSocket } from '@effect/platform-node';
import { Array as EffectArray, Clock, Data, Effect, Match, Option, Order, Redacted, Schema } from 'effect';
import type { Result } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import type { Writer } from 'effect/unstable/socket/Socket';
import type { SqlError } from 'effect/unstable/sql/SqlError';

import { findPostgresFailure } from '../../packages/core-runtime/src/database/postgres-failure.ts';
import { TrustedPrincipalContextSchema } from '../../packages/core-runtime/src/actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../../packages/core-runtime/src/actions/principal-context.ts';
import { AuthenticationNamespaceIdSchema } from '../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../packages/core-runtime/src/auth/external-identity/verifier.ts';
import {
  readVerifiedGatewayScopeAssertion,
  trustVerifiedGatewayPrincipalContext,
} from '../../packages/core-runtime/src/auth/system-principal-context-provenance.ts';
import { loadDatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import {
  BEARER_ASSERTION_ROLE_SETTINGS,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../../packages/core-runtime/src/db/database-identities.ts';
import { coreRelations } from '../../packages/core-runtime/src/db/schema.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../packages/core-runtime/src/operations/context.ts';
import { OperationContextDenied } from '../../packages/core-runtime/src/operations/errors.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
  makeTestPgSession,
} from '../../packages/core-runtime/tests/support/database.ts';

const partyAudience = PARTY_REGISTRY_REQUEST_IDENTITY.gatewayScopeAudiences[0] ?? 'party-registry';
const probeAudience = 'probe-audience';
const tenantId = randomUUID();
const legalEntityId = randomUUID();
const principalId = randomUUID();
const disabledPrincipalId = randomUUID();
const otherTenantId = randomUUID();
const otherTenantPrincipalId = randomUUID();
const otherTenantLegalEntityId = randomUUID();
const otherScopeId = randomUUID();
const runtimeRoles = DATABASE_IDENTITIES.map(({ role }) => role);
const trustTables = [
  { column: 'key_id', table: 'trust.scope_sealing_keys' },
  { column: 'audience', table: 'trust.gateway_audience_roles' },
  { column: 'audience', table: 'trust.gateway_scope_grants' },
] as const;
const internalRoutineCalls = [
  "select trust.scope_mac('payload')",
  'select trust.scope_payload(pg_catalog.pg_current_xact_id(), pg_catalog.clock_timestamp(), gen_random_uuid(), null)',
  'select * from trust.verified_scope()',
] as const;

const registerSql = `select trust.register_gateway_scope_grant(
  $1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, pg_catalog.to_timestamp($7::double precision)
)`;
const establishSql = 'select established_tenant_id, established_legal_entity_id from trust.establish_gateway_scope($1)';
const accessorsSql =
  'select trust.current_tenant_id() as tenant_id, trust.current_legal_entity_id() as legal_entity_id';
const sealSql = "select pg_catalog.current_setting('ontos_trust.scope', true) as seal";
const setLocalSealSql = "select pg_catalog.set_config('ontos_trust.scope', $1, true)";
const setSessionSealSql = "select pg_catalog.set_config('ontos_trust.scope', $1, false)";

interface Scope {
  readonly legal_entity_id: string | null;
  readonly tenant_id: string | null;
}

const base64url = (value: string): string => Buffer.from(value).toString('base64url');

/** The `principal` claim the Shell issuer signs. */
interface PrincipalClaim {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** The assertion claims the database binds to the registration arguments. */
interface AssertionClaims {
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly jti: string;
  readonly principal?: PrincipalClaim;
  readonly sub: string;
}

/** A compact assertion carrying `claims`; its signature is never verified in the database. */
const compactAssertion = (claims: AssertionClaims): string =>
  [
    base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })),
    base64url(JSON.stringify(claims)),
    randomBytes(32).toString('base64url'),
  ].join('.');

interface GrantOptions {
  readonly assertion?: string;
  readonly audience?: string;
  /** Rewrites the assertion claims after they are derived from the arguments. */
  readonly claims?: (claims: AssertionClaims) => AssertionClaims;
  readonly jti?: string;
  readonly lifetimeSeconds?: number;
  readonly principalId?: string;
  readonly scopeLegalEntityId?: string | null;
  readonly scopeTenantId?: string;
}

interface GrantArguments {
  readonly assertion: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly jti: string;
  readonly legalEntityId: string | null;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Derives the registration arguments and the matching assertion, as the Shell issuer does. */
const grantArguments = (options: GrantOptions = {}) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now): GrantArguments => {
      const audience = options.audience ?? partyAudience;
      const jti = options.jti ?? randomUUID();
      const grantPrincipalId = options.principalId ?? principalId;
      const grantTenantId = options.scopeTenantId ?? tenantId;
      const grantLegalEntityId = options.scopeLegalEntityId === undefined ? legalEntityId : options.scopeLegalEntityId;
      const expiresAt = Math.floor(now / 1000) + (options.lifetimeSeconds ?? 120);
      const principal: PrincipalClaim =
        grantLegalEntityId === null
          ? { principalId: grantPrincipalId, tenantId: grantTenantId }
          : { legalEntityId: grantLegalEntityId, principalId: grantPrincipalId, tenantId: grantTenantId };
      const derived: AssertionClaims = { aud: audience, exp: expiresAt, jti, principal, sub: grantPrincipalId };
      const claims = options.claims === undefined ? derived : options.claims(derived);
      return {
        assertion: options.assertion ?? compactAssertion(claims),
        audience,
        expiresAt,
        jti,
        legalEntityId: grantLegalEntityId,
        principalId: grantPrincipalId,
        tenantId: grantTenantId,
      };
    }),
  );

/** Replaces the `principal` claim while keeping every other derived claim. */
const withPrincipalClaim =
  (principal: PrincipalClaim) =>
  (claims: AssertionClaims): AssertionClaims => ({ ...claims, principal });

/** An assertion that was never registered. */
const unregisteredAssertion = () => grantArguments().pipe(Effect.map(({ assertion }) => assertion));

const registerGrant = (issuer: PgClient.PgClient, options: GrantOptions = {}) =>
  grantArguments(options).pipe(
    Effect.flatMap((grant) =>
      issuer
        .unsafe(registerSql, [
          grant.assertion,
          grant.audience,
          grant.jti,
          grant.principalId,
          grant.tenantId,
          grant.legalEntityId,
          grant.expiresAt,
        ])
        .pipe(Effect.as(grant.assertion)),
    ),
  );

const expectSqlState =
  (code: string) =>
  (operation: Effect.Effect<unknown, unknown>): Effect.Effect<void, unknown> =>
    operation.pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(Option.getOrUndefined(findPostgresFailure(failure))?.code, String(failure)).toBe(code),
      ),
    );

/** Runs `body` inside one explicit transaction on a single-connection session. */
const inTransaction = function inTransaction<Value, Failure>(
  session: PgClient.PgClient,
  body: Effect.Effect<Value, Failure>,
  begin = 'begin',
): Effect.Effect<Value, Failure | SqlError> {
  return session.unsafe(begin).pipe(
    Effect.andThen(body),
    Effect.tap(() => session.unsafe('commit')),
    Effect.onError(() => session.unsafe('rollback').pipe(Effect.ignore)),
  );
};

const establish = (session: PgClient.PgClient, assertion: string) =>
  session.unsafe<{ established_legal_entity_id: string | null; established_tenant_id: string }>(establishSql, [
    assertion,
  ]);
const accessors = (session: PgClient.PgClient) =>
  session.unsafe<Scope>(accessorsSql).pipe(Effect.map(([scope]) => scope));
const currentSeal = (session: PgClient.PgClient) =>
  session.unsafe<{ seal: string | null }>(sealSql).pipe(Effect.map(([row]) => row?.seal ?? null));

class SimpleQueryFailure extends Data.TaggedError('SimpleQueryFailure')<{ readonly message: string }> {}

const AdmissionProbeFailure = Data.TaggedError('AdmissionProbeFailure')<{
  readonly cause: unknown;
  readonly message: string;
}>;

const admissionProbe = function admissionProbe<Value, Failure, Services>(
  stage:
    | `dedicated-${'session' | 'oauth_connection' | 'api_key'}`
    | `shared-${'session' | 'oauth_connection' | 'api_key'}`,
  operation: Effect.Effect<Value, Failure, Services>,
) {
  return operation.pipe(
    Effect.mapError(
      (cause) =>
        new AdmissionProbeFailure({
          cause,
          message: `admission-stage: ${stage}; SQLSTATE: ${Option.getOrUndefined(findPostgresFailure(cause, ({ code }) => /^[0-9A-Z]{5}$/u.test(code)))?.code ?? 'unavailable'}`,
        }),
    ),
  );
};

type BackendMessage = PgProtocol.BackendMessage<string | null>;
type SimpleQueryRow = readonly (string | null)[];

interface SimpleQueryOutcome {
  readonly errorCode: string | null;
  readonly rows: readonly SimpleQueryRow[];
}

/** Mutable progress of one raw simple-query exchange. */
interface SimpleQueryConnection {
  done: boolean;
  errorCode: string | null;
  readonly password: string;
  queried: boolean;
  readonly rows: SimpleQueryRow[];
  scramFinal: PgAuth.ScramFinal | null;
  scramFirst: PgAuth.ScramFirst | null;
  readonly text: string;
  readonly user: string;
  readonly writer: Writer;
}

const queryFailure = (message: string) => new SimpleQueryFailure({ message });

const succeedOrFail = function succeedOrFail<A, E>(result: Result.Result<A, E>, message: string) {
  return Effect.fromResult(result).pipe(Effect.mapError(() => queryFailure(message)));
};

const encodeSimpleQuery = (text: string): Uint8Array => {
  const body = new TextEncoder().encode(text);
  const message = new Uint8Array(body.length + 6);
  message[0] = 0x51;
  new DataView(message.buffer).setInt32(1, body.length + 5);
  message.set(body, 5);
  return message;
};

const send = (connection: SimpleQueryConnection, bytes: Uint8Array) => connection.writer.write(new Uint8Array(bytes));

const startScram = (connection: SimpleQueryConnection) =>
  Effect.gen(function* scramStart() {
    const first = yield* succeedOrFail(
      PgAuth.scramInit({ nonce: randomBytes(18).toString('base64'), password: connection.password }),
      'SCRAM initialisation failed',
    );
    connection.scramFirst = first.state;
    yield* send(
      connection,
      PgProtocol.encodeSASLInitialResponse({ initialResponse: first.response, mechanism: PgAuth.SCRAM_SHA_256 }),
    );
  });

const continueScram = (connection: SimpleQueryConnection, challenge: Uint8Array) =>
  connection.scramFirst === null
    ? Effect.fail(queryFailure('Unexpected SCRAM challenge'))
    : succeedOrFail(PgAuth.scramContinue(connection.scramFirst, challenge), 'SCRAM challenge rejected').pipe(
        Effect.flatMap((proof) => {
          connection.scramFinal = proof.state;
          return send(connection, PgProtocol.encodeSASLResponse({ data: proof.response }));
        }),
      );

const finishScram = (connection: SimpleQueryConnection, signature: Uint8Array) =>
  connection.scramFinal === null
    ? Effect.fail(queryFailure('Unexpected SCRAM signature'))
    : succeedOrFail(PgAuth.scramFinish(connection.scramFinal, signature), 'SCRAM server signature rejected');

const md5Authenticate = (connection: SimpleQueryConnection, salt: Uint8Array) =>
  succeedOrFail(
    PgAuth.md5Password({ password: connection.password, salt, user: connection.user }),
    'MD5 authentication failed',
  ).pipe(Effect.flatMap((password) => send(connection, PgProtocol.encodePasswordMessage({ password }))));

const recordError = (
  connection: SimpleQueryConnection,
  fields: { readonly code?: string | undefined; readonly message?: string | undefined },
) =>
  connection.queried
    ? Effect.sync(() => {
        connection.errorCode ??= fields.code ?? null;
      })
    : Effect.fail(queryFailure(fields.message ?? 'startup failed'));

const onReady = (connection: SimpleQueryConnection) =>
  Effect.gen(function* readyForQuery() {
    if (connection.queried) {
      connection.done = true;
      yield* send(connection, PgProtocol.encodeTerminate());
    } else {
      connection.queried = true;
      yield* send(connection, encodeSimpleQuery(connection.text));
    }
  });

const handleMessage = (connection: SimpleQueryConnection, message: BackendMessage) =>
  Match.value(message).pipe(
    Match.tag('AuthenticationCleartextPassword', () =>
      send(connection, PgProtocol.encodePasswordMessage({ password: connection.password })),
    ),
    Match.tag('AuthenticationMD5Password', ({ salt }) => md5Authenticate(connection, salt)),
    Match.tag('AuthenticationSASL', () => startScram(connection)),
    Match.tag('AuthenticationSASLContinue', ({ data }) => continueScram(connection, data)),
    Match.tag('AuthenticationSASLFinal', ({ data }) => finishScram(connection, data)),
    Match.tag('AuthenticationUnsupported', ({ method }) =>
      Effect.fail(queryFailure(`Unsupported authentication method ${String(method)}`)),
    ),
    Match.tag('DataRow', ({ values }) =>
      Effect.sync(() => {
        connection.rows.push([...values]);
      }),
    ),
    Match.tag('ErrorResponse', ({ fields }) => recordError(connection, fields)),
    Match.tag('ReadyForQuery', () => onReady(connection)),
    Match.orElse(() => Effect.void),
  );

/**
 * Sends one parameterless simple-query message on a dedicated connection. @effect/sql-pg only speaks
 * the extended protocol, so this helper drives its protocol codec and SCRAM implementation directly.
 */
const simpleQuery = (connectionString: string, text: string) =>
  Effect.gen(function* rawSimpleQuery() {
    const url = new URL(connectionString);
    const user = decodeURIComponent(url.username);
    const decoder = new TextDecoder();
    const parser = PgProtocol.makeParser<string | null>({
      readField: (bytes, offset, size) => (size < 0 ? null : decoder.decode(bytes.subarray(offset, offset + size))),
    });
    const socket = yield* NodeSocket.makeNet({ host: url.hostname, port: Number(url.port || '5432') });
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const connection: SimpleQueryConnection = {
      done: false,
      errorCode: null,
      password: decodeURIComponent(url.password),
      queried: false,
      rows: [],
      scramFinal: null,
      scramFirst: null,
      text,
      user,
      writer,
    };
    yield* send(
      connection,
      PgProtocol.encodeStartupMessage({ database: decodeURIComponent(url.pathname.slice(1)), user }),
    );
    while (!connection.done) {
      const chunks = yield* reader.pull;
      const messages = yield* Effect.try({
        catch: (error) => queryFailure(String(error)),
        try: () => {
          const received: BackendMessage[] = [];
          for (const chunk of chunks) {
            parser.pushEach(Buffer.from(chunk), (message) => {
              received.push(message);
            });
          }
          return received;
        },
      });
      yield* Effect.forEach(messages, (message) => handleMessage(connection, message), { discard: true });
    }
    return { errorCode: connection.errorCode, rows: connection.rows } satisfies SimpleQueryOutcome;
  }).pipe(Effect.scoped);

const fixture = Effect.gen(function* trustedScopeFixture() {
  const connections = yield* loadDatabaseIdentityConnections({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT });
  const issuerConnection = connections.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id];
  const partyConnection = connections.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id];
  const sharedConnection = connections.runtime[SHARED_RUNTIME_IDENTITY.id];
  const workerConnection = connections.runtime[PARTY_REGISTRY_WORKER_IDENTITY.id];
  assert.isOk(issuerConnection !== undefined);
  assert.isOk(partyConnection !== undefined);
  assert.isOk(sharedConnection !== undefined);
  assert.isOk(workerConnection !== undefined);
  const urls = {
    issuer: issuerConnection.connectionString,
    party: partyConnection.connectionString,
    shared: sharedConnection.connectionString,
    worker: workerConnection.connectionString,
  };
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const tenants = [tenantId, otherTenantId];
  const tenantArray = `{${tenants.join(',')}}`;
  yield* admin.unsafe(
    `insert into core.tenants (tenant_id, slug, name, status, default_locale)
     select id, 'trust-scope-' || id::text, 'Trust scope tenant', 'active', 'en'
       from pg_catalog.unnest(array[$1::uuid, $2::uuid]) as id
     on conflict (tenant_id) do nothing`,
    tenants,
  );
  yield* admin.unsafe(
    `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
     values ($1::uuid, $4::uuid, 'human', 'Active principal', 'active'),
            ($2::uuid, $4::uuid, 'human', 'Disabled principal', 'disabled'),
            ($3::uuid, $5::uuid, 'human', 'Other tenant principal', 'active')
     on conflict (principal_id) do nothing`,
    [principalId, disabledPrincipalId, otherTenantPrincipalId, tenantId, otherTenantId],
  );
  yield* admin.unsafe(
    `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
     values ($1::uuid, $3::uuid, 'Trust scope entity', 'CZ', $1::text, 'active'),
            ($2::uuid, $4::uuid, 'Other tenant entity', 'CZ', $2::text, 'active')
     on conflict (legal_entity_id) do nothing`,
    [legalEntityId, otherTenantLegalEntityId, tenantId, otherTenantId],
  );
  yield* Effect.addFinalizer(() =>
    Effect.all(
      [
        admin.unsafe('delete from trust.gateway_scope_grants where tenant_id = any($1::uuid[])', [tenantArray]),
        admin.unsafe('delete from trust.gateway_audience_roles where audience = $1', [probeAudience]),
        admin.unsafe('delete from core.legal_entities where tenant_id = any($1::uuid[])', [tenantArray]),
        admin.unsafe('delete from core.principals where tenant_id = any($1::uuid[])', [tenantArray]),
        admin.unsafe('delete from core.tenants where tenant_id = any($1::uuid[])', [tenantArray]),
      ],
      { concurrency: 1 },
    ).pipe(Effect.orDie),
  );
  const issuer = yield* makeTestPgClient(urls.issuer);
  const shared = yield* makeTestPgClient(urls.shared);
  const worker = yield* makeTestPgClient(urls.worker);
  const partyPool = yield* makeTestPgClient(urls.party);
  const party = yield* makeTestPgSession(urls.party);
  const otherParty = yield* makeTestPgSession(urls.party);
  return { admin, issuer, otherParty, party, partyPool, shared, urls, worker };
});

/** Moves a grant's lifetime so its establish deadline (`expires_at + 30 s`) lands `deadlineSeconds` from now. */
const shiftGrant = (
  admin: PgClient.PgClient,
  assertion: string,
  registeredAgoSeconds: number,
  deadlineSeconds: number,
) =>
  admin.unsafe(
    `update trust.gateway_scope_grants
        set registered_at = pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => $2::double precision),
            expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $3::double precision)
      where assertion_digest = pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8'))`,
    [assertion, registeredAgoSeconds, deadlineSeconds - 30],
  );

const expectedScope: Scope = { legal_entity_id: legalEntityId, tenant_id: tenantId };
const emptyScope: Scope = { legal_entity_id: null, tenant_id: null };

it.live('the dedicated Party identity admits session, OAuth and agent scope without raw identity audit access', () =>
  Effect.gen(function* dedicatedIdentityAdmission() {
    const { admin, issuer, party, partyPool, shared } = yield* fixture;
    const agentId = randomUUID();
    const siblingEntityId = randomUUID();
    const invocationId = randomUUID();
    const namespace = AuthenticationNamespaceIdSchema.make('trust-scope-admission');
    const agentBinding = {
      authMethod: 'api_key',
      id: randomUUID(),
      principalId: agentId,
      subjectType: 'api_key',
    } as const;
    const bindings = [
      { authMethod: 'session', id: randomUUID(), principalId, subjectType: 'user' },
      { authMethod: 'oauth_connection', id: randomUUID(), principalId, subjectType: 'oauth_grant' },
      agentBinding,
    ] as const;
    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          admin.unsafe('delete from core.audit_events where action_invocation_id = $1::uuid', [invocationId]),
          admin.unsafe('delete from core.principal_auth_bindings where authentication_namespace_id = $1', [namespace]),
          admin.unsafe('delete from core.action_invocations where action_invocation_id = $1::uuid', [invocationId]),
          admin.unsafe('delete from core.principals where principal_id = $1::uuid', [agentId]),
          admin.unsafe('delete from core.legal_entities where legal_entity_id = $1::uuid', [siblingEntityId]),
        ],
        { concurrency: 1 },
      ).pipe(Effect.orDie),
    );
    yield* admin.unsafe(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
       values ($1::uuid, $2::uuid, 'agent', 'Company-issued agent', 'active')`,
      [agentId, tenantId],
    );
    yield* admin.unsafe(
      `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
       values ($1::uuid, $2::uuid, 'Sibling company', 'CZ', $1::text, 'active')`,
      [siblingEntityId, tenantId],
    );
    yield* admin.unsafe(
      `insert into core.action_invocations (action_invocation_id, tenant_id, legal_entity_id, principal_id,
         auth_method, action_key, status, request_hash)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'system',
         'core.identity.bind-managed-api-key', 'succeeded', 'identity-attestation-probe')`,
      [invocationId, tenantId, legalEntityId, principalId],
    );
    yield* admin.unsafe(
      `insert into core.audit_events (tenant_id, legal_entity_id, action_invocation_id, principal_id,
         auth_method, event_type, outcome, outcome_stage, outcome_code, audit_profile, evidence_json)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'system', 'action.executed',
         'succeeded', 'execution', 'ok', 'standard', '{"actionKey":"core.identity.bind-managed-api-key"}'::jsonb)`,
      [tenantId, legalEntityId, invocationId, principalId],
    );
    for (const binding of bindings) {
      yield* admin.unsafe(
        `insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id,
           authentication_namespace_id, provider, subject_type, provider_subject_id, status, created_by_invocation_id)
         values ($1::uuid, $2::uuid, $3::uuid, $4, 'trust-scope-probe', $5, $1::text, 'active', $6::uuid)`,
        [binding.id, tenantId, binding.principalId, namespace, binding.subjectType, invocationId],
      );
    }
    const executor = yield* makeTestDatabaseFromClient(partyPool, coreRelations);
    const repository = makeOperationalScopeRepository({ executor }, APP_DATABASE_IDENTITY_ENROLLMENT);
    const resolver = makeOperationalScopeResolver(repository, {
      legalEntities: ({ legalEntityIds }) =>
        Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
    });
    const registry = makeAuthenticationNamespaceRegistry([
      {
        allowedAudiences: [partyAudience],
        authenticationNamespaceId: namespace,
        provider: 'trust-scope-probe',
        requiresOperationAdmission: false,
        reservationPrincipalKind: 'human',
        subjectTypes: ['user', 'oauth_grant', 'api_key'],
        trustedAttesterPrincipalIds: [],
      },
    ]);
    const resolve = (principal: TrustedPrincipalContext) =>
      resolver
        .resolve({
          audience: partyAudience,
          correlationId: 'dedicated-role-admission',
          legalEntityScope: 'required',
          principal,
        })
        .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
    const principalFor = (binding: (typeof bindings)[number], entityId: string): TrustedPrincipalContext => {
      const principal: TrustedPrincipalContext = {
        authBindingId: binding.id,
        authContextRef: binding.authMethod === 'oauth_connection' ? `oauth-grant:${binding.id}` : `probe-${binding.id}`,
        authenticationNamespaceId: namespace,
        authMethod: binding.authMethod,
        legalEntityId: entityId,
        principalId: binding.principalId,
        tenantId,
      };
      if (binding.authMethod !== 'oauth_connection') {
        return principal;
      }
      return {
        ...principal,
        connection: {
          clientId: 'scope-admission-client',
          clientName: 'Scope admission client',
          grantId: binding.id,
          modules: [],
          writePolicy: 'read_only',
        },
      };
    };
    const gatewayPrincipal = Effect.fn('gatewayPrincipal')(function* gatewayPrincipalEffect(
      binding: (typeof bindings)[number],
      entityId: string = legalEntityId,
    ) {
      const assertion = yield* registerGrant(issuer, {
        principalId: binding.principalId,
        scopeLegalEntityId: entityId,
      });
      return trustVerifiedGatewayPrincipalContext(principalFor(binding, entityId), 'a'.repeat(64), {
        assertion: Redacted.make(assertion),
        audience: partyAudience,
      });
    });
    for (const binding of bindings) {
      const principal = yield* gatewayPrincipal(binding);
      expect(Schema.is(TrustedPrincipalContextSchema)(principal)).toBe(true);
      expect(readVerifiedGatewayScopeAssertion(principal)?.audience).toBe(partyAudience);
      const resolved = yield* admissionProbe(`dedicated-${binding.authMethod}`, resolve(principal));
      expect(resolved.principalId).toBe(binding.principalId);
      expect(resolved.authMethod).toBe(binding.authMethod);
    }
    // Audiences without a gateway-grant identity retain their manifest's shared authority.
    // They must not call the Party-only attestation routine merely because provenance is retained.
    const sharedExecutor = yield* makeTestDatabaseFromClient(shared, coreRelations);
    const sharedRepository = makeOperationalScopeRepository(
      { executor: sharedExecutor },
      APP_DATABASE_IDENTITY_ENROLLMENT,
    );
    for (const binding of bindings) {
      const principal = trustVerifiedGatewayPrincipalContext(principalFor(binding, legalEntityId), 'a'.repeat(64), {
        assertion: Redacted.make('verified-non-party-assertion'),
        audience: 'catalog',
      });
      expect(Schema.is(TrustedPrincipalContextSchema)(principal)).toBe(true);
      expect(readVerifiedGatewayScopeAssertion(principal)?.audience).toBe('catalog');
      const persisted = yield* admissionProbe(`shared-${binding.authMethod}`, sharedRepository.load(principal));
      expect(persisted.principalTenantId).toBe(tenantId);
      expect(persisted.bindingPrincipalId).toBe(binding.principalId);
      expect(persisted.bindingIssuingLegalEntityId).toBe(legalEntityId);
    }
    const wrongCompany = yield* gatewayPrincipal(agentBinding, siblingEntityId);
    expect(Schema.is(OperationContextDenied)(yield* Effect.flip(resolve(wrongCompany)))).toBe(true);
    const assertion = yield* registerGrant(issuer, { principalId: agentId });
    const attest = (bindingId: string, actingPrincipalId: string) =>
      party.unsafe<{ entity_id: string | null }>(
        'select trust.auth_binding_issuing_legal_entity($1::uuid, $2::uuid) as entity_id',
        [bindingId, actingPrincipalId],
      );
    expect(yield* attest(agentBinding.id, agentId)).toEqual([{ entity_id: null }]);
    expect(
      yield* inTransaction(
        party,
        establish(party, assertion).pipe(Effect.andThen(attest(agentBinding.id, principalId))),
      ),
    ).toEqual([{ entity_id: null }]);
    const foreignAssertion = yield* registerGrant(issuer, {
      principalId: otherTenantPrincipalId,
      scopeLegalEntityId: otherTenantLegalEntityId,
      scopeTenantId: otherTenantId,
    });
    expect(
      yield* inTransaction(
        party,
        establish(party, foreignAssertion).pipe(Effect.andThen(attest(agentBinding.id, agentId))),
      ),
    ).toEqual([{ entity_id: null }]);
    yield* expectSqlState('42501')(party.unsafe('select evidence_json from core.audit_events'));
    yield* expectSqlState('42501')(party.unsafe('select created_by_invocation_id from core.principal_auth_bindings'));
    yield* expectSqlState('42501')(
      shared.unsafe('select trust.auth_binding_issuing_legal_entity($1::uuid, $2::uuid)', [agentBinding.id, agentId]),
    );
    expect(
      yield* inTransaction(
        party,
        establish(party, assertion).pipe(
          Effect.andThen(
            party.unsafe('select action_invocation_id from core.audit_events where action_invocation_id = $1::uuid', [
              invocationId,
            ]),
          ),
        ),
      ),
    ).toEqual([]);
    yield* admin.unsafe('delete from core.audit_events where action_invocation_id = $1::uuid', [invocationId]);
    const unattested = yield* gatewayPrincipal(agentBinding);
    expect(Schema.is(OperationContextDenied)(yield* Effect.flip(resolve(unattested)))).toBe(true);
  }).pipe(Effect.scoped),
);

it.live('only the issuer registers well-formed, bounded, unique gateway scope grants', () =>
  Effect.gen(function* registration() {
    const { issuer, partyPool, shared, worker } = yield* fixture;
    yield* registerGrant(issuer);
    yield* registerGrant(issuer, { scopeLegalEntityId: null });
    for (const client of [shared, partyPool, worker]) {
      yield* expectSqlState('42501')(registerGrant(client));
    }
    for (const invalid of [
      { lifetimeSeconds: -1 },
      { lifetimeSeconds: 400 },
      { audience: 'unknown-audience' },
      { assertion: 'not-a-compact-assertion' },
    ] satisfies GrantOptions[]) {
      yield* expectSqlState('22023')(registerGrant(issuer, invalid));
    }
    const jti = randomUUID();
    yield* registerGrant(issuer, { jti });
    yield* expectSqlState('23505')(registerGrant(issuer, { jti }));
  }).pipe(Effect.scoped),
);

it.live('caps a registered grant at 300 seconds from registration', () =>
  Effect.gen(function* lifetimeCap() {
    const { admin, issuer } = yield* fixture;
    const assertion = yield* registerGrant(issuer, { lifetimeSeconds: 320 });
    const [grant] = yield* admin.unsafe<{ lifetime_seconds: number }>(
      `select extract(epoch from expires_at - registered_at)::float8 as lifetime_seconds
         from trust.gateway_scope_grants
        where assertion_digest = pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8'))`,
      [assertion],
    );
    expect(grant?.lifetime_seconds).toBe(300);
  }).pipe(Effect.scoped),
);

it.live('rejects registration arguments that differ from the assertion claims or the tenant directory', () =>
  Effect.gen(function* claimBinding() {
    const { issuer } = yield* fixture;
    const otherId = randomUUID();
    const mismatches: readonly (readonly [string, GrantOptions])[] = [
      ['audience claim', { claims: (claims) => ({ ...claims, aud: probeAudience }) }],
      ['audience claim as array', { claims: (claims) => ({ ...claims, aud: [partyAudience] }) }],
      ['expiry claim', { claims: (claims) => ({ ...claims, exp: 1 }) }],
      ['jti claim', { claims: (claims) => ({ ...claims, jti: otherId }) }],
      ['subject claim', { claims: (claims) => ({ ...claims, sub: otherId }) }],
      ['principal claim', { claims: withPrincipalClaim({ legalEntityId, principalId: otherId, tenantId }) }],
      ['tenant claim', { claims: withPrincipalClaim({ legalEntityId, principalId, tenantId: otherTenantId }) }],
      [
        'legal entity claim',
        { claims: withPrincipalClaim({ legalEntityId: otherTenantLegalEntityId, principalId, tenantId }) },
      ],
      ['missing legal entity claim', { claims: withPrincipalClaim({ principalId, tenantId }) }],
      [
        'unexpected legal entity claim',
        { claims: withPrincipalClaim({ legalEntityId, principalId, tenantId }), scopeLegalEntityId: null },
      ],
      ['missing principal claim', { claims: ({ aud, exp, jti, sub }) => ({ aud, exp, jti, sub }) }],
      [
        'non-JSON payload',
        { assertion: [base64url('{"alg":"EdDSA"}'), base64url('not json'), base64url('signature')].join('.') },
      ],
      ['unknown principal', { principalId: otherId }],
      ['disabled principal', { principalId: disabledPrincipalId }],
      ['principal of another tenant', { principalId: otherTenantPrincipalId }],
      ['legal entity of another tenant', { scopeLegalEntityId: otherTenantLegalEntityId }],
      ['unknown tenant', { scopeLegalEntityId: null, scopeTenantId: otherId }],
    ];
    for (const [mismatch, options] of mismatches) {
      const failure = yield* registerGrant(issuer, options).pipe(Effect.flip);
      expect(Option.getOrUndefined(findPostgresFailure(failure))?.code, mismatch).toBe('22023');
    }
  }).pipe(Effect.scoped),
);

it.live('only the audience role establishes a live registered grant', () =>
  Effect.gen(function* establishment() {
    const { admin, issuer, party, shared, worker } = yield* fixture;
    const assertion = yield* registerGrant(issuer);
    const [established, scope] = yield* inTransaction(
      party,
      Effect.all([establish(party, assertion), accessors(party)]),
    );
    expect(established).toEqual([{ established_legal_entity_id: legalEntityId, established_tenant_id: tenantId }]);
    expect(scope).toEqual(expectedScope);
    const tenantOnly = yield* registerGrant(issuer, { scopeLegalEntityId: null });
    expect(yield* inTransaction(party, establish(party, tenantOnly).pipe(Effect.andThen(accessors(party))))).toEqual({
      legal_entity_id: null,
      tenant_id: tenantId,
    });
    const [header, payload] = assertion.split('.');
    for (const unusable of [
      yield* unregisteredAssertion(),
      `${header}.${payload}.${randomBytes(32).toString('base64url')}`,
    ]) {
      yield* expectSqlState('42501')(inTransaction(party, establish(party, unusable)));
    }
    for (const client of [shared, worker, issuer]) {
      yield* expectSqlState('42501')(client.unsafe(establishSql, [assertion]).pipe(client.withTransaction));
    }
    const expired = yield* registerGrant(issuer);
    yield* shiftGrant(admin, expired, 90, -1);
    yield* expectSqlState('42501')(inTransaction(party, establish(party, expired)));
    yield* admin.unsafe('insert into trust.gateway_audience_roles (audience, role_name) values ($1, $2)', [
      probeAudience,
      SHARED_RUNTIME_IDENTITY.role,
    ]);
    const foreign = yield* registerGrant(issuer, { audience: probeAudience });
    yield* expectSqlState('42501')(inTransaction(party, establish(party, foreign)));
    yield* admin.unsafe('delete from trust.gateway_audience_roles where audience = $1', [probeAudience]);
  }).pipe(Effect.scoped),
);

it.live('forged, copied, replayed and overdue seals are rejected', () =>
  Effect.gen(function* sealAttacks() {
    const { admin, issuer, otherParty, party, urls } = yield* fixture;
    const assertion = yield* registerGrant(issuer);
    yield* expectSqlState('42501')(
      inTransaction(
        party,
        Effect.gen(function* zeroMac() {
          const [{ xid } = { xid: '0' }] = yield* party.unsafe<{ xid: string }>(
            'select pg_catalog.pg_current_xact_id()::text as xid',
          );
          const now = yield* Clock.currentTimeMillis;
          const deadline = (BigInt(now) + 60_000n) * 1000n;
          const forged = `v2|${xid}|${deadline}|${PARTY_REGISTRY_REQUEST_IDENTITY.role}|${tenantId}|-|${'0'.repeat(64)}`;
          yield* party.unsafe(`set local ontos_trust.scope = '${forged}'`);
          return yield* accessors(party);
        }),
      ),
    );
    const sealed = yield* inTransaction(party, establish(party, assertion).pipe(Effect.andThen(currentSeal(party))));
    expect(sealed).toMatch(/^v2\|/u);
    const seal = sealed ?? '';
    yield* expectSqlState('42501')(
      inTransaction(
        party,
        party
          .unsafe(setLocalSealSql, [seal])
          .pipe(
            Effect.andThen(party.unsafe('select pg_catalog.pg_current_xact_id()::text')),
            Effect.andThen(accessors(party)),
          ),
      ),
    );
    const live = yield* inTransaction(
      party,
      Effect.gen(function* crossBackend() {
        yield* establish(party, assertion);
        const liveSeal = (yield* currentSeal(party)) ?? '';
        yield* expectSqlState('42501')(
          inTransaction(
            otherParty,
            otherParty.unsafe(setLocalSealSql, [liveSeal]).pipe(Effect.andThen(accessors(otherParty))),
          ),
        );
        return yield* accessors(party);
      }),
    );
    expect(live).toEqual(expectedScope);

    const replay = `BEGIN; SELECT * FROM trust.establish_gateway_scope('${assertion}'); SELECT pg_catalog.set_config('ontos_trust.scope', pg_catalog.current_setting('ontos_trust.scope'), false); COMMIT;`;
    for (const secondTransaction of [
      'BEGIN; SELECT trust.current_tenant_id(); COMMIT;',
      'BEGIN; SELECT pg_catalog.pg_current_xact_id(); SELECT trust.current_tenant_id(); COMMIT;',
    ]) {
      const outcome = yield* simpleQuery(urls.party, `${replay} ${secondTransaction}`);
      expect(outcome.rows[0]).toEqual([tenantId, legalEntityId]);
      expect(outcome.errorCode).toBe('42501');
    }

    const overdue = yield* registerGrant(issuer);
    yield* shiftGrant(admin, overdue, 60, 2);
    yield* expectSqlState('42501')(
      inTransaction(
        party,
        Effect.gen(function* deadline() {
          yield* establish(party, overdue);
          expect(yield* accessors(party)).toEqual(expectedScope);
          yield* party.unsafe('select pg_catalog.pg_sleep(2.5)');
          return yield* accessors(party);
        }),
      ),
    );
    const overdueAgain = yield* registerGrant(issuer);
    yield* shiftGrant(admin, overdueAgain, 60, 2);
    const reestablish = `SELECT * FROM trust.establish_gateway_scope('${overdueAgain}');`;
    const late = yield* simpleQuery(
      urls.party,
      `BEGIN; ${reestablish} SELECT pg_catalog.pg_sleep(2.5); ${reestablish} COMMIT;`,
    );
    expect(late.rows[0]).toEqual([tenantId, legalEntityId]);
    expect(late.errorCode).toBe('42501');

    yield* Effect.acquireRelease(party.unsafe(setSessionSealSql, [seal]), () =>
      party.unsafe(setSessionSealSql, ['']).pipe(Effect.orDie),
    );
    yield* expectSqlState('42501')(inTransaction(party, accessors(party)));
    expect(yield* inTransaction(party, establish(party, assertion).pipe(Effect.andThen(accessors(party))))).toEqual(
      expectedScope,
    );
  }).pipe(Effect.scoped),
);

it.live('the seal lives exactly as long as its transaction or savepoint', () =>
  Effect.gen(function* lifecycle() {
    const { issuer, party } = yield* fixture;
    const assertion = yield* registerGrant(issuer);
    const afterEnd = Effect.all([currentSeal(party), inTransaction(party, accessors(party))]);
    yield* inTransaction(party, establish(party, assertion));
    expect(yield* afterEnd).toEqual(['', emptyScope]);
    yield* party.unsafe('begin');
    yield* establish(party, assertion);
    yield* party.unsafe('rollback');
    expect(yield* afterEnd).toEqual(['', emptyScope]);

    const legacyScope = Effect.gen(function* legacySettings() {
      yield* party.unsafe("select pg_catalog.set_config('ontos.tenant_id', $1, true)", [otherScopeId]);
      yield* party.unsafe(`set local ontos.tenant_id = '${otherScopeId}'`);
      return yield* accessors(party);
    });
    expect(yield* inTransaction(party, legacyScope)).toEqual(emptyScope);
    expect(yield* inTransaction(party, establish(party, assertion).pipe(Effect.andThen(legacyScope)))).toEqual(
      expectedScope,
    );

    const inSavepoint = (end: string) =>
      inTransaction(
        party,
        party
          .unsafe('savepoint establish_scope')
          .pipe(
            Effect.andThen(establish(party, assertion)),
            Effect.andThen(party.unsafe(end)),
            Effect.andThen(accessors(party)),
          ),
      );
    expect(yield* inSavepoint('release savepoint establish_scope')).toEqual(expectedScope);
    expect(yield* inSavepoint('rollback to savepoint establish_scope')).toEqual(emptyScope);

    expect(
      yield* inTransaction(
        party,
        establish(party, assertion).pipe(Effect.andThen(accessors(party))),
        'begin read only',
      ),
    ).toEqual(expectedScope);
  }).pipe(Effect.scoped),
);

it.live('trust state is unreachable and its routines are hardened', () =>
  Effect.gen(function* privileges() {
    const { admin, issuer, party, partyPool, shared, worker } = yield* fixture;
    for (const client of [shared, issuer, partyPool, worker]) {
      for (const { column, table } of trustTables) {
        for (const statement of [
          `select 1 from ${table} limit 1`,
          `insert into ${table} default values`,
          `update ${table} set ${column} = ${column} where false`,
          `delete from ${table} where false`,
        ]) {
          yield* expectSqlState('42501')(client.unsafe(statement));
        }
      }
      for (const statement of internalRoutineCalls) {
        yield* expectSqlState('42501')(client.unsafe(statement));
      }
    }

    for (const routine of TRUST_ROUTINES) {
      const [catalog] = yield* admin.unsafe<{
        config: string;
        public_execute: boolean;
        security_definer: boolean;
      }>(
        `select routine.prosecdef as security_definer,
                coalesce(pg_catalog.array_to_string(routine.proconfig, ';'), '') as config,
                exists (
                  select 1
                    from pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) as acl
                   where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
                ) as public_execute
           from pg_catalog.pg_proc as routine
          where routine.oid = pg_catalog.to_regprocedure($1)`,
        [routine.signature],
      );
      expect(catalog, routine.signature).toEqual({
        config: 'search_path=pg_catalog, pg_temp',
        public_execute: false,
        security_definer: routine.securityDefiner,
      });
      for (const role of runtimeRoles) {
        const [privilege] = yield* admin.unsafe<{ allowed: boolean }>(
          "select pg_catalog.has_function_privilege($1, pg_catalog.to_regprocedure($2), 'EXECUTE') as allowed",
          [role, routine.signature],
        );
        expect(privilege?.allowed, `${role} ${routine.signature}`).toBe(routine.executableBy.includes(role));
      }
    }

    const assertion = yield* registerGrant(issuer);
    const seal =
      (yield* inTransaction(party, establish(party, assertion).pipe(Effect.andThen(currentSeal(party))))) ?? '';
    const separator = seal.lastIndexOf('|');
    const payload = seal.slice(0, separator);
    expect(payload).toMatch(
      new RegExp(`^v2\\|\\d+\\|\\d+\\|${PARTY_REGISTRY_REQUEST_IDENTITY.role}\\|${tenantId}\\|${legalEntityId}$`, 'u'),
    );
    const [pads] = yield* admin.unsafe<{ inner_pad: string; outer_pad: string }>(
      "select pg_catalog.encode(inner_pad, 'hex') as inner_pad, pg_catalog.encode(outer_pad, 'hex') as outer_pad from trust.scope_sealing_keys where key_id = 1",
    );
    const mac = yield* Effect.tryPromise(async () => {
      const inner = await crypto.subtle.digest(
        'SHA-256',
        Buffer.concat([Buffer.from(pads?.inner_pad ?? '', 'hex'), Buffer.from(payload, 'utf-8')]),
      );
      const outer = await crypto.subtle.digest(
        'SHA-256',
        Buffer.concat([Buffer.from(pads?.outer_pad ?? '', 'hex'), Buffer.from(inner)]),
      );
      return Buffer.from(outer).toString('hex');
    });
    expect(seal.slice(separator + 1)).toBe(mac);

    for (const role of [SHELL_GATEWAY_ISSUER_IDENTITY.role, PARTY_REGISTRY_REQUEST_IDENTITY.role]) {
      const settings = yield* admin.unsafe<{ setting: string }>(
        `select setting
           from pg_catalog.pg_db_role_setting as role_setting
           join pg_catalog.pg_roles as role on role.oid = role_setting.setrole
          cross join lateral pg_catalog.unnest(role_setting.setconfig) as setting
          where role.rolname = $1
            and role_setting.setdatabase in (0, (select oid from pg_catalog.pg_database where datname = current_database()))
          order by setting`,
        [role],
      );
      expect(settings.map(({ setting }) => setting)).toEqual(
        EffectArray.sort(BEARER_ASSERTION_ROLE_SETTINGS, Order.String),
      );
    }
  }).pipe(Effect.scoped),
);
