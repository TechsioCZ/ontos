import type { Issue } from 'effect/SchemaIssue';
import { makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/actions';
import { Socket } from 'effect/socket';
import { NodeSocket, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ContextAccessLive,
  findPostgresFailure,
  CorePersistenceLive,
  DatabaseConfig,
  ReadRuntimeLive,
  ReadRuntime,
  ReadResultValidationError,
  ReadEvidenceValidationError,
  ReadHandlerExecutionError,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
  parseDatabaseConnectionPair,
  validateActiveApplicationCompositionSnapshot,
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
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import {
  PriceGroupCreatedResultSchema,
  PriceGroupDefinitionRevisionSchema,
  PriceGroupRetirementAcceptanceSchema,
} from '@app/price-group-catalog-contracts/price-group';
import {
  createPartyWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
  executePartyDetailWithAuthorization,
  executeCounterpartyReadWithAuthorization,
} from '@app/party-registry/api/client';
import type { executePartyDetail, executeCounterpartyRead } from '@app/party-registry/api/client';
import { partyRegistryApiContract } from '@app/party-registry/api';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  decodeSupportedGatewayContextClaims,
  SupportedGatewayContextClaimsSchema,
} from '@app/shared-contracts';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { PgClient } from '@effect/sql-pg';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import {
  Brand,
  Cause,
  Config,
  Context,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Result,
  Path,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
  gatewayAssertionRedemptionPgClient,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { assignCustomerPriceGroupActionApiLive } from '../../api/assign-customer-price-group-action-server.ts';
import { assignCounterpartyPriceGroupActionApiLive } from '../../api/assign-counterparty-price-group-action-server.ts';
import { removeCustomerPriceGroupActionApiLive } from '../../api/remove-customer-price-group-action-server.ts';
import { removeCounterpartyPriceGroupActionApiLive } from '../../api/remove-counterparty-price-group-action-server.ts';
import { ensureRetailCustomerProfileActionApiLive } from '../../api/ensure-retail-customer-profile-action-server.ts';
import { createCounterpartyPurchasingProfileActionApiLive } from '../../api/create-counterparty-purchasing-profile-action-server.ts';
import { customerPriceGroupResolutionReadApiLive } from '../../api/customer-price-group-resolution-read-server.ts';
import { customerPriceGroupAssignmentReadReadApiLive } from '../../api/customer-price-group-assignment-read-read-server.ts';
import { commerceCustomerContextApi } from '../../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import { PriceGroupCatalogGatewayCredentialService } from '../../shared/domain/price-group-catalog-gateway-credential.ts';
import type { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  ProfileCounterpartyRoleEligibilityResolverFactory,
  profileCounterpartyRoleEligibilityResolverFactoryLive,
} from '../../src/profile-counterparty-role-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import {
  PriceGroupOwnedDatabaseCertificateSchema,
  PriceGroupTemporalBootstrapSchema,
  PriceGroupTemporalResponseSchema,
  guardPriceGroupOwnedDatabase,
  guardPriceGroupPreparedArtifact,
  guardPriceGroupTemporalSocketPath,
  priceGroupTemporalClosedEnvironment,
  priceGroupTemporalProtocol,
  priceGroupDedicatedUrlMatches,
  openPriceGroupTemporalChannel,
  priceGroupTemporalSocketEnvironment,
  priceGroupTemporalLines,
  CreatedCatalogResponseTypeSchema,
  TemporalFixtureUnavailable,
  bounded,
  positive,
  strict,
  failure,
  requireCondition,
} from './price-group-temporal-protocol.ts';

const RequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PriceGroupTemporalRequestId'),
  Schema.decodeTo(Schema.String),
);
const ActionKeySchema = Schema.String.pipe(Schema.brand('PriceGroupTemporalActionKey'), Schema.decodeTo(Schema.String));
const commerceAppId = 'commerce-customer-context' as const;
const partyAppId = 'party-registry' as const;
const catalogAppId = 'price-group-catalog' as const;
const catalogProtocol = 'ontos.price-group-current.fixture.v1' as const;
const FixtureCommandSchema = Schema.Union([
  PriceGroupTemporalBootstrapSchema,
  Schema.Struct({
    type: Schema.Literal('IDENTITIES_READY'),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }).annotate(strict),
  Schema.Struct({
    requestId: RequestIdSchema,
    type: Schema.Literals([
      'CREATE_RETAIL_PARTY',
      'CREATE_COUNTERPARTY',
      'CREATE_SECOND_COUNTERPARTY',
      'CREATE_G1',
      'CREATE_G2',
      'CREATE_INCOMPATIBLE',
      'REVISE_G2',
      'RETIRE_G2',
      'UPGRADE',
      'STOP_CATALOG',
      'stop',
    ]),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }).annotate(strict),
]);
const CatalogResponseSchema = Schema.Union([
  Schema.Struct({
    code: Schema.optionalKey(
      Schema.Literals([
        'action_invocation_persistence_failed',
        'action_permission_check_failed',
        'action_policy_evaluation_failed',
        'action_transaction_failed',
        'price_group_persistence_unavailable',
        'module_state_check_unavailable',
        'operation_context_unavailable',
      ]),
    ),
    stage: Schema.Literals([
      'CREATE_INVALID',
      'CREATE_AUTHENTICATION',
      'CREATE_FORBIDDEN',
      'CREATE_CONFLICT',
      'CREATE_UNAVAILABLE',
      'CREATE_INTERNAL',
      'CREATE_DECODE',
    ]),
    type: Schema.Literal('FAILED'),
    version: Schema.Literal(catalogProtocol),
  }),
  Schema.Struct({
    buildMarker: bounded,
    compositionRevision: bounded,
    port: positive,
    type: Schema.Literal('BOOTED'),
    version: Schema.Literal(catalogProtocol),
  }),
  Schema.Struct({
    result: PriceGroupCreatedResultSchema,
    type: CreatedCatalogResponseTypeSchema,
    version: Schema.Literal(catalogProtocol),
  }),
  Schema.Struct({
    result: PriceGroupDefinitionRevisionSchema,
    type: Schema.Literal('REVISED_G2'),
    version: Schema.Literal(catalogProtocol),
  }),
  Schema.Struct({
    result: PriceGroupRetirementAcceptanceSchema,
    type: Schema.Literal('RETIRED_G2'),
    version: Schema.Literal(catalogProtocol),
  }),
  Schema.Struct({ type: Schema.Literal('STOPPED'), version: Schema.Literal(catalogProtocol) }),
]);
const ChildDiagnosticStageSchema = Schema.Literals([
  'C_SOCKET_CONNECTED',
  'C_BOOTSTRAP_VALID',
  'C_CCC_MIGRATION_BEGIN',
  'C_CCC_MIGRATION_DONE',
  'C_PARTY_MIGRATION_BEGIN',
  'C_PARTY_MIGRATION_DONE',
  'C_SCHEMAS_READY_SENT',
  'C_IDENTITIES_READY_RECEIVED',
  'C_AUTHORITY_READY',
  'C_PARTY_ARTIFACT_VERIFIED',
  'C_PARTY_HTTP_READY',
  'C_CATALOG_ARTIFACT_VERIFY_BEGIN',
  'C_CATALOG_ARTIFACT_VERIFIED',
  'C_CATALOG_CHANNEL_READY',
  'C_CATALOG_SPAWNED',
  'C_CATALOG_BOOTSTRAP_SEND_BEGIN',
  'C_CATALOG_BOOTSTRAP_SEND_DONE',
  'C_CATALOG_BOOTED_RECEIVED',
  'C_CATALOG_EXITED_ZERO',
  'C_CATALOG_EXITED_NONZERO',
  'C_CATALOG_HTTP_READY',
  'C_COMMERCE_READY',
  'C_BOOTED_SENT',
  'READ_RESULT_INVALID',
  'READ_EVIDENCE_INVALID',
  'READ_HANDLER_FAILED',
  'READ_OTHER_TYPED',
  'READ_DEFECT',
  'READ_RESULT_TIMESTAMP_SHAPE',
  'READ_RESULT_CURRENTNESS_TIMELINE',
  'READ_RESULT_PREDICATE_BINDING',
  'READ_RESULT_ENVELOPE_TIMES',
  'READ_RESULT_GENERATION_REVISION',
  'READ_RESULT_NEXT_BOUNDARY',
  'READ_RESULT_RESOLUTION_SHAPE',
  'READ_RESULT_UNCLASSIFIED',
]);
const diagnosticStage = (stage: typeof ChildDiagnosticStageSchema.Type) =>
  Effect.sync(() => {
    process.stdout.write(`${stage}\n`);
  });

export const classifyPriceGroupReadDiagnostic = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasDies(cause)) {
    return 'READ_DEFECT' as const;
  }
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      if (Schema.is(ReadResultValidationError)(reason.error)) {
        return 'READ_RESULT_INVALID' as const;
      }
      if (Schema.is(ReadEvidenceValidationError)(reason.error)) {
        return 'READ_EVIDENCE_INVALID' as const;
      }
      if (Schema.is(ReadHandlerExecutionError)(reason.error)) {
        return 'READ_HANDLER_FAILED' as const;
      }
    }
  }
  return 'READ_OTHER_TYPED' as const;
};

const resultDiagnosticPredicates = new Map([
  [
    'currentnessEvidence:Customer Price Group Current-set evidence must be observed and revalidated after evaluation',
    'READ_RESULT_CURRENTNESS_TIMELINE',
  ],
  [
    ':Customer Price Group owner evidence must bind the exact Profile and evaluation instant',
    'READ_RESULT_PREDICATE_BINDING',
  ],
  [
    ':Customer Price Group owner evidence must preserve one evaluation and observation timeline',
    'READ_RESULT_ENVELOPE_TIMES',
  ],
  [
    ':Customer Price Group owner evidence must bind one generation and owner Revision',
    'READ_RESULT_GENERATION_REVISION',
  ],
  [':Customer Price Group verification must precede the next applicability boundary', 'READ_RESULT_NEXT_BOUNDARY'],
]);
const resultTimestampPaths = new Set([
  'effectiveAt',
  'observedAt',
  'currentnessEvidence.evaluatedAt',
  'currentnessEvidence.observedAt',
  'currentnessEvidence.revalidatedAt',
  'verificationReceipt.issuedAt',
  'completenessEvidence.observedAt',
  'completenessEvidence.nextApplicabilityBoundary',
  'resolution.effectiveFrom',
  'resolution.effectiveTo',
]);
const resultResolutionPaths = new Set([
  'resolution',
  'resolution._tag',
  'resolution.assignmentRef',
  'resolution.assignmentRevision',
  'resolution.compatibility',
  'resolution.priceGroupRef',
  'resolution.catalogRevision',
  'resolution.reason',
  'resolution.currentAssignmentCount',
]);
const ResultDiagnosticStageSchema = Schema.Literals([
  'READ_RESULT_TIMESTAMP_SHAPE',
  'READ_RESULT_CURRENTNESS_TIMELINE',
  'READ_RESULT_PREDICATE_BINDING',
  'READ_RESULT_ENVELOPE_TIMES',
  'READ_RESULT_GENERATION_REVISION',
  'READ_RESULT_NEXT_BOUNDARY',
  'READ_RESULT_RESOLUTION_SHAPE',
  'READ_RESULT_UNCLASSIFIED',
]);
const resultIssuePathDiagnostic = (field: string) => {
  if (resultTimestampPaths.has(field)) {
    return 'READ_RESULT_TIMESTAMP_SHAPE' as const;
  }
  if (resultResolutionPaths.has(field)) {
    return 'READ_RESULT_RESOLUTION_SHAPE' as const;
  }
  return 'READ_RESULT_UNCLASSIFIED' as const;
};
const resultIssueLeafDiagnostic = (issue: Issue, path: readonly PropertyKey[]) => {
  const decodedPath = Schema.decodeUnknownOption(Schema.Array(Schema.String))(path);
  if (Option.isNone(decodedPath)) {
    return 'READ_RESULT_UNCLASSIFIED' as const;
  }
  const field = decodedPath.value.join('.');
  if (resultResolutionPaths.has(field)) {
    return 'READ_RESULT_RESOLUTION_SHAPE' as const;
  }
  return Match.value(issue).pipe(
    Match.tags({
      InvalidType: () => resultIssuePathDiagnostic(field),
      InvalidValue: (leaf) => {
        const message = leaf.annotations?.message;
        const exact = Schema.decodeUnknownOption(Schema.String)(message).pipe(
          Option.flatMap((text) => Option.fromUndefinedOr(resultDiagnosticPredicates.get(`${field}:${text}`))),
          Option.getOrUndefined,
        );
        const decoded = Schema.decodeUnknownOption(ResultDiagnosticStageSchema)(exact);
        if (Option.isSome(decoded)) {
          return decoded.value;
        }
        // Unknown refinement messages are deliberately not guessed from their location.
        if (
          message !== undefined &&
          message !== 'timestamp must be one canonical UTC instant with millisecond precision'
        ) {
          return 'READ_RESULT_UNCLASSIFIED' as const;
        }
        return resultIssuePathDiagnostic(field);
      },
      MissingKey: () => resultIssuePathDiagnostic(field),
    }),
    Match.orElse(() => 'READ_RESULT_UNCLASSIFIED' as const),
  );
};

export const classifyPriceGroupReadResultDiagnostic = (readError: ReadResultValidationError) => {
  const unclassified = ['READ_RESULT_UNCLASSIFIED'] as const;
  if (!('cause' in readError) || !Schema.isSchemaError(readError.cause)) {
    return unclassified;
  }
  const pending: { readonly issue: Issue; readonly path: readonly PropertyKey[] }[] = [
    { issue: readError.cause.issue, path: [] },
  ];
  const flags = new Set<typeof ResultDiagnosticStageSchema.Type>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    const { issue, path } = next;
    const children = Match.value(issue).pipe(
      Match.tags({
        AnyOf: (node) => node.issues.map((child) => ({ issue: child, path })),
        Composite: (node) => node.issues.map((child) => ({ issue: child, path })),
        Encoding: (node) => [{ issue: node.issue, path }],
        Filter: (node) => [{ issue: node.issue, path }],
        Pointer: (node) => [{ issue: node.issue, path: [...path, ...node.path] }],
      }),
      Match.orElse(() => null),
    );
    if (children === null || children.length === 0) {
      flags.add(resultIssueLeafDiagnostic(issue, path));
    } else {
      pending.push(...children);
    }
  }
  return flags.size === 0 ? unclassified : [...flags];
};

const reportPriceGroupReadFailure = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* reportClosedReadFailure() {
    yield* diagnosticStage(classifyPriceGroupReadDiagnostic(cause));
    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason) && Schema.is(ReadResultValidationError)(reason.error)) {
        for (const flag of classifyPriceGroupReadResultDiagnostic(reason.error)) {
          yield* diagnosticStage(flag);
        }
      }
    }
  }).pipe(
    // Diagnostic output cannot replace the original typed failure, defect or interruption.
    Effect.catchCause(() => Effect.void),
  );

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const appRoot = fileURLToPath(new URL('../../', pathToFileURL(`${process.cwd()}/`)));

const checkFixedEnvironment = Effect.fn('PriceGroupTemporal.checkFixedEnvironment')(function* checkFixedEnvironment(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
) {
  for (const [key, value] of Object.entries(priceGroupTemporalClosedEnvironment(bootstrap))) {
    const actual = yield* Config.Redacted(key);
    yield* requireCondition(Redacted.value(actual) === value, 'closed-runtime-configuration');
  }
});

const migrateOwner = Effect.fn('PriceGroupTemporal.migrateOwner')(function* migrateOwner(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
  owner: 'ccc' | 'party',
  before: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(appRoot, 'verticals', owner === 'ccc' ? commerceAppId : partyAppId);
  const migrationCommand = 'node_modules/drizzle-kit/bin.cjs';
  if (owner === 'party') {
    // Follow Party's source-owned db:migrate gateway: prepare Contacts, migrate Contacts, then Party.
    const steps = [
      ['scripts/prepare-contacts-migration.mts'],
      [migrationCommand, 'migrate', '--config', 'drizzle.contacts.config.ts'],
      [migrationCommand, 'migrate', '--config', 'drizzle.config.ts'],
    ];
    for (const args of steps) {
      const child = yield* ChildProcess.make(process.execPath, args, {
        cwd: directory,
        env: {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
        },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      });
      const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
        concurrency: 3,
      });
      yield* requireCondition(code === 0, 'owned-party-migration');
    }
    return;
  }
  const history = path.join(directory, 'drizzle');
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-1248-migration-' });
  const out = before ? path.join(temporary, 'prefix') : history;
  if (before) {
    yield* fs.makeDirectory(out);
    for (const folder of yield* fs.readDirectory(history)) {
      if (folder < '20261019224642_price_group_effective_current') {
        yield* fs.copy(path.join(history, folder), path.join(out, folder));
      }
    }
  }
  const configuration = path.join(temporary, 'drizzle.config.mjs');
  yield* fs.writeFileString(
    configuration,
    "export default { dialect:'postgresql', out:process.env.ONTOS_1248_HISTORY, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:process.env.ONTOS_1248_JOURNAL} };\n",
  );
  const child = yield* ChildProcess.make(
    process.execPath,
    [path.join(directory, migrationCommand), 'migrate', '--config', configuration],
    {
      cwd: directory,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
        ONTOS_1248_HISTORY: out,
        ONTOS_1248_JOURNAL:
          owner === 'ccc' ? '__drizzle_migrations_commerce_customer_context' : '__drizzle_migrations_party',
      },
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  yield* requireCondition(code === 0, 'owned-migration');
});

const PublicKeySchema = Schema.Struct({ crv: Schema.Literal('Ed25519'), kty: Schema.Literal('OKP'), x: Schema.String });
const PublicKeysSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      ...PublicKeySchema.fields,
      alg: Schema.Literal('EdDSA'),
      kid: bounded,
      use: Schema.Literal('sig'),
    }),
  ),
});
const makeChildAuthority = Effect.fn('PriceGroupTemporal.makeChildAuthority')(function* makeChildAuthority(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
) {
  yield* requireCondition(
    priceGroupDedicatedUrlMatches(
      Redacted.value(bootstrap.identities.issuerUrl),
      bootstrap.database,
      'shell_gateway_issuer',
    ),
    'issuer-clone-url',
  );
  const issuerClient = Context.get(
    yield* Layer.build(PgClient.layer({ maxConnections: 1, url: bootstrap.identities.issuerUrl })),
    PgClient.PgClient,
  );
  const registrar = makeGatewayScopeGrantRegistrar(issuerClient);
  const partyClient = Context.get(
    yield* Layer.build(PgClient.layer({ maxConnections: 1, url: bootstrap.identities.partyUrl })),
    PgClient.PgClient,
  );
  const keys = yield* Effect.tryPromise({
    catch: () => failure('child-authority-key'),
    try: async () => {
      const generated = await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      if (!('privateKey' in generated)) {
        throw new Error('An Ed25519 key pair is required');
      }
      return generated;
    },
  });
  const kid = yield* nextId;
  const publicKey = yield* Effect.tryPromise({
    catch: () => failure('child-authority-public-key'),
    try: async () => await globalThis.crypto.subtle.exportKey('jwk', keys.publicKey),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PublicKeySchema)));
  const issuer = 'https://customer-price-group-temporal-child.test';
  const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(PublicKeysSchema))({
    keys: [{ ...publicKey, alg: 'EdDSA', kid, use: 'sig' }],
  });
  const prepare = Effect.fn('PriceGroupTemporal.prepareChildAssertion')(function* issueChildAssertion(
    audience: typeof catalogAppId | typeof partyAppId,
    buildMarker: string,
  ) {
    const { legalEntityId, ...tenantActor } = bootstrap.actor;
    yield* requireCondition(legalEntityId !== undefined, 'child-actor-legal-entity');
    const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    const claims = yield* decodeSupportedGatewayContextClaims({
      aud: audience,
      compositionRevision: bootstrap.composition.composition.revision,
      exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
      iat: now,
      iss: issuer,
      jti: yield* nextId,
      principal: audience === catalogAppId ? tenantActor : bootstrap.actor,
      sub: bootstrap.actor.principalId,
      targetBuildMarker: buildMarker,
      ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
    });
    const header = Buffer.from(
      yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            alg: Schema.Literal('EdDSA'),
            kid: bounded,
            typ: Schema.Literal('JWT'),
          }),
        ),
      )({ alg: 'EdDSA', kid, typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
    ).toString('base64url');
    const content = `${header}.${payload}`;
    const signature = yield* Effect.tryPromise({
      catch: () => failure('child-authority-signature'),
      try: async () =>
        await globalThis.crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(content)),
    });
    const assertion = Redacted.make(`${content}.${Buffer.from(signature).toString('base64url')}`);
    const registration = {
      assertion,
      audience,
      expiresAtEpochSeconds: claims.exp,
      jti: claims.jti,
      principalId: claims.principal.principalId,
      tenantId: claims.principal.tenantId,
    };
    if (claims.principal.legalEntityId !== undefined) {
      Object.assign(registration, { legalEntityId: claims.principal.legalEntityId });
    }
    const refuseUnregistered = Effect.gen(function* refuseUnregisteredScope() {
      const unregistered = yield* partyClient
        .withTransaction(partyClient`select trust.establish_gateway_scope(${Redacted.value(assertion)})`)
        .pipe(Effect.result);
      yield* requireCondition(
        Result.isFailure(unregistered) &&
          Option.isSome(findPostgresFailure(unregistered.failure, ({ code }) => code === '42501')),
        'unregistered-party-scope-refused',
      );
    });
    const confirmRegistered = Effect.gen(function* confirmRegisteredScope() {
      const rows = yield* partyClient.withTransaction(
        partyClient<{
          established_legal_entity_id: string | null;
          established_tenant_id: string;
        }>`select * from trust.establish_gateway_scope(${Redacted.value(assertion)})`,
      );
      yield* requireCondition(
        rows.length === 1 &&
          rows[0]?.established_tenant_id === claims.principal.tenantId &&
          rows[0]?.established_legal_entity_id === (claims.principal.legalEntityId ?? null),
        'registered-party-scope-exact',
      );
    });
    return {
      authorization: `Bearer ${Redacted.value(assertion)}`,
      confirmRegistered,
      refuseUnregistered,
      register: registrar.register(registration),
    };
  });
  const issue = Effect.fn('PriceGroupTemporal.issueChildAssertion')(function* issueChildAssertion(
    audience: typeof catalogAppId | typeof partyAppId,
    buildMarker: string,
  ) {
    const prepared = yield* prepare(audience, buildMarker);
    yield* prepared.register;
    return prepared.authorization;
  });
  return { issue, issuer, jwks, prepare };
});

const preparedOwner = Effect.fn('PriceGroupTemporal.preparedOwner')(function* preparedOwner(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
  owner: 'party' | 'catalog',
) {
  const appId = owner === 'party' ? partyAppId : catalogAppId;
  const artifact = yield* guardPriceGroupPreparedArtifact(bootstrap.artifacts[owner], appId);
  return { artifact: artifact.artifact, buildMarker: artifact.buildMarker, directory: artifact.directory };
});

const publishCompositionSource = Effect.fn('PriceGroupTemporal.publishCompositionSource')(
  function* publishCompositionSource(bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
      bootstrap.composition,
    );
    const context = yield* Layer.build(NodeHttpServer.layerTest);
    const source = Context.get(context, HttpServer.HttpServer);
    yield* source.serve(Effect.succeed(HttpServerResponse.text(encoded, { contentType: 'application/json' })));
    const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: positive }))(source.address);
    return `http://127.0.0.1:${address.port}/active-composition`;
  },
);

const startParty = Effect.fn('PriceGroupTemporal.startParty')(function* startParty(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
  authority: Effect.Success<ReturnType<typeof makeChildAuthority>>,
  sourceUrl: string,
) {
  yield* requireCondition(
    priceGroupDedicatedUrlMatches(
      Redacted.value(bootstrap.identities.partyUrl),
      bootstrap.database,
      'party_registry_runtime',
    ),
    'party-clone-url',
  );
  const bundle = yield* preparedOwner(bootstrap, 'party');
  yield* diagnosticStage('C_PARTY_ARTIFACT_VERIFIED');
  const module = bootstrap.composition.composition.modules.find(({ deployment }) => deployment.appId === partyAppId);
  yield* requireCondition(
    module?.moduleId === 'party.registry' && module.deployment.buildMarker === bundle.buildMarker,
    'party-composition-build',
  );
  const child = yield* ChildProcess.make(process.execPath, [bundle.artifact], {
    cwd: bundle.directory,
    env: {
      ...priceGroupTemporalClosedEnvironment(bootstrap),
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: sourceUrl,
      ONTOS_GATEWAY_ISSUER: authority.issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: authority.jwks,
      PARTY_REGISTRY_DATABASE_URL: Redacted.value(bootstrap.identities.partyUrl),
    },
    extendEnv: false,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  const response = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
  if (Option.isNone(response)) {
    return yield* failure('party-no-readiness');
  }
  const ready = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        marker: Schema.Struct({ appId: Schema.Literal(partyAppId), buildMarker: bounded }),
        port: positive,
        type: Schema.Literal('ready'),
      }),
    ),
  )(response.value);
  yield* requireCondition(ready.marker.buildMarker === bundle.buildMarker, 'party-ready-build');
  return {
    baseUrl: new URL(partyRegistryApiContract.apiPrefix, `http://127.0.0.1:${ready.port}`),
    buildMarker: bundle.buildMarker,
  };
});

// Catalog owns a strict nine-field certificate. Creator-only fields stay on the CCC setup channel.
export const PriceGroupCatalogDatabaseCertificateSchema = Schema.Struct({
  adminRole: PriceGroupOwnedDatabaseCertificateSchema.fields.adminRole,
  adminUrl: PriceGroupOwnedDatabaseCertificateSchema.fields.adminUrl,
  name: PriceGroupOwnedDatabaseCertificateSchema.fields.name,
  oid: PriceGroupOwnedDatabaseCertificateSchema.fields.oid,
  owner: PriceGroupOwnedDatabaseCertificateSchema.fields.owner,
  runtimeRole: PriceGroupOwnedDatabaseCertificateSchema.fields.runtimeRole,
  runtimeUrl: PriceGroupOwnedDatabaseCertificateSchema.fields.runtimeUrl,
  serverAddress: PriceGroupOwnedDatabaseCertificateSchema.fields.serverAddress,
  serverPort: PriceGroupOwnedDatabaseCertificateSchema.fields.serverPort,
}).annotate(strict);
export const projectPriceGroupCatalogDatabaseCertificate = (
  certificate: typeof PriceGroupOwnedDatabaseCertificateSchema.Encoded,
) => ({
  adminRole: certificate.adminRole,
  adminUrl: certificate.adminUrl,
  name: certificate.name,
  oid: certificate.oid,
  owner: certificate.owner,
  runtimeRole: certificate.runtimeRole,
  runtimeUrl: certificate.runtimeUrl,
  serverAddress: certificate.serverAddress,
  serverPort: certificate.serverPort,
});

const startCatalog = Effect.fn('PriceGroupTemporal.startCatalog')(function* startCatalog(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
  authority: Effect.Success<ReturnType<typeof makeChildAuthority>>,
) {
  yield* diagnosticStage('C_CATALOG_ARTIFACT_VERIFY_BEGIN');
  const bundle = yield* preparedOwner(bootstrap, 'catalog');
  yield* diagnosticStage('C_CATALOG_ARTIFACT_VERIFIED');
  const module = bootstrap.composition.composition.modules.find(({ deployment }) => deployment.appId === catalogAppId);
  yield* requireCondition(
    module?.moduleId === 'pricing.price-group-catalog' && module.deployment.buildMarker === bundle.buildMarker,
    'catalog-composition-build',
  );
  const channel = yield* openPriceGroupTemporalChannel(CatalogResponseSchema);
  yield* diagnosticStage('C_CATALOG_CHANNEL_READY');
  const child = yield* ChildProcess.make(process.execPath, [bundle.artifact], {
    cwd: bundle.directory,
    env: {
      ...priceGroupTemporalClosedEnvironment(bootstrap),
      ONTOS_GATEWAY_ISSUER: authority.issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: authority.jwks,
      [priceGroupTemporalSocketEnvironment]: channel.socketPath,
    },
    extendEnv: true,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  yield* diagnosticStage('C_CATALOG_SPAWNED');
  yield* child.exitCode.pipe(
    Effect.flatMap((code) => diagnosticStage(code === 0 ? 'C_CATALOG_EXITED_ZERO' : 'C_CATALOG_EXITED_NONZERO')),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
  const exited = child.exitCode.pipe(Effect.flatMap(() => Effect.fail(failure('catalog-exited'))));
  const receive = Effect.raceFirst(channel.next, exited);
  const send = (command: Schema.Json) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(command).pipe(Effect.flatMap(channel.send));
  const { legalEntityId: _selectedLegalEntity, ...tenantActor } = bootstrap.actor;
  const encodedBootstrap = yield* Schema.encodeEffect(PriceGroupTemporalBootstrapSchema)(bootstrap);
  yield* diagnosticStage('C_CATALOG_BOOTSTRAP_SEND_BEGIN');
  yield* Effect.raceFirst(
    send({
      actor: tenantActor,
      composition: encodedBootstrap.composition,
      database: projectPriceGroupCatalogDatabaseCertificate(encodedBootstrap.database),
      issuer: authority.issuer,
      jwks: authority.jwks,
      spiceDb: encodedBootstrap.spiceDb,
      type: 'bootstrap',
      version: catalogProtocol,
    }),
    exited,
  );
  yield* diagnosticStage('C_CATALOG_BOOTSTRAP_SEND_DONE');
  const ready = yield* receive;
  if (ready.type !== 'BOOTED') {
    return yield* failure('catalog-ready-order');
  }
  yield* requireCondition(
    ready.buildMarker === bundle.buildMarker &&
      ready.compositionRevision === bootstrap.composition.composition.revision,
    'catalog-ready-identity',
  );
  yield* diagnosticStage('C_CATALOG_BOOTED_RECEIVED');
  const invoke = Effect.fn('PriceGroupTemporal.catalogCommand')(function* catalogCommand(
    type: 'CREATE_G1' | 'CREATE_G2' | 'CREATE_INCOMPATIBLE' | 'REVISE_G2' | 'RETIRE_G2',
    requestId: string,
  ) {
    yield* send({
      authorization: yield* authority.issue(catalogAppId, bundle.buildMarker),
      requestId,
      type,
      version: catalogProtocol,
    });
    return yield* receive;
  });
  return {
    baseUrl: new URL(`http://127.0.0.1:${ready.port}`),
    buildMarker: bundle.buildMarker,
    invoke,
    stop: () => child.kill(),
  };
});

type RetailResolverLayerFor = (
  execute: typeof executePartyDetail,
) => Layer.Layer<PartyRegistryRetailPartyResolverFactory>;

const serveCommerce = Effect.fn('PriceGroupTemporal.serveCommerce')(function* serveCommerce(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
  authority: Effect.Success<ReturnType<typeof makeChildAuthority>>,
  party: Effect.Success<ReturnType<typeof startParty>>,
  catalog: Effect.Success<ReturnType<typeof startCatalog>>,
  retailResolverLayerFor: RetailResolverLayerFor,
) {
  const pair = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
    DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
  });
  const compositionRevision = bootstrap.composition.composition.revision;
  const authorityContext = yield* Effect.context<Crypto.Crypto>();
  const readParty: typeof executePartyDetail = (request, correlation) =>
    authority.issue(partyAppId, party.buildMarker).pipe(
      Effect.provideContext(authorityContext),
      Effect.orDie,
      Effect.flatMap((token) =>
        executePartyDetailWithAuthorization(request, token, correlation, {
          baseUrl: party.baseUrl,
          compositionRevision,
        }),
      ),
    );
  const readCounterparty: typeof executeCounterpartyRead = (request, correlation) =>
    authority.issue(partyAppId, party.buildMarker).pipe(
      Effect.provideContext(authorityContext),
      Effect.orDie,
      Effect.flatMap((token) =>
        executeCounterpartyReadWithAuthorization(request, token, correlation, {
          baseUrl: party.baseUrl,
          compositionRevision,
        }),
      ),
    );
  const factories = yield* Layer.build(profileCounterpartyRoleEligibilityResolverFactoryLive);
  const counterpartyFactory = Context.get(factories, ProfileCounterpartyRoleEligibilityResolverFactory);
  const profileReader = profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive));
  const ownerServices = Layer.mergeAll(
    retailResolverLayerFor(readParty),
    Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
      make: (input) => counterpartyFactory.make(input, readCounterparty),
    }),
    partyRegistryGuestResolverFactoryLive,
    profileReader,
    profileReactivationEligibilityEvaluatorFactoryLive.pipe(Layer.provide(profileReconfirmationPolicyUnavailableLive)),
    commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
      Layer.provide(profileReader),
      Layer.provide(ContextAccessLive),
    ),
    Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
      issue: (request) =>
        requireCondition(
          request.audience === catalogAppId && request.compositionRevision === compositionRevision,
          'catalog-credential-scope',
        ).pipe(
          Effect.andThen(authority.issue(catalogAppId, catalog.buildMarker)),
          Effect.provideContext(authorityContext),
          Effect.map((token) => ({ baseUrl: catalog.baseUrl, credential: Redacted.make(token) })),
          Effect.mapError(
            () =>
              new CustomerPriceGroupCatalogUnavailable({
                code: 'customer_price_group_catalog_unavailable',
                reason: 'The fixed TEST owner issuer is unavailable',
              }),
          ),
        ),
    }),
  );
  const databaseConfig = Layer.succeed(DatabaseConfig, pair.runtime);
  const persistence = CorePersistenceLive.pipe(Layer.provide(databaseConfig));
  const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
  const stateGate = ModuleStateGateLive.pipe(Layer.provide(states));
  const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(stateGate));
  const resolver = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)));
  const namespace = staffAuthenticationNamespaceRegistryLayer([commerceAppId]);
  const composition = makeActiveApplicationCompositionLayer(Effect.succeed(bootstrap.composition));
  const common = Layer.mergeAll(
    persistence,
    ContextAccessLive,
    stateGate,
    gateway,
    resolver,
    namespace,
    composition,
    ownerServices,
  );
  const actions = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(Layer.mergeAll(common, ActionRepositoryLive, ActionPermissionLive)),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(ownerServices),
  );
  const reads = Layer.effect(
    ReadRuntime,
    Effect.gen(function* observeResolutionReadRuntime() {
      const runtime = yield* ReadRuntime;
      const observed: typeof runtime = {
        runRead: (input) =>
          runtime
            .runRead(input)
            .pipe(
              Effect.tapCause((cause) =>
                input.registration.descriptor.readKey ===
                'commerce.customer-context.api.customer-price-group-resolution'
                  ? reportPriceGroupReadFailure(cause)
                  : Effect.void,
              ),
            ),
      };
      return observed;
    }),
  ).pipe(Layer.provide(ReadRuntimeLive.pipe(Layer.provide(common), Layer.provide(NodeCrypto.layer))));
  const encodedComposition = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(bootstrap.composition);
  const source = Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(encodedComposition) });
  const redemptionDatabase = GatewayAssertionRedemptionDatabaseLive.pipe(
    Layer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
    Layer.provide(Reactivity.layer),
    Layer.provide(databaseConfig),
  );
  const redemption = GatewayAssertionRedemptionLive.pipe(Layer.provide(redemptionDatabase));
  const handlers = Layer.mergeAll(
    assignCustomerPriceGroupActionApiLive,
    assignCounterpartyPriceGroupActionApiLive,
    removeCustomerPriceGroupActionApiLive,
    removeCounterpartyPriceGroupActionApiLive,
    ensureRetailCustomerProfileActionApiLive,
    createCounterpartyPurchasingProfileActionApiLive,
    customerPriceGroupResolutionReadApiLive,
    customerPriceGroupAssignmentReadReadApiLive,
  ).pipe(
    Layer.provide(ActionPrincipalVerifierLive.pipe(Layer.provide(actions))),
    Layer.provide(Layer.mergeAll(actions, reads, namespace, redemption, source, RequestSchemaProblemLive)),
  );
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(
          HttpApi.make('CommerceCustomerContextApi')
            .add(commerceCustomerContextApi.groups.assignCustomerPriceGroupAction)
            .add(commerceCustomerContextApi.groups.assignCounterpartyPriceGroupAction)
            .add(commerceCustomerContextApi.groups.removeCustomerPriceGroupAction)
            .add(commerceCustomerContextApi.groups.removeCounterpartyPriceGroupAction)
            .add(commerceCustomerContextApi.groups.ensureRetailCustomerProfileAction)
            .add(commerceCustomerContextApi.groups.createCounterpartyPurchasingProfileAction)
            .add(commerceCustomerContextApi.groups.customerPriceGroupResolution)
            .add(commerceCustomerContextApi.groups.customerPriceGroupAssignmentRead)
            .annotateMerge(commerceCustomerContextApi.annotations),
        ).pipe(
          Layer.provide(handlers),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeServices.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeCrypto.layer),
        ),
        { disableLogger: true },
      ),
    ),
    (handler) => Effect.promise(async () => await handler.dispose()).pipe(Effect.orDie),
  );
  const context = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(context, HttpServer.HttpServer);
  const empty = Context.makeUnsafe<unknown>(new Map());
  yield* server.serve(
    Effect.gen(function* commerceRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const web = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        catch: () => failure('commerce-http'),
        try: async () => await app.handler(web, empty),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: positive }))(server.address);
  return { buildMarker: ultramodernApiMarker.buildMarker, compositionRevision, port: address.port };
});

const createParty = Effect.fn('PriceGroupTemporal.createParty')(function* createParty(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
  authority: Effect.Success<ReturnType<typeof makeChildAuthority>>,
  party: Effect.Success<ReturnType<typeof startParty>>,
  purpose: 'retail' | 'counterparty' | 'second-counterparty',
  requestId: string,
) {
  const subjects = {
    counterparty: { displayName: 'Temporal Counterparty owner', ico: '45274649' },
    retail: { displayName: 'Temporal Retail owner', ico: '27074358' },
    'second-counterparty': { displayName: 'Temporal second Counterparty owner', ico: '12345679' },
  };
  const subject = subjects[purpose];
  const subjectKey = Brand.nominal<
    NonNullable<
      Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
    >[number]['subjectKey']
  >()(yield* nextId);
  const payload: Parameters<typeof createPartyWithAuthorization>[0] = {
    candidate: {
      displayName: subject.displayName,
      evidenceRefs: [`test:1248:reviewed-${requestId}`],
      officialIdentifiers: [{ identifierType: 'ICO', value: subject.ico, verification: 'VERIFIED' }],
      partyType: 'ORGANIZATION',
      provenance: { method: 'REVIEWED_DOCUMENT', source: 'stabilization-1248' },
      subjectEvidence: [
        {
          basis: 'REVIEWED_DOCUMENT',
          evidenceRef: `test:1248:reviewed-${requestId}`,
          kind: 'ACTOR_ATTESTATION',
          observedSubject: 'ORGANIZATION',
          statement: 'Reviewed this distinct native temporal customer',
          subjectKey,
        },
      ],
      validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
    },
  };
  const options = {
    baseUrl: party.baseUrl,
    compositionRevision: bootstrap.composition.composition.revision,
    correlationId: requestId,
    idempotencyKey: requestId,
  };
  const prepared = yield* authority.prepare(partyAppId, party.buildMarker);
  if (purpose === 'retail') {
    // Exercise the exact signed token at the native scope boundary before registration. No HTTP
    // redemption occurs here: its one-shot JTI remains unused until the single registered request.
    yield* prepared.refuseUnregistered;
  }
  yield* prepared.register;
  if (purpose === 'retail') {
    yield* prepared.confirmRegistered;
  }
  const result = yield* createPartyWithAuthorization(payload, prepared.authorization, options);
  yield* requireCondition(result.outcome === 'CREATED', 'party-created');
  if (result.outcome !== 'CREATED') {
    return yield* failure('party-create-outcome');
  }
  return result.partyRef;
});
const createCounterparty = Effect.fn('PriceGroupTemporal.createCounterparty')(function* createCounterparty(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
  authority: Effect.Success<ReturnType<typeof makeChildAuthority>>,
  party: Effect.Success<ReturnType<typeof startParty>>,
  requestId: string,
  purpose: 'counterparty' | 'second-counterparty' = 'counterparty',
) {
  const partyRef = yield* createParty(bootstrap, authority, party, purpose, requestId);
  const evidence = {
    evidenceReference: `test:1248:verified-customer-${requestId}`,
    method: 'REVIEWED_DOCUMENT',
    reason: 'Genuine test Customer relationship',
    source: 'stabilization-1248',
  };
  const payload = {
    counterpartyProvenance: { ...evidence, evidenceReference: `test:1248:verified-context-${requestId}` },
    customerEvidence: evidence,
    partyRef,
    validFrom: DateTime.formatIso(yield* DateTime.now),
  };
  const onboard = Effect.fn('PriceGroupTemporal.publicCustomerOnboard')(function* publicCustomerOnboard(
    input: Parameters<typeof counterpartyCustomerOnboardWithAuthorization>[0],
  ) {
    return yield* counterpartyCustomerOnboardWithAuthorization(
      input,
      yield* authority.issue(partyAppId, party.buildMarker),
      {
        baseUrl: party.baseUrl,
        compositionRevision: bootstrap.composition.composition.revision,
        correlationId: yield* nextId,
        idempotencyKey: yield* nextId,
      },
    );
  });
  // A reviewed identity document is not evidence of a commercial or CUSTOMER relationship.
  // Retain the real public negative before submitting the fixture's explicit approved relationships.
  const invalidEvidence = yield* Effect.flip(onboard(payload));
  yield* requireCondition(
    Schema.is(
      Schema.Struct({
        _tag: Schema.Literal('PartyCommandUnprocessableProblem'),
        code: Schema.Literal('counterparty_evidence_insufficient'),
      }),
    )(invalidEvidence),
    'counterparty-evidence-denial',
  );
  const counterparty = yield* onboard({
    ...payload,
    counterpartyProvenance: { ...payload.counterpartyProvenance, method: 'APPROVED_COMMERCIAL_RELATIONSHIP' },
    customerEvidence: { ...payload.customerEvidence, method: 'APPROVED_PURCHASING_RELATIONSHIP' },
  });
  return { counterpartyRef: counterparty.counterpartyRef, partyRef };
});

const connectParent = Effect.gen(function* connectParent() {
  const socketPath = yield* Config.String(priceGroupTemporalSocketEnvironment);
  yield* guardPriceGroupTemporalSocketPath(socketPath);
  const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
  const pull = yield* Socket.readerBytes(socket);
  const writer = yield* socket.writer;
  const pending = yield* Queue.bounded<typeof FixtureCommandSchema.Type | TemporalFixtureUnavailable>(8);
  yield* priceGroupTemporalLines(pull).pipe(
    Stream.mapEffect((line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureCommandSchema), { onExcessProperty: 'error' })(line),
    ),
    Stream.runForEach((command) => Queue.offer(pending, command)),
    Effect.andThen(Queue.offer(pending, failure('private-input-ended'))),
    Effect.catch(() => Queue.offer(pending, failure('private-input-invalid'))),
    Effect.forkScoped,
  );
  return {
    next: Queue.take(pending).pipe(
      Effect.flatMap((item) =>
        Schema.is(TemporalFixtureUnavailable)(item) ? Effect.fail(item) : Effect.succeed(item),
      ),
    ),
    sendParent: (response: typeof PriceGroupTemporalResponseSchema.Type) =>
      Schema.encodeEffect(Schema.fromJsonString(PriceGroupTemporalResponseSchema))(response).pipe(
        Effect.flatMap((line) => writer.write(`${line}\n`)),
      ),
  };
});
const validateBootstrap = Effect.fn('PriceGroupTemporal.validateBootstrap')(function* validateBootstrap(
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const packageIdentity = yield* fs.readFileString('package.json').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ name: bounded })))),
    Effect.mapError(() => failure('owner-working-directory')),
  );
  yield* requireCondition(packageIdentity.name === '@app/commerce-customer-context', 'owner-working-directory');
  yield* requireCondition(
    bootstrap.actor.authenticationNamespaceId === STAFF_AUTHENTICATION_NAMESPACE_ID &&
      ['session', 'api_key'].includes(bootstrap.actor.authMethod) &&
      bootstrap.actor.legalEntityId !== undefined &&
      bootstrap.actor.trustedStorefrontId === undefined &&
      bootstrap.actor.impersonatedByPrincipalId === undefined,
    'staff-selected-legal-entity',
  );
  yield* validateActiveApplicationCompositionSnapshot(bootstrap.composition);
  const source = bootstrap.composition.composition.modules.find(({ deployment }) => deployment.appId === commerceAppId);
  yield* requireCondition(
    source?.moduleId === 'commerce.customer-context' &&
      source.deployment.buildMarker === ultramodernApiMarker.buildMarker,
    'commerce-composition-build',
  );
  const address = yield* Schema.decodeEffect(Schema.URLFromString)(`https://${bootstrap.spiceDb.endpoint}`);
  yield* requireCondition(
    ['localhost', '127.0.0.1'].includes(address.hostname) &&
      address.pathname === '/' &&
      address.username === '' &&
      address.password === '' &&
      address.search === '' &&
      address.hash === '',
    'spicedb-loopback',
  );
  yield* guardPriceGroupOwnedDatabase(bootstrap.database);
  yield* checkFixedEnvironment(bootstrap);
});

export const runReceiver = Effect.fn('PriceGroupTemporal.runReceiver')(function* runPriceGroupCurrentReceiver(
  retailResolverLayerFor: RetailResolverLayerFor,
) {
  const { next, sendParent } = yield* connectParent;
  yield* diagnosticStage('C_SOCKET_CONNECTED');
  const first = yield* next;
  if (first.type !== 'bootstrap') {
    return yield* failure('bootstrap-order');
  }
  const bootstrap = first;
  yield* validateBootstrap(bootstrap);
  yield* diagnosticStage('C_BOOTSTRAP_VALID');
  yield* diagnosticStage('C_CCC_MIGRATION_BEGIN');
  yield* migrateOwner(bootstrap, 'ccc', bootstrap.mode === 'before');
  yield* diagnosticStage('C_CCC_MIGRATION_DONE');
  yield* diagnosticStage('C_PARTY_MIGRATION_BEGIN');
  yield* migrateOwner(bootstrap, 'party', false);
  yield* diagnosticStage('C_PARTY_MIGRATION_DONE');
  yield* sendParent({ type: 'SCHEMAS_READY', version: priceGroupTemporalProtocol });
  yield* diagnosticStage('C_SCHEMAS_READY_SENT');
  const identitiesReady = yield* next;
  yield* requireCondition(identitiesReady.type === 'IDENTITIES_READY', 'creator-identity-setup-order');
  yield* diagnosticStage('C_IDENTITIES_READY_RECEIVED');
  const authority = yield* makeChildAuthority(bootstrap);
  yield* diagnosticStage('C_AUTHORITY_READY');
  const source = yield* publishCompositionSource(bootstrap);
  const party = yield* startParty(bootstrap, authority, source);
  yield* diagnosticStage('C_PARTY_HTTP_READY');
  const catalog = yield* startCatalog(bootstrap, authority);
  yield* diagnosticStage('C_CATALOG_HTTP_READY');
  const receiver = yield* serveCommerce(bootstrap, authority, party, catalog, retailResolverLayerFor);
  yield* diagnosticStage('C_COMMERCE_READY');
  yield* sendParent({ ...receiver, type: 'BOOTED', version: priceGroupTemporalProtocol });
  yield* diagnosticStage('C_BOOTED_SENT');
  let upgraded = bootstrap.mode === 'current';
  let catalogStopped = false;
  while (true) {
    const command = yield* next;
    if (command.type === 'bootstrap' || command.type === 'IDENTITIES_READY') {
      return yield* failure('duplicate-bootstrap');
    }
    if (command.type === 'stop') {
      yield* sendParent({ type: 'STOPPED', version: priceGroupTemporalProtocol });
      return yield* Effect.void;
    }
    if (command.type === 'UPGRADE') {
      yield* requireCondition(!upgraded, 'upgrade-once');
      yield* guardPriceGroupOwnedDatabase(bootstrap.database);
      yield* migrateOwner(bootstrap, 'ccc', false);
      upgraded = true;
      yield* sendParent({ type: 'UPGRADED', version: priceGroupTemporalProtocol });
    } else if (command.type === 'STOP_CATALOG') {
      yield* requireCondition(!catalogStopped, 'catalog-stop-once');
      yield* catalog.stop();
      catalogStopped = true;
      yield* sendParent({ type: 'CATALOG_STOPPED', version: priceGroupTemporalProtocol });
    } else if (command.type === 'CREATE_RETAIL_PARTY') {
      yield* createParty(bootstrap, authority, party, 'retail', command.requestId).pipe(
        Effect.flatMap((partyRef) =>
          sendParent({ partyRef, type: 'RETAIL_PARTY_CREATED', version: priceGroupTemporalProtocol }),
        ),
        Effect.catchTags({
          PartyCommandAuthenticationProblem: () =>
            sendParent({ stage: 'PARTY_CREATE_AUTHENTICATION', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandConflictProblem: () =>
            sendParent({ stage: 'PARTY_CREATE_CONFLICT', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandForbiddenProblem: () =>
            sendParent({ stage: 'PARTY_CREATE_FORBIDDEN', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandInternalProblem: () =>
            sendParent({ stage: 'PARTY_CREATE_INTERNAL', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandInvalidRequestProblem: () =>
            sendParent({ stage: 'PARTY_CREATE_INVALID', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandUnavailableProblem: () =>
            sendParent({ stage: 'PARTY_CREATE_UNAVAILABLE', type: 'FAILED', version: priceGroupTemporalProtocol }),
          SchemaError: () =>
            sendParent({ stage: 'PARTY_CREATE_DECODE', type: 'FAILED', version: priceGroupTemporalProtocol }),
        }),
      );
    } else if (command.type === 'CREATE_COUNTERPARTY' || command.type === 'CREATE_SECOND_COUNTERPARTY') {
      const purpose = command.type === 'CREATE_COUNTERPARTY' ? 'counterparty' : 'second-counterparty';
      yield* createCounterparty(bootstrap, authority, party, command.requestId, purpose).pipe(
        Effect.flatMap((created) =>
          sendParent({ ...created, type: 'COUNTERPARTY_CREATED', version: priceGroupTemporalProtocol }),
        ),
        Effect.catchTags({
          PartyCommandAuthenticationProblem: () =>
            sendParent({
              stage: 'PARTY_COUNTERPARTY_AUTHENTICATION',
              type: 'FAILED',
              version: priceGroupTemporalProtocol,
            }),
          PartyCommandConflictProblem: () =>
            sendParent({ stage: 'PARTY_COUNTERPARTY_CONFLICT', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandForbiddenProblem: () =>
            sendParent({ stage: 'PARTY_COUNTERPARTY_FORBIDDEN', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandInternalProblem: () =>
            sendParent({ stage: 'PARTY_COUNTERPARTY_INTERNAL', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandInvalidRequestProblem: () =>
            sendParent({ stage: 'PARTY_COUNTERPARTY_INVALID', type: 'FAILED', version: priceGroupTemporalProtocol }),
          PartyCommandUnavailableProblem: () =>
            sendParent({
              stage: 'PARTY_COUNTERPARTY_UNAVAILABLE',
              type: 'FAILED',
              version: priceGroupTemporalProtocol,
            }),
          PartyCommandUnprocessableProblem: (error) =>
            sendParent({
              code: error.code,
              stage: 'PARTY_COUNTERPARTY_INELIGIBLE',
              type: 'FAILED',
              version: priceGroupTemporalProtocol,
            }),
          SchemaError: () =>
            sendParent({ stage: 'PARTY_COUNTERPARTY_DECODE', type: 'FAILED', version: priceGroupTemporalProtocol }),
        }),
      );
    } else {
      yield* requireCondition(!catalogStopped, 'catalog-alive');
      const result = yield* catalog.invoke(command.type, command.requestId);
      if (result.type === 'BOOTED' || result.type === 'STOPPED') {
        return yield* failure('catalog-mutation-order');
      }
      yield* sendParent({ ...result, version: priceGroupTemporalProtocol });
    }
  }
});
const DescriptionSchema = Schema.Struct({
  actionKeys: Schema.Array(ActionKeySchema),
  appId: Schema.Literal(commerceAppId),
  buildMarker: bounded,
  type: Schema.Literal('description'),
  version: Schema.Literal(priceGroupTemporalProtocol),
});
export const describeReceiver = Schema.encodeEffect(Schema.fromJsonString(DescriptionSchema))({
  actionKeys: [
    'commerce.customer-context.ensure-retail-customer-profile',
    'commerce.customer-context.create-counterparty-purchasing-profile',
    'commerce.customer-context.assign-customer-price-group',
    'commerce.customer-context.assign-counterparty-price-group',
    'commerce.customer-context.remove-customer-price-group',
    'commerce.customer-context.remove-counterparty-price-group',
    'party.registry.create-party',
    'party.registry.counterparty-customer-onboard',
    'pricing.price-group-catalog.create-price-group',
    'pricing.price-group-catalog.create-price-group-definition-revision',
    'pricing.price-group-catalog.retire-price-group',
  ],
  appId: commerceAppId,
  buildMarker: ultramodernApiMarker.buildMarker,
  type: 'description',
  version: priceGroupTemporalProtocol,
}).pipe(Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))));
