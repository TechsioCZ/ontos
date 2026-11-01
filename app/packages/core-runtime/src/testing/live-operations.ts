import { v1 } from '@authzed/authzed-node';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  Config,
  Context,
  Crypto,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Random,
  Ref,
  Redacted,
  Schema,
  Scope,
} from 'effect';

import { ActionCommitIndeterminate, ActionTransactionError } from '../actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { ActionRepositoryService } from '../actions/repository.ts';
import { makeActionRepository } from '../actions/repository.ts';
import { ActionRuntime, makeActionRuntime } from '../actions/runtime.ts';
import { TargetModuleKeySchema } from '../actions/string-schemas.ts';
import {
  AuthenticationNamespaceIdSchema,
  BindingSubjectTypeSchema,
  PrincipalIdSchema,
  ProviderSubjectIdSchema,
} from '../auth/external-identity-contracts.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../auth/external-identity/verifier.ts';
import { CoreDatabase, makeCoreDatabase } from '../db/client.ts';
import { parseDatabaseConfig } from '../db/config.ts';
import {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../db/schema.ts';
import {
  buildActionAuthorizationRelationships,
  buildExplicitActionGrantRelationships,
} from '../install/action-authorization-provisioning.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../modules/module-state-gate.ts';
import { makeTenantModuleStateService, TenantModuleStateSchema } from '../modules/tenant-module-state-service.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../operations/context.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import {
  makeContextAccessLive,
  toContextPermissionAccessObjectId,
  toIdentityNamespaceAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../permissions/context-access.ts';
import type { ContextPermissionAccessTarget } from '../permissions/context-access.ts';
import { makeActionPermissionLive, toSpiceDbActionObjectId } from '../permissions/service.ts';
import { fullyConsistent } from '../permissions/client.ts';
import {
  OwnerAuthorizationOverlay,
  failClosedOwnerAuthorizationOverlay,
} from '../permissions/owner-authorization-overlay.ts';
import { newSpiceDbGrpcClient } from '../permissions/spicedb-grpc-rpc.ts';
import { ReadRuntime, makeReadRuntime } from '../reads/runtime.ts';

interface FixturePermissionEnvironment {
  SPICEDB_CA_CERT?: string;
  SPICEDB_ENDPOINT: string;
  SPICEDB_PRESHARED_KEY: Redacted.Redacted;
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT?: string;
}

const LIVE_FIXTURE_EXTERNAL_TIMEOUT = Duration.seconds(30);
const LOAD_EVIDENCE_FAILURE = 'Unable to load live fixture evidence';
const LOCAL_DATABASE_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);
const fixturePartyModule = 'party.registry';
const configuredModuleAccess = 'configured-modules';
const sameTenantEntity = 'same-tenant';
const managerOnlyExecution = 'manager-only';
const tenantMembershipExecution = 'tenant-membership';
const INVALID_FIXTURE_CONFIGURATION = 'Invalid live operation fixture configuration';
const INVALID_SERVICE_GRANT = 'Invalid existing service fixture authorization';

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: resourceId, objectType: resourceType },
    subject: { object: { objectId: subjectId, objectType: subjectType } },
  });

const FixtureAuthenticationMethodSchema = Schema.Literals(['session', 'api_key']);
const ActionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'));
const fixtureConfigurationFields = {
  actionExecutor: Schema.optionalKey(Schema.Literals([managerOnlyExecution, tenantMembershipExecution])),
  actionKeys: Schema.optional(Schema.Array(ActionKeySchema)),
  /**
   * Seeds Core tenancy rows. Defaults to the configured `DATABASE_ADMIN_URL`: dedicated runtime roles
   * cannot insert tenants, Legal Entities or principals.
   */
  additionalLegalEntity: Schema.optionalKey(Schema.Literal(sameTenantEntity)),
  allowedAudiences: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  authenticationSubjectTypes: Schema.optionalKey(Schema.Array(BindingSubjectTypeSchema).check(Schema.isMinLength(1))),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  /** Read-only executor probes; these keys never participate in grant construction. */
  executorProbeActionKeys: Schema.optionalKey(
    Schema.Array(
      ActionKeySchema.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(200),
        Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
      ),
    ).check(
      Schema.isMaxLength(128),
      Schema.makeFilter((keys) =>
        new Set(keys).size === keys.length ? undefined : 'Executor probe keys must be unique',
      ),
    ),
  ),
  managerAuthenticationMethod: Schema.optionalKey(FixtureAuthenticationMethodSchema),
  managerIdentityAdmin: Schema.optionalKey(Schema.Boolean),
  managerProviderSubjectId: Schema.optionalKey(ProviderSubjectIdSchema),
  managerProvisioningNamespaces: Schema.optionalKey(
    Schema.Array(AuthenticationNamespaceIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
  moduleAccess: Schema.optionalKey(Schema.Literal(configuredModuleAccess)),
  moduleKeys: Schema.optionalKey(Schema.Array(TargetModuleKeySchema).check(Schema.isMinLength(1))),
  /** Exact additional reader executor grants; allowed only in manager-only fixture execution. */
  readerActionKeys: Schema.optionalKey(
    Schema.Array(
      ActionKeySchema.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(200),
        Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
      ),
    ),
  ),
  readerProviderSubjectId: Schema.optionalKey(ProviderSubjectIdSchema),
} as const;
const validReaderActionSelection = Schema.makeFilter(
  (configuration: {
    readonly actionExecutor?: string | undefined;
    readonly actionKeys?: readonly string[] | undefined;
    readonly readerActionKeys?: readonly string[] | undefined;
  }) =>
    configuration.readerActionKeys === undefined ||
    (configuration.actionExecutor === managerOnlyExecution &&
      new Set(configuration.readerActionKeys).size === configuration.readerActionKeys.length &&
      configuration.readerActionKeys.every((key) => configuration.actionKeys?.includes(key) === true)),
);
const RuntimeFixtureConfigurationSchema = Schema.Struct(fixtureConfigurationFields).check(validReaderActionSelection);
const LiveOperationFixtureConfigurationSchema = Schema.Struct({
  ...fixtureConfigurationFields,
  adminConnectionString: Schema.optional(Schema.Redacted(Schema.String)),
  runtimeConnectionString: Schema.Redacted(Schema.String),
}).check(validReaderActionSelection);

export type LiveOperationFixtureConfiguration = typeof LiveOperationFixtureConfigurationSchema.Encoded;

/** Exact grants for a real service created through the fixture's public identity owner. */
export interface ExistingServiceFixtureGrant {
  readonly actionKeys: readonly string[];
  readonly legalEntityId: string;
  readonly moduleKeys: readonly string[];
  readonly principalId: string;
}

const ServiceFixtureKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('ServiceFixtureKey'));
const ServiceFixtureActionKeySchema = ServiceFixtureKeySchema.pipe(Schema.brand('ServiceFixtureActionKey'));
const ServiceFixtureModuleKeySchema = ServiceFixtureKeySchema.pipe(Schema.brand('ServiceFixtureModuleKey'));
const ServiceFixtureLegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const FixtureContextPermissionAccessTargetSchema = Schema.Struct({
  moduleId: ServiceFixtureModuleKeySchema,
  permission: ServiceFixtureKeySchema,
});
const ExistingServiceFixtureGrantSchema = Schema.Struct({
  actionKeys: Schema.Array(ServiceFixtureActionKeySchema),
  legalEntityId: ServiceFixtureLegalEntityIdSchema,
  moduleKeys: Schema.Array(ServiceFixtureModuleKeySchema).check(Schema.isMinLength(1)),
  principalId: PrincipalIdSchema,
});

class LiveOperationFixtureError extends Data.TaggedError('LiveOperationFixtureError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}

const fixtureFailure = (reason: string, cause?: unknown): LiveOperationFixtureError =>
  new LiveOperationFixtureError({ cause, reason });

const attemptFixturePromise = <Value>(
  reason: string,
  operation: () => PromiseLike<Value>,
): Effect.Effect<Value, LiveOperationFixtureError> =>
  Effect.tryPromise({
    catch: (cause) => fixtureFailure(reason, cause),
    try: operation,
  }).pipe(
    Effect.timeoutOrElse({
      duration: LIVE_FIXTURE_EXTERNAL_TIMEOUT,
      orElse: () => Effect.fail(fixtureFailure(`${reason}: timed out`)),
    }),
  );

const verifyFixturePermission = Effect.fn('LiveOperations.verifyFixturePermission')(
  function* verifyFixturePermissionEffect(
    spice: FixtureSpiceClient,
    principalId: string,
    resourceType: string,
    resourceId: string,
    permission: string,
    allowed: boolean,
  ) {
    const request = v1.CheckPermissionRequest.create({
      consistency: fullyConsistent,
      permission,
      resource: { objectId: resourceId, objectType: resourceType },
      subject: { object: { objectId: principalId, objectType: 'principal' } },
    });
    const result = yield* attemptFixturePromise(
      'Unable to verify live fixture authorization',
      spice.promises.checkPermission.bind(spice.promises, request),
    );
    const expected = allowed
      ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
      : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
    if (result.permissionship !== expected) {
      return yield* fixtureFailure('Live fixture authorization does not match its exact declared grants');
    }
    return yield* Effect.void;
  },
);

type FixtureExecutor = (typeof CoreDatabase)['Service']['executor'];
type FixtureSpiceClient = ReturnType<typeof v1.NewClient>;
const FixtureFaultSchema = Schema.Literals(['lost-ack', 'rollback']);
type FixtureFault = typeof FixtureFaultSchema.Type;

interface FixtureFaultState {
  active: FixtureFault | null;
  invocationId: string | null;
  next: FixtureFault | null;
}

const makeFixtureId = Effect.fn('LiveOperations.makeFixtureId')(function* makeFixtureIdEffect() {
  const chunks = yield* Effect.all(
    [
      Random.nextIntBetween(0, 4_294_967_296, { halfOpen: true }),
      Random.nextIntBetween(0, 4_294_967_296, { halfOpen: true }),
      Random.nextIntBetween(0, 4_294_967_296, { halfOpen: true }),
      Random.nextIntBetween(0, 4_294_967_296, { halfOpen: true }),
    ],
    { concurrency: 4 },
  );
  const value = chunks.map((chunk) => chunk.toString(16).padStart(8, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`;
});

const makeFixtureActor = Effect.fn('LiveOperations.makeFixtureActor')(function* makeFixtureActorEffect(
  tenantId: string,
  authenticationNamespaceId: string,
  authMethod: 'session' | 'api_key' = 'session',
) {
  const [authBindingId, principalId] = yield* Effect.all([makeFixtureId(), makeFixtureId()], {
    concurrency: 2,
  });
  return {
    authBindingId,
    authContextRef: `better-auth-session:${authBindingId}`,
    authenticationNamespaceId,
    authMethod,
    principalId,
    tenantId,
  };
});

type FixtureActor = Effect.Success<ReturnType<typeof makeFixtureActor>>;

const FixtureActorSchema = Schema.Struct({
  authBindingId: Schema.requiredKey(TrustedPrincipalContextSchema.fields.authBindingId),
  authContextRef: Schema.String,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  authMethod: FixtureAuthenticationMethodSchema,
  principalId: TrustedPrincipalContextSchema.fields.principalId,
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
});
/** Non-secret test identity/configuration only; never a credential or authorization receipt. */
export const LiveOperationFixtureRuntimeHandoffSchema = Schema.Struct({
  configuration: RuntimeFixtureConfigurationSchema,
  denied: FixtureActorSchema,
  legalEntityId: Schema.requiredKey(TrustedPrincipalContextSchema.fields.legalEntityId),
  legalEntityOnly: Schema.Struct({
    ...FixtureActorSchema.fields,
    legalEntityId: Schema.requiredKey(TrustedPrincipalContextSchema.fields.legalEntityId),
  }),
  manager: FixtureActorSchema,
  reader: FixtureActorSchema,
  secondaryLegalEntityId: Schema.optionalKey(Schema.requiredKey(TrustedPrincipalContextSchema.fields.legalEntityId)),
  target: Schema.Struct({ database: Schema.String, host: Schema.String, port: Schema.Int, user: Schema.String }),
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
});
export type LiveOperationFixtureRuntimeHandoff = typeof LiveOperationFixtureRuntimeHandoffSchema.Type;
export const LiveOperationFixtureBootstrapRequestSchema = Schema.Struct({
  providerSubjectId: ProviderSubjectIdSchema,
  type: Schema.Literal('auth-user-created'),
});
export type LiveOperationFixtureBootstrapRequest = typeof LiveOperationFixtureBootstrapRequestSchema.Encoded;
export const LiveOperationFixtureBootstrapResponseSchema = Schema.Struct({
  handoff: LiveOperationFixtureRuntimeHandoffSchema,
  type: Schema.Literal('fixture-prepared'),
});

const fixturePrincipalValues = (actors: readonly FixtureActor[], tenantId: string) =>
  actors.map((principal) => ({
    displayName: 'Live actor',
    kind: 'human' as const,
    principalId: principal.principalId,
    status: 'active' as const,
    tenantId,
  }));

interface FixtureProviderSubjects {
  readonly managerProviderSubjectId?: string | undefined;
  readonly readerProviderSubjectId?: string | undefined;
}

const fixtureProviderSubjectId = (
  actor: FixtureActor,
  manager: FixtureActor,
  reader: FixtureActor,
  configuration: FixtureProviderSubjects,
) => {
  if (actor === manager) {
    return configuration.managerProviderSubjectId ?? actor.authBindingId;
  }
  if (actor === reader) {
    return configuration.readerProviderSubjectId ?? actor.authBindingId;
  }
  return actor.authBindingId;
};

const fixtureAuthBindingValues = (
  actors: readonly FixtureActor[],
  tenantId: string,
  authenticationNamespaceId: string,
  manager: FixtureActor,
  reader: FixtureActor,
  configuration: FixtureProviderSubjects,
) =>
  actors.map((principal) => ({
    authenticationNamespaceId,
    principalAuthBindingId: principal.authBindingId,
    principalId: principal.principalId,
    provider: 'better_auth' as const,
    providerSubjectId: fixtureProviderSubjectId(principal, manager, reader, configuration),
    status: 'active' as const,
    subjectType: principal.authMethod === 'api_key' ? ('api_key' as const) : ('user' as const),
    tenantId,
  }));

const fixtureLegalEntityValues = (tenantId: string, legalEntityId: string) => ({
  legalEntityId,
  legalName: 'Disposable live acceptance',
  registrationCountry: 'CZ',
  registrationNumber: legalEntityId,
  status: 'active' as const,
  tenantId,
});

const secondaryLegalEntityRelationships = (tenantId: string, legalEntityId: string, manager: FixtureActor) => {
  const entityObject = toLegalEntityAccessObjectId(tenantId, legalEntityId);
  const moduleObject = toModuleAccessObjectId(tenantId, legalEntityId, fixturePartyModule);
  if (entityObject === undefined || moduleObject === undefined) {
    return null;
  }
  return [
    relationship('legal_entity', entityObject, 'tenant', 'tenant', tenantId),
    ...['member', 'counterparty_manager', 'counterparty_reader'].map((relation) =>
      relationship('legal_entity', entityObject, relation, 'principal', manager.principalId),
    ),
    relationship('module_access', moduleObject, 'legal_entity', 'legal_entity', entityObject),
    relationship('module_access', moduleObject, 'accessor', 'principal', manager.principalId),
  ];
};

const fixtureAuthorizationRelationships = (input: {
  readonly actionExecutor: 'manager-only' | 'tenant-membership';
  readonly actionKeys: readonly string[];
  readonly actors: readonly FixtureActor[];
  readonly entityObject: string;
  readonly legalEntityOnly: FixtureActor;
  readonly manager: FixtureActor;
  readonly moduleObject: string;
  readonly reader: FixtureActor;
  readonly readerActionKeys: readonly string[];
  readonly tenantId: string;
}) => [
  ...input.actors.map((principal) =>
    relationship('tenant', input.tenantId, 'member', 'principal', principal.principalId),
  ),
  ...['party_identity_manager', 'party_identity_reader', 'party_identity_reviewer', 'party_relationship_manager'].map(
    (relation) => relationship('tenant', input.tenantId, relation, 'principal', input.manager.principalId),
  ),
  relationship('tenant', input.tenantId, 'party_identity_reader', 'principal', input.reader.principalId),
  relationship('legal_entity', input.entityObject, 'tenant', 'tenant', input.tenantId),
  ...[input.manager, input.legalEntityOnly].flatMap((principal) =>
    ['member', 'counterparty_manager', 'counterparty_reader'].map((relation) =>
      relationship('legal_entity', input.entityObject, relation, 'principal', principal.principalId),
    ),
  ),
  relationship('module_access', input.moduleObject, 'legal_entity', 'legal_entity', input.entityObject),
  ...[input.manager, input.legalEntityOnly].map((principal) =>
    relationship('module_access', input.moduleObject, 'accessor', 'principal', principal.principalId),
  ),
  ...(input.actionExecutor === managerOnlyExecution
    ? buildExplicitActionGrantRelationships(
        input.actionKeys.map((actionKey) => ({ actionKey, principalIds: [input.manager.principalId] })),
      )
    : buildActionAuthorizationRelationships(input.actionKeys, [
        { principalId: input.manager.principalId, tenantId: input.tenantId },
      ])),
  ...buildExplicitActionGrantRelationships(
    input.readerActionKeys.map((actionKey) => ({ actionKey, principalIds: [input.reader.principalId] })),
  ),
];

const fixtureProvisioningNamespaces = (
  configuration: LiveOperationFixtureConfiguration,
): Effect.Effect<readonly string[], ReturnType<typeof fixtureFailure>> => {
  const namespaces = configuration.managerProvisioningNamespaces ?? [];
  if (
    namespaces.length > 0 &&
    (configuration.managerIdentityAdmin !== true ||
      configuration.actionExecutor !== managerOnlyExecution ||
      new Set(namespaces).size !== namespaces.length ||
      namespaces.some((namespace) => namespace.includes('*')))
  ) {
    return Effect.fail(fixtureFailure(INVALID_FIXTURE_CONFIGURATION));
  }
  return Effect.succeed(namespaces);
};

const prepareFixtureNamespaceProvisioning = Effect.fn('LiveOperations.prepareNamespaceProvisioning')(
  function* prepareNamespaceProvisioning(
    namespaces: readonly string[],
    tenantId: string,
    managerId: string,
    spice: FixtureSpiceClient,
  ) {
    const namespaceObjects = yield* Effect.forEach(
      namespaces,
      (namespace) => {
        const objectId = toIdentityNamespaceAccessObjectId(tenantId, namespace);
        return objectId === undefined
          ? Effect.fail(fixtureFailure(INVALID_FIXTURE_CONFIGURATION))
          : Effect.succeed(objectId);
      },
      { concurrency: 1 },
    );
    const namespaceRelationships = namespaceObjects.flatMap((objectId) => [
      relationship('identity_namespace', objectId, 'tenant', 'tenant', tenantId),
      relationship('identity_namespace', objectId, 'provisioner', 'principal', managerId),
    ]);
    const namespaceCleanup =
      namespaceRelationships.length === 0
        ? Effect.void
        : attemptFixturePromise(
            'Unable to remove fixture-owned namespace provisioning relationships',
            spice.promises.writeRelationships.bind(
              spice.promises,
              v1.WriteRelationshipsRequest.create({
                updates: namespaceRelationships.map((item) =>
                  v1.RelationshipUpdate.create({
                    operation: v1.RelationshipUpdate_Operation.DELETE,
                    relationship: item,
                  }),
                ),
              }),
            ),
          );
    return { namespaceCleanup, namespaceObjects, namespaceRelationships };
  },
);

const setupLiveOperationFixture = Effect.fn('LiveOperations.setupLiveOperationFixture')(
  function* setupLiveOperationFixtureEffect(input: {
    readonly actionExecutor: 'manager-only' | 'tenant-membership';
    readonly actionKeys: readonly string[];
    readonly actors: readonly FixtureActor[];
    readonly authenticationNamespaceId: string;
    readonly executor: FixtureExecutor;
    readonly legalEntityId: string;
    readonly legalEntityOnly: FixtureActor;
    readonly manager: FixtureActor;
    readonly managerIdentityAdmin: boolean | undefined;
    readonly managerProviderSubjectId: string | undefined;
    readonly moduleAccess: typeof configuredModuleAccess | undefined;
    readonly moduleKeys: readonly string[];
    readonly namespaceObjects: readonly string[];
    readonly namespaceRelationships: readonly ReturnType<typeof relationship>[];
    readonly reader: FixtureActor;
    readonly readerActionKeys: readonly string[];
    readonly readerProviderSubjectId: string | undefined;
    readonly secondaryLegalEntityId: string | undefined;
    readonly spice: FixtureSpiceClient;
    readonly tenantId: string;
  }) {
    const configuredModuleRelations: ReturnType<typeof relationship>[] = [];
    if (input.moduleAccess === configuredModuleAccess) {
      const entityObject = toLegalEntityAccessObjectId(input.tenantId, input.legalEntityId);
      if (entityObject === undefined) {
        return yield* fixtureFailure(INVALID_FIXTURE_CONFIGURATION);
      }
      for (const moduleKey of input.moduleKeys) {
        const moduleObject = toModuleAccessObjectId(input.tenantId, input.legalEntityId, moduleKey);
        if (moduleObject === undefined) {
          return yield* fixtureFailure(INVALID_FIXTURE_CONFIGURATION);
        }
        if (moduleKey !== fixturePartyModule) {
          configuredModuleRelations.push(
            relationship('module_access', moduleObject, 'legal_entity', 'legal_entity', entityObject),
            ...[input.manager, input.legalEntityOnly].map((principal) =>
              relationship('module_access', moduleObject, 'accessor', 'principal', principal.principalId),
            ),
          );
        }
      }
    }
    yield* input.executor
      .insert(tenants)
      .values({
        defaultLocale: 'en',
        name: 'Disposable live acceptance',
        slug: `live-${input.tenantId}`,
        status: 'active',
        tenantId: input.tenantId,
      })
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to create the live fixture tenant', cause)));
    yield* input.executor
      .insert(legalEntities)
      .values(fixtureLegalEntityValues(input.tenantId, input.legalEntityId))
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to create the live fixture Legal Entity', cause)));
    if (input.secondaryLegalEntityId !== undefined) {
      yield* input.executor
        .insert(legalEntities)
        .values(fixtureLegalEntityValues(input.tenantId, input.secondaryLegalEntityId))
        .pipe(
          Effect.mapError((cause) => fixtureFailure('Unable to create the secondary live fixture Legal Entity', cause)),
        );
    }
    yield* input.executor
      .insert(tenantModuleStates)
      .values(input.moduleKeys.map((moduleKey) => ({ moduleKey, state: 'active' as const, tenantId: input.tenantId })))
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to activate the live fixture module', cause)));
    yield* input.executor
      .insert(principals)
      .values(fixturePrincipalValues(input.actors, input.tenantId))
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to create the live fixture principals', cause)));
    yield* input.executor
      .insert(principalAuthBindings)
      .values(
        fixtureAuthBindingValues(
          input.actors,
          input.tenantId,
          input.authenticationNamespaceId,
          input.manager,
          input.reader,
          input,
        ),
      )
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to bind the live fixture principals', cause)));
    const entityObject = toLegalEntityAccessObjectId(input.tenantId, input.legalEntityId);
    const moduleObject = toModuleAccessObjectId(input.tenantId, input.legalEntityId, fixturePartyModule);
    if (entityObject === undefined || moduleObject === undefined) {
      return yield* fixtureFailure('Invalid fixture authorization scope');
    }
    const relations = fixtureAuthorizationRelationships({
      actionExecutor: input.actionExecutor,
      actionKeys: input.actionKeys,
      actors: input.actors,
      entityObject,
      legalEntityOnly: input.legalEntityOnly,
      manager: input.manager,
      moduleObject,
      reader: input.reader,
      readerActionKeys: input.readerActionKeys,
      tenantId: input.tenantId,
    });
    relations.push(...configuredModuleRelations, ...input.namespaceRelationships);
    if (input.managerIdentityAdmin === true) {
      relations.push(relationship('tenant', input.tenantId, 'identity_admin', 'principal', input.manager.principalId));
    }
    if (input.secondaryLegalEntityId !== undefined) {
      const secondary = secondaryLegalEntityRelationships(input.tenantId, input.secondaryLegalEntityId, input.manager);
      if (secondary === null) {
        return yield* fixtureFailure('Invalid secondary fixture authorization scope');
      }
      relations.push(...secondary);
    }
    const writeRelationshipsRequest = v1.WriteRelationshipsRequest.create({
      updates: relations.map((item) =>
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: item,
        }),
      ),
    });
    yield* attemptFixturePromise(
      'Unable to write live fixture authorization relationships',
      input.spice.promises.writeRelationships.bind(input.spice.promises, writeRelationshipsRequest),
    );
    if (input.managerIdentityAdmin === true) {
      yield* Effect.forEach(
        input.actors,
        (actor) =>
          verifyFixturePermission(
            input.spice,
            actor.principalId,
            'tenant',
            input.tenantId,
            'manage_identity',
            actor.principalId === input.manager.principalId,
          ),
        { concurrency: 4 },
      );
    }
    yield* Effect.forEach(
      input.namespaceObjects,
      (resourceId) =>
        Effect.forEach(
          input.actors,
          (actor) =>
            verifyFixturePermission(
              input.spice,
              actor.principalId,
              'identity_namespace',
              resourceId,
              'provision',
              actor.principalId === input.manager.principalId,
            ),
          { concurrency: 4 },
        ),
      { concurrency: 1 },
    );
    return yield* Effect.void;
  },
);

const makeFaultActionRepository = (state: FixtureFaultState, crypto: Crypto.Crypto): ActionRepositoryService => {
  const repository = makeActionRepository(crypto);
  const flushSuccess: ActionRepositoryService['flushSuccess'] = Effect.fn('LiveOperations.flushSuccess')(
    function* flushSuccessEffect(transaction, input) {
      state.invocationId = input.actionInvocationId;
      if (state.active === 'rollback') {
        return yield* new ActionTransactionError({
          code: 'action_transaction_failed',
          reason: 'Controlled precommit rollback',
        });
      }
      return yield* repository.flushSuccess(transaction, input);
    },
  );
  return { ...repository, flushSuccess };
};

/**
 * Reads Core evidence rows for the fixture tenant through the caller's executor. Callers pass the
 * admin client: dedicated request roles (for example the Party request role) cannot read events.
 * Rows come back in creation order with the primary key as tiebreak: PostgreSQL heap order moves
 * when a row is updated, so unordered snapshots cannot be compared.
 */
const loadFixtureEvidence = Effect.fn('LiveOperations.loadFixtureEvidence')(
  (executor: Pick<FixtureExecutor, 'select'>, tenantId: string) =>
    Effect.all(
      {
        accesses: executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.tenantId, tenantId))
          .orderBy(asc(dataAccessEvents.occurredAt), asc(dataAccessEvents.dataAccessEventId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
        audits: executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.tenantId, tenantId))
          .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.auditEventId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
        events: executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.tenantId, tenantId))
          .orderBy(asc(domainEvents.tenantSequenceNo))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
        invocations: executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.tenantId, tenantId))
          .orderBy(asc(actionInvocations.startedAt), asc(actionInvocations.actionInvocationId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
        outbox: executor
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.tenantId, tenantId))
          .orderBy(asc(outboxMessages.createdAt), asc(outboxMessages.outboxMessageId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
      },
      { concurrency: 5 },
    ),
);

const fixtureResourceRelationships = (
  tenantId: string,
  legalEntityId: string,
  resource: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
  },
  principalId: string,
  permission: 'reader' | 'writer',
) => {
  const entityObject = toLegalEntityAccessObjectId(tenantId, legalEntityId);
  const moduleObject = toModuleAccessObjectId(tenantId, legalEntityId, resource.moduleId);
  const resourceObject = toResourceAccessObjectId(tenantId, legalEntityId, resource);
  if (entityObject === undefined || moduleObject === undefined || resourceObject === undefined) {
    return null;
  }
  return {
    context: [
      relationship('module_access', moduleObject, 'legal_entity', 'legal_entity', entityObject),
      relationship('module_access', moduleObject, 'accessor', 'principal', principalId),
      relationship('resource', resourceObject, 'module', 'module_access', moduleObject),
    ],
    permission: relationship('resource', resourceObject, permission, 'principal', principalId),
  };
};

const grantFixtureResourceAccess = Effect.fn('LiveOperations.grantResourceAccess')(
  function* grantFixtureResourceAccessEffect(
    spice: FixtureSpiceClient,
    tenantId: string,
    legalEntityId: string,
    resource: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    },
    principalId: string,
    permission: 'reader' | 'writer',
  ) {
    const relations = fixtureResourceRelationships(tenantId, legalEntityId, resource, principalId, permission);
    if (relations === null) {
      return yield* fixtureFailure('Invalid resource fixture');
    }
    const writeRelationshipsRequest = v1.WriteRelationshipsRequest.create({
      updates: [...relations.context, relations.permission].map((item) =>
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: item,
        }),
      ),
    });
    return yield* attemptFixturePromise(
      'Unable to grant live fixture resource access',
      spice.promises.writeRelationships.bind(spice.promises, writeRelationshipsRequest),
    );
  },
);

const grantFixtureContextPermissionAccess = Effect.fn('LiveOperations.grantContextPermissionAccess')(
  function* grantFixtureContextPermissionAccessEffect(
    spice: FixtureSpiceClient,
    fixture: {
      readonly legalEntityId: string;
      readonly moduleKeys: ReadonlySet<string>;
      readonly principalIds: ReadonlySet<string>;
      readonly tenantId: string;
    },
    target: ContextPermissionAccessTarget,
    principalId: string,
  ) {
    const invalid = (cause?: unknown) => fixtureFailure('Invalid live fixture context permission grant', cause);
    const decoded = yield* Schema.decodeUnknownEffect(FixtureContextPermissionAccessTargetSchema, {
      onExcessProperty: 'error',
    })(target).pipe(Effect.mapError(invalid));
    const principal = yield* Schema.decodeUnknownEffect(PrincipalIdSchema)(principalId).pipe(Effect.mapError(invalid));
    if (!fixture.moduleKeys.has(decoded.moduleId) || !fixture.principalIds.has(principal)) {
      return yield* invalid();
    }
    const objectId = toContextPermissionAccessObjectId(fixture.tenantId, fixture.legalEntityId, decoded);
    if (objectId === undefined) {
      return yield* invalid();
    }
    const request = v1.WriteRelationshipsRequest.create({
      updates: [
        relationship('context_permission', objectId, 'tenant', 'tenant', fixture.tenantId),
        relationship('context_permission', objectId, 'grantee', 'principal', principal),
      ].map((item) =>
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: item,
        }),
      ),
    });
    yield* attemptFixturePromise(
      'Unable to grant live fixture context permission access',
      spice.promises.writeRelationships.bind(spice.promises, request),
    );
    return yield* verifyFixturePermission(spice, principal, 'context_permission', objectId, 'access', true);
  },
);

interface FixtureConfiguredModuleState {
  readonly moduleKey: string;
  readonly state: 'active' | 'suspended';
}
type FixtureConfiguredModuleStateSetter = (
  ...request: [moduleKey: string, state: 'active' | 'suspended']
) => Effect.Effect<FixtureConfiguredModuleState, LiveOperationFixtureError>;

const makeFixtureConfiguredModuleStateSetter = (
  adminConfiguration: Effect.Success<ReturnType<typeof parseFixtureDatabaseConfig>>,
  { moduleKeys, tenantId }: { readonly moduleKeys: ReadonlySet<string>; readonly tenantId: string },
): FixtureConfiguredModuleStateSetter =>
  Effect.fn('LiveOperations.setConfiguredModuleState')(function* setConfiguredModuleState(
    ...request: Parameters<FixtureConfiguredModuleStateSetter>
  ) {
    const invalid = (cause?: unknown) => fixtureFailure('Invalid configured fixture module state mutation', cause);
    const [moduleKey, state] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([ServiceFixtureModuleKeySchema, TenantModuleStateSchema]),
      { onExcessProperty: 'error' },
    )(request).pipe(Effect.mapError(invalid));
    if (!moduleKeys.has(moduleKey) || (state !== 'active' && state !== 'suspended')) {
      return yield* invalid();
    }
    return yield* Effect.scoped(
      Effect.gen(function* mutateFixtureModuleState() {
        const admin = yield* makeCoreDatabase({ ...adminConfiguration, maxConnections: 2 }).pipe(
          Effect.mapError((cause) =>
            fixtureFailure('Unable to initialize the fixture module-state admin database', cause),
          ),
        );
        return yield* admin.executor
          .transaction(
            Effect.fn('LiveOperations.persistConfiguredModuleState')(
              function* persistConfiguredModuleState(transaction) {
                const predicate = and(
                  eq(tenantModuleStates.tenantId, tenantId),
                  eq(tenantModuleStates.moduleKey, moduleKey),
                );
                const changed = yield* transaction
                  .update(tenantModuleStates)
                  .set({ state })
                  .where(predicate)
                  .returning({
                    moduleKey: tenantModuleStates.moduleKey,
                    tenantId: tenantModuleStates.tenantId,
                  });
                if (changed.length !== 1 || changed[0]?.tenantId !== tenantId || changed[0]?.moduleKey !== moduleKey) {
                  return yield* fixtureFailure(
                    'Configured fixture module state update did not match exactly one existing row',
                  );
                }
                const rows = yield* transaction
                  .select({
                    moduleKey: tenantModuleStates.moduleKey,
                    state: tenantModuleStates.state,
                    tenantId: tenantModuleStates.tenantId,
                  })
                  .from(tenantModuleStates)
                  .where(predicate);
                const [row] = rows;
                if (
                  rows.length !== 1 ||
                  row?.tenantId !== tenantId ||
                  row.moduleKey !== moduleKey ||
                  row.state !== state
                ) {
                  return yield* fixtureFailure('Configured fixture module state readback did not match the update');
                }
                return { moduleKey: row.moduleKey, state: row.state };
              },
            ),
          )
          .pipe(
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, 'LiveOperationFixtureError')
                ? cause
                : fixtureFailure('Unable to persist configured fixture module state', cause),
            ),
          );
      }),
    );
  });

const decodeDatabaseAddress = (connectionString: Redacted.Redacted) =>
  Schema.decodeEffect(Schema.URLFromString)(Redacted.value(connectionString)).pipe(
    Effect.mapError((cause) => fixtureFailure('Invalid live operation database URL', cause)),
  );

const parseFixtureDatabaseConfig = (connectionString: Redacted.Redacted) =>
  parseDatabaseConfig({ DATABASE_URL: Redacted.value(connectionString) }).pipe(
    Effect.mapError((cause) => fixtureFailure('Invalid database configuration', cause)),
  );
const revokeFixtureResourceAccess = Effect.fn('LiveOperations.revokeResourceAccess')(
  function* revokeFixtureResourceAccessEffect(
    spice: FixtureSpiceClient,
    tenantId: string,
    legalEntityId: string,
    resource: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
    },
    principalId: string,
    permission: 'reader' | 'writer',
  ) {
    const relations = fixtureResourceRelationships(tenantId, legalEntityId, resource, principalId, permission);
    if (relations === null) {
      return yield* fixtureFailure('Invalid resource fixture');
    }
    const request = v1.WriteRelationshipsRequest.create({
      updates: [
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.DELETE,
          relationship: relations.permission,
        }),
      ],
    });
    return yield* attemptFixturePromise(
      'Unable to revoke live fixture resource access',
      spice.promises.writeRelationships.bind(spice.promises, request),
    );
  },
);

const grantExistingFixtureService = Effect.fn('LiveOperations.grantExistingService')(
  function* grantExistingFixtureServiceEffect(
    executor: FixtureExecutor,
    spice: FixtureSpiceClient,
    fixture: {
      readonly actionExecutor: 'manager-only' | 'tenant-membership';
      readonly actionKeys: ReadonlySet<string>;
      readonly legalEntityId: string;
      readonly moduleKeys: ReadonlySet<string>;
      readonly tenantId: string;
    },
    requested: ExistingServiceFixtureGrant,
  ) {
    const grant = yield* Schema.decodeEffect(ExistingServiceFixtureGrantSchema)(requested).pipe(
      Effect.mapError((cause) => fixtureFailure(INVALID_SERVICE_GRANT, cause)),
    );
    if (
      fixture.actionExecutor !== managerOnlyExecution ||
      grant.legalEntityId !== fixture.legalEntityId ||
      new Set(grant.moduleKeys).size !== grant.moduleKeys.length ||
      new Set(grant.actionKeys).size !== grant.actionKeys.length ||
      grant.moduleKeys.some((key) => !fixture.moduleKeys.has(key)) ||
      grant.actionKeys.some(
        (key) => !fixture.actionKeys.has(key) || !grant.moduleKeys.some((moduleKey) => key.startsWith(`${moduleKey}.`)),
      )
    ) {
      return yield* fixtureFailure(INVALID_SERVICE_GRANT);
    }
    const persisted = yield* Effect.all(
      {
        entities: executor
          .select({
            legalEntityId: legalEntities.legalEntityId,
            status: legalEntities.status,
            tenantId: legalEntities.tenantId,
          })
          .from(legalEntities)
          .where(
            and(eq(legalEntities.legalEntityId, grant.legalEntityId), eq(legalEntities.tenantId, fixture.tenantId)),
          ),
        services: executor
          .select({
            kind: principals.kind,
            principalId: principals.principalId,
            status: principals.status,
            tenantId: principals.tenantId,
          })
          .from(principals)
          .where(and(eq(principals.principalId, grant.principalId), eq(principals.tenantId, fixture.tenantId))),
      },
      { concurrency: 2 },
    ).pipe(Effect.mapError((cause) => fixtureFailure('Unable to verify persisted service fixture identity', cause)));
    const [service] = persisted.services;
    const [entity] = persisted.entities;
    if (
      persisted.services.length !== 1 ||
      persisted.entities.length !== 1 ||
      service === undefined ||
      service.kind !== 'service' ||
      service.status !== 'active' ||
      service.principalId !== grant.principalId ||
      service.tenantId !== fixture.tenantId ||
      entity === undefined ||
      entity.status !== 'active' ||
      entity.legalEntityId !== fixture.legalEntityId ||
      entity.tenantId !== fixture.tenantId
    ) {
      return yield* fixtureFailure(INVALID_SERVICE_GRANT);
    }
    const entityObject = toLegalEntityAccessObjectId(fixture.tenantId, fixture.legalEntityId);
    if (entityObject === undefined) {
      return yield* fixtureFailure(INVALID_SERVICE_GRANT);
    }
    const moduleObjects = grant.moduleKeys.map((key) =>
      toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, key),
    );
    if (moduleObjects.some((key) => key === undefined)) {
      return yield* fixtureFailure(INVALID_SERVICE_GRANT);
    }
    const relations = [
      relationship('tenant', fixture.tenantId, 'member', 'principal', grant.principalId),
      relationship('legal_entity', entityObject, 'tenant', 'tenant', fixture.tenantId),
      relationship('legal_entity', entityObject, 'member', 'principal', grant.principalId),
      ...moduleObjects.flatMap((objectId) =>
        objectId === undefined
          ? []
          : [
              relationship('module_access', objectId, 'legal_entity', 'legal_entity', entityObject),
              relationship('module_access', objectId, 'accessor', 'principal', grant.principalId),
            ],
      ),
      ...buildExplicitActionGrantRelationships(
        grant.actionKeys.map((actionKey) => ({ actionKey, principalIds: [grant.principalId] })),
      ),
    ];
    const permissionCheck = (resourceType: string, resourceId: string, permission: string, allowed: boolean) =>
      verifyFixturePermission(spice, grant.principalId, resourceType, resourceId, permission, allowed);
    // A reused service must not already hold extra fixture permissions. No old grant is revoked.
    const unrequestedActions = [...fixture.actionKeys].filter(
      (key) => !grant.actionKeys.some((requestedKey) => requestedKey === key),
    );
    const unrequestedModules = [...fixture.moduleKeys].filter(
      (key) => !grant.moduleKeys.some((requestedKey) => requestedKey === key),
    );
    const verifyExcludedPermissions = () =>
      Effect.all(
        [
          Effect.forEach(
            unrequestedActions,
            (key) => permissionCheck('action', toSpiceDbActionObjectId(key), 'execute', false),
            { concurrency: 8 },
          ),
          Effect.forEach(
            unrequestedModules,
            (key) =>
              permissionCheck(
                'module_access',
                toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, key) ?? '',
                'access',
                false,
              ),
            { concurrency: 8 },
          ),
        ],
        { concurrency: 2 },
      );
    yield* verifyExcludedPermissions();
    const request = v1.WriteRelationshipsRequest.create({
      updates: relations.map((item) =>
        v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship: item }),
      ),
    });
    yield* attemptFixturePromise(
      'Unable to grant live fixture service authorization',
      spice.promises.writeRelationships.bind(spice.promises, request),
    );
    yield* permissionCheck('tenant', fixture.tenantId, 'access', true);
    yield* permissionCheck('legal_entity', entityObject, 'access', true);
    yield* Effect.forEach(moduleObjects, (key) => permissionCheck('module_access', key ?? '', 'access', true), {
      concurrency: 8,
    });
    yield* Effect.forEach(
      grant.actionKeys,
      (key) => permissionCheck('action', toSpiceDbActionObjectId(key), 'execute', true),
      { concurrency: 8 },
    );
    // Membership can activate preexisting inherited grants that were denied before the write.
    return yield* verifyExcludedPermissions();
  },
);

/** Real Core persistence and SpiceDB. Call only against a disposable local database. */
const makeLiveOperationRuntime = Effect.fn('LiveOperations.makeRuntime')(function* makeLiveOperationRuntime(input: {
  readonly closeResources: Effect.Effect<void, LiveOperationFixtureError>;
  readonly executor: FixtureExecutor;
  readonly runtimeHandoff: LiveOperationFixtureRuntimeHandoff;
  readonly setConfiguredModuleState?: FixtureConfiguredModuleStateSetter;
  readonly spice: FixtureSpiceClient;
  readonly spiceDb: Effect.Success<ReturnType<typeof loadSpiceDbConfig>>;
}) {
  const { closeResources, executor, runtimeHandoff, spice, spiceDb } = input;
  const { configuration, denied, legalEntityId, legalEntityOnly, manager, reader, secondaryLegalEntityId, tenantId } =
    runtimeHandoff;
  const crypto = yield* Crypto.Crypto;
  const executorProbeActors = new Set([
    manager.principalId,
    reader.principalId,
    denied.principalId,
    legalEntityOnly.principalId,
  ]);
  const executorProbeKeys = new Set<string>([
    ...(configuration.actionKeys ?? []),
    ...(configuration.executorProbeActionKeys ?? []),
  ]);
  const setConfiguredModuleState: FixtureConfiguredModuleStateSetter =
    input.setConfiguredModuleState ??
    (() => Effect.fail(fixtureFailure('Configured module state mutation requires the fixture creator')));
  const serviceGrantScope = {
    actionExecutor: configuration.actionExecutor ?? tenantMembershipExecution,
    actionKeys: new Set<string>(configuration.actionKeys),
    legalEntityId,
    moduleKeys: new Set<string>(configuration.moduleKeys ?? [fixturePartyModule]),
    tenantId,
  };
  const contextPermissionGrantScope = {
    legalEntityId,
    moduleKeys: serviceGrantScope.moduleKeys,
    principalIds: new Set([manager, legalEntityOnly, denied, reader].map((actor) => actor.principalId)),
    tenantId,
  };
  const faultState: FixtureFaultState = {
    active: null,
    invocationId: null,
    next: null,
  };
  const actionDatabase = {
    executor,
  } satisfies (typeof CoreDatabase)['Service'];
  const readDatabase = { executor } satisfies (typeof CoreDatabase)['Service'];
  const authenticationNamespaceRegistry = makeAuthenticationNamespaceRegistry([
    {
      allowedAudiences: configuration.allowedAudiences ?? ['party-registry'],
      authenticationNamespaceId: configuration.authenticationNamespaceId,
      provider: 'live-fixture',
      requiresOperationAdmission: false,
      reservationPrincipalKind: 'human',
      subjectTypes: configuration.authenticationSubjectTypes ?? ['user'],
      trustedAttesterPrincipalIds: [],
    },
  ]);
  const prepareOwner = Effect.fn('LiveOperations.prepareOwner')(function* prepareOwner<Value, Failure, Requirements>(
    producer: (
      transaction: ScopedTransactionExecutor,
      scope: OperationalScope,
    ) => Effect.Effect<Value, Failure, Requirements>,
    legalEntityScope: 'forbidden' | 'required' = 'forbidden',
  ) {
    // Test infrastructure metadata verifies that owner production cannot bypass tenant RLS.
    const [role] = yield* executor.execute<{ readonly bypassRls: boolean; readonly superuser: boolean }>(
      sql`select rolsuper as "superuser", rolbypassrls as "bypassRls" from pg_roles where rolname = current_user`,
      'objects',
    );
    if (role === undefined || role.superuser || role.bypassRls) {
      return yield* fixtureFailure('Owner fixtures require a runtime role without RLS bypass');
    }
    const contextAccess = yield* makeContextAccessLive(undefined, () => Effect.succeed(spiceDb));
    const resolver = yield* makeOperationalScopeResolver(makeOperationalScopeRepository(actionDatabase), contextAccess);
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(
      legalEntityScope === 'required' ? { ...manager, legalEntityId } : manager,
    );
    const scope = yield* resolver.resolve({
      correlationId: `live-owner-${manager.principalId}`,
      legalEntityScope,
      principal,
    });
    return yield* executor.transaction(
      Effect.fn('LiveOperations.produceOwner')(function* produceOwner(transaction) {
        const scoped = yield* installOperationalScope(transaction, scope);
        return yield* producer(scoped, scope);
      }),
    );
  });
  const layer = Layer.effectContext(
    Effect.gen(function* makeLiveOperationRuntimeContext() {
      const ownerAuthorization = yield* Effect.serviceOption(OwnerAuthorizationOverlay);
      const [contextAccess, actionPermission] = yield* Effect.all(
        [
          makeContextAccessLive(undefined, () => Effect.succeed(spiceDb)),
          makeActionPermissionLive(undefined, () => Effect.succeed(spiceDb)),
        ],
        { concurrency: 2 },
      );
      const actionModuleStateGate = makeModuleStateGate(makeTenantModuleStateService(actionDatabase));
      const actionModuleEntrypointGateway = makeModuleEntrypointGateway(actionModuleStateGate);
      const actionScopeResolver = yield* makeOperationalScopeResolver(
        makeOperationalScopeRepository(actionDatabase),
        contextAccess,
      );
      const readModuleStateGate = makeModuleStateGate(makeTenantModuleStateService(readDatabase));
      const readModuleEntrypointGateway = makeModuleEntrypointGateway(readModuleStateGate);
      const readScopeResolver = yield* makeOperationalScopeResolver(
        makeOperationalScopeRepository(readDatabase),
        contextAccess,
      );
      const baseActionRuntime = makeActionRuntime(
        actionDatabase,
        makeFaultActionRepository(faultState, crypto),
        actionPermission,
        actionScopeResolver,
        {
          contextAccess,
          // This fixture owns authorization and commit-fault acceptance. Release publication
          // is exercised separately against its own disposable composition authority.
          lockCompositionAuthority: () => Effect.succeed([]),
          moduleEntrypointGateway: actionModuleEntrypointGateway,
          moduleStateGate: actionModuleStateGate,
          ownerAuthorizationOverlay: Option.getOrElse(ownerAuthorization, () => failClosedOwnerAuthorizationOverlay),
          resolveCompositionRevision: () => Effect.succeed(configuration.compositionRevision),
        },
      );
      const runAction: (typeof ActionRuntime)['Service']['runAction'] = Effect.fn('LiveOperations.runAction')(
        function* runActionEffect(actionInput) {
          const fault = faultState.next;
          faultState.active = fault;
          faultState.invocationId = null;
          faultState.next = null;
          const actionExit = yield* Effect.exit(baseActionRuntime.runAction(actionInput)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                faultState.active = null;
              }),
            ),
          );
          if (Exit.isFailure(actionExit)) {
            return yield* Effect.failCause(actionExit.cause);
          }
          if (fault === 'lost-ack' && faultState.invocationId !== null) {
            return yield* new ActionCommitIndeterminate({
              code: 'action_commit_indeterminate',
              invocationId: faultState.invocationId,
              reason: 'Controlled lost commit acknowledgement',
            });
          }
          return actionExit.value;
        },
      );
      const actionRuntime = { ...baseActionRuntime, runAction };
      const readRuntime = makeReadRuntime(readDatabase, readModuleEntrypointGateway, readScopeResolver, contextAccess, {
        ownerAuthorizationOverlay: Option.getOrElse(ownerAuthorization, () => failClosedOwnerAuthorizationOverlay),
      });
      return Context.empty().pipe(
        Context.add(ActionRuntime, actionRuntime),
        Context.add(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
        Context.add(CoreDatabase, readDatabase),
        Context.add(ReadRuntime, readRuntime),
      );
    }),
  );

  const managerModuleAccessKeys = new Set([
    fixturePartyModule,
    ...(configuration.moduleAccess === configuredModuleAccess ? (configuration.moduleKeys ?? []) : []),
  ]);
  // Already validated by Core's TLS-only SpiceDB loader. Unwrap only into a trusted child env.
  const permissionEnvironment: FixturePermissionEnvironment = {
    SPICEDB_ENDPOINT: spiceDb.endpoint,
    SPICEDB_PRESHARED_KEY: Redacted.make(spiceDb.preSharedKey),
  };
  if (spiceDb.caCertificate !== undefined) {
    permissionEnvironment.SPICEDB_CA_CERT = spiceDb.caCertificate;
  }
  if (spiceDb.deploymentEnvironment !== undefined) {
    permissionEnvironment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT = spiceDb.deploymentEnvironment;
  }
  return {
    runtimeHandoff,
    /** Read-only normal fully-consistent executor check for this fixture's known actors and declared probe keys. */
    verifyActionExecutor: Effect.fn('LiveOperations.verifyActionExecutor')(function* verifyActionExecutor(probe: {
      readonly actionKey: string;
      readonly expected: 'allowed' | 'denied';
      readonly principalId: string;
    }) {
      if (!executorProbeActors.has(probe.principalId) || !executorProbeKeys.has(probe.actionKey)) {
        return yield* fixtureFailure('Executor verification requires a fixture-owned actor and declared action key');
      }
      return yield* verifyFixturePermission(
        spice,
        probe.principalId,
        'action',
        toSpiceDbActionObjectId(probe.actionKey),
        'execute',
        probe.expected === 'allowed',
      );
    }),
    // Mutate only the accessor tuple this fixture seeded for its exact primary-LE manager.
    changeManagerModuleAccess: Effect.fn('LiveOperations.changeManagerModuleAccess')(
      function* changeManagerModuleAccess(moduleKey: string, operation: 'grant' | 'revoke') {
        const moduleObject = toModuleAccessObjectId(tenantId, legalEntityId, moduleKey);
        if (!managerModuleAccessKeys.has(moduleKey) || moduleObject === undefined) {
          return yield* fixtureFailure('Module access mutation requires a fixture-owned manager grant');
        }
        const request = v1.WriteRelationshipsRequest.create({
          updates: [
            v1.RelationshipUpdate.create({
              operation:
                operation === 'grant' ? v1.RelationshipUpdate_Operation.TOUCH : v1.RelationshipUpdate_Operation.DELETE,
              relationship: relationship('module_access', moduleObject, 'accessor', 'principal', manager.principalId),
            }),
          ],
        });
        return yield* attemptFixturePromise(
          'Unable to change live fixture manager module access',
          spice.promises.writeRelationships.bind(spice.promises, request),
        );
      },
    ),
    denied,
    /** Pass the admin executor; the fixture's own runtime connection is not an evidence reader. */
    evidence: (evidenceExecutor: Pick<FixtureExecutor, 'select'>) => loadFixtureEvidence(evidenceExecutor, tenantId),
    faultNextTransaction: (fault: FixtureFault) => {
      faultState.next = fault;
    },
    // Test provisioning only: never creates identities/bindings or changes business permission policy.
    // Requires explicit manager-only fixture execution so Tenant membership cannot imply extra Actions.
    grantExistingService: (grant: ExistingServiceFixtureGrant) =>
      grantExistingFixtureService(executor, spice, serviceGrantScope, grant),
    /** Explicit named permission for one existing actor in this fixture's fixed Tenant/Legal Entity. */
    grantContextPermissionAccess: (target: ContextPermissionAccessTarget, principalId: string) =>
      grantFixtureContextPermissionAccess(spice, contextPermissionGrantScope, target, principalId),
    grantResourceAccess: (
      resource: {
        readonly moduleId: string;
        readonly resourceId: string;
        readonly resourceType: string;
      },
      principalId: string,
      permission: 'reader' | 'writer' = 'reader',
    ) => grantFixtureResourceAccess(spice, tenantId, legalEntityId, resource, principalId, permission),
    layer,
    legalEntityId,
    legalEntityOnly,
    manager,
    permissionEnvironment: Object.freeze(permissionEnvironment),
    prepareOwner,
    reader,
    // Delete only the exact resource permission, retaining shared module/legal-entity structure.
    // This is not full SpiceDB cleanup or an inverse of all four grant TOUCH tuples.
    // Call only for caller-owned fresh-resource grants: TOUCH is idempotent, not reference-counted,
    // so repeated grants do not establish tuple ownership. close never deletes resource grants.
    revokeResourceAccess: (
      resource: {
        readonly moduleId: string;
        readonly resourceId: string;
        readonly resourceType: string;
      },
      principalId: string,
      permission: 'reader' | 'writer' = 'reader',
    ) => revokeFixtureResourceAccess(spice, tenantId, legalEntityId, resource, principalId, permission),
    // Administrative test setup only; runtime-only attachments have no creator capability.
    setConfiguredModuleState,
    // This is the same persisted Principal/binding with a second genuine, explicitly granted LE selection.
    // Core context resolution must still validate this context for every real Action/Read.
    secondaryLegalEntity:
      secondaryLegalEntityId === undefined
        ? undefined
        : Object.freeze({
            legalEntityId: secondaryLegalEntityId,
            manager: Object.freeze({ ...manager, legalEntityId: secondaryLegalEntityId }),
          }),
    tenantId,
    // Retain append-only proof rows until the disposable database is removed.
    close: () => closeResources,
  };
});

const makeLiveOperationFixtureEffect = Effect.fn('LiveOperations.makeLiveOperationFixture')(
  function* makeLiveOperationFixtureEffect(input: LiveOperationFixtureConfiguration) {
    const { configuration, namespaces } = yield* Schema.decodeEffect(LiveOperationFixtureConfigurationSchema)(
      input,
    ).pipe(
      Effect.mapError((cause) => fixtureFailure(INVALID_FIXTURE_CONFIGURATION, cause)),
      Effect.flatMap((decoded) =>
        fixtureProvisioningNamespaces(decoded).pipe(
          Effect.map((allowedNamespaces) => ({ configuration: decoded, namespaces: allowedNamespaces })),
        ),
      ),
    );
    if (
      configuration.moduleAccess === configuredModuleAccess &&
      (configuration.moduleKeys === undefined ||
        new Set(configuration.moduleKeys).size !== configuration.moduleKeys.length)
    ) {
      return yield* fixtureFailure(INVALID_FIXTURE_CONFIGURATION);
    }
    const spiceDb = yield* loadSpiceDbConfig({ envPath: '/dev/null' }).pipe(
      Effect.mapError((cause) => fixtureFailure('Unable to load the SpiceDB configuration', cause)),
    );
    const { runtimeConnectionString } = configuration;
    const adminConnectionString =
      configuration.adminConnectionString ??
      (yield* Config.schema(Schema.Redacted(Schema.String), 'DATABASE_ADMIN_URL').pipe(
        Effect.mapError((cause) => fixtureFailure('Unable to load the administrative database URL', cause)),
      ));
    const [address, adminAddress] = yield* Effect.all(
      [decodeDatabaseAddress(runtimeConnectionString), decodeDatabaseAddress(adminConnectionString)],
      { concurrency: 1 },
    );
    if (
      !LOCAL_DATABASE_HOSTS.has(address.hostname) ||
      !LOCAL_DATABASE_HOSTS.has(adminAddress.hostname) ||
      !spiceDb.endpoint.startsWith('localhost:')
    ) {
      return yield* fixtureFailure('Live test fixtures require disposable localhost services');
    }

    const databaseScope = yield* Scope.make();
    const [databaseConfiguration, adminDatabaseConfiguration] = yield* Effect.all(
      [parseFixtureDatabaseConfig(runtimeConnectionString), parseFixtureDatabaseConfig(adminConnectionString)],
      { concurrency: 1 },
    );
    const { executor } = yield* makeCoreDatabase({ ...databaseConfiguration, maxConnections: 8 }).pipe(
      Scope.provide(databaseScope),
      Effect.mapError((cause) => fixtureFailure('Unable to initialize fixture database', cause)),
    );
    const spice = newSpiceDbGrpcClient(spiceDb);
    const [tenantId, legalEntityId] = yield* Effect.all([makeFixtureId(), makeFixtureId()], {
      concurrency: 2,
    });
    const [manager, legalEntityActor, denied, reader] = yield* Effect.all(
      [
        makeFixtureActor(tenantId, configuration.authenticationNamespaceId, configuration.managerAuthenticationMethod),
        makeFixtureActor(tenantId, configuration.authenticationNamespaceId),
        makeFixtureActor(tenantId, configuration.authenticationNamespaceId),
        makeFixtureActor(tenantId, configuration.authenticationNamespaceId),
      ],
      { concurrency: 4 },
    );
    const legalEntityOnly = { ...legalEntityActor, legalEntityId };
    const actors = [manager, legalEntityOnly, denied, reader];
    const secondaryLegalEntityId =
      configuration.additionalLegalEntity === sameTenantEntity ? yield* makeFixtureId() : undefined;
    const { namespaceCleanup, namespaceObjects, namespaceRelationships } = yield* prepareFixtureNamespaceProvisioning(
      namespaces,
      tenantId,
      manager.principalId,
      spice,
    );
    const closeResources = namespaceCleanup.pipe(
      Effect.ensuring(Effect.sync(spice.close.bind(spice)).pipe(Effect.andThen(Scope.close(databaseScope, Exit.void)))),
    );

    // Seed through a short-lived admin pool; the runtimes keep the runtime role's connection.
    yield* Effect.scoped(
      Effect.gen(function* seedLiveOperationFixture() {
        const admin = yield* makeCoreDatabase({ ...adminDatabaseConfiguration, maxConnections: 2 }).pipe(
          Effect.mapError((cause) => fixtureFailure('Unable to initialize the fixture admin database', cause)),
        );
        yield* setupLiveOperationFixture({
          actionExecutor: configuration.actionExecutor ?? tenantMembershipExecution,
          actionKeys: configuration.actionKeys ?? [],
          actors,
          authenticationNamespaceId: configuration.authenticationNamespaceId,
          executor: admin.executor,
          legalEntityId,
          legalEntityOnly,
          manager,
          managerIdentityAdmin: configuration.managerIdentityAdmin,
          managerProviderSubjectId: configuration.managerProviderSubjectId,
          moduleAccess: configuration.moduleAccess,
          moduleKeys: configuration.moduleKeys ?? [fixturePartyModule],
          namespaceObjects,
          namespaceRelationships,
          reader,
          readerActionKeys: configuration.readerActionKeys ?? [],
          readerProviderSubjectId: configuration.readerProviderSubjectId,
          secondaryLegalEntityId,
          spice,
          tenantId,
        });
      }),
    ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? closeResources : Effect.void)));

    const handoffInput = {
      configuration,
      denied,
      legalEntityId,
      legalEntityOnly,
      manager,
      reader,
      target: {
        database: databaseConfiguration.database,
        host: databaseConfiguration.host,
        port: databaseConfiguration.port,
        user: databaseConfiguration.user,
      },
      tenantId,
    };
    if (secondaryLegalEntityId !== undefined) {
      Object.assign(handoffInput, { secondaryLegalEntityId });
    }
    const runtimeHandoff = yield* Schema.decodeUnknownEffect(LiveOperationFixtureRuntimeHandoffSchema)(handoffInput);
    return yield* makeLiveOperationRuntime({
      closeResources,
      executor,
      runtimeHandoff,
      setConfiguredModuleState: makeFixtureConfiguredModuleStateSetter(adminDatabaseConfiguration, {
        moduleKeys: new Set(configuration.moduleKeys ?? [fixturePartyModule]),
        tenantId,
      }),
      spice,
      spiceDb,
    });
  },
);

/** Real Core persistence and SpiceDB. Call only against a disposable local database. */
export const makeLiveOperationFixture = Effect.fn('LiveOperations.makeLiveOperationFixture')(
  function* makeLiveOperationFixturePublicEffect(input: LiveOperationFixtureConfiguration) {
    return yield* makeLiveOperationFixtureEffect(input).pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, 'LiveOperationFixtureError')
          ? cause
          : fixtureFailure('Unable to create live operation fixture', cause),
      ),
    );
  },
);

const verifyRuntimeFixtureState = Effect.fn('LiveOperations.verifyRuntimeState')(function* verifyRuntimeFixtureState(
  executor: FixtureExecutor,
  runtimeHandoff: LiveOperationFixtureRuntimeHandoff,
) {
  const { denied, legalEntityId, legalEntityOnly, manager, reader, tenantId } = runtimeHandoff;
  const actors = [manager, legalEntityOnly, denied, reader];
  if (
    new Set(actors.map((actor) => actor.principalId)).size !== 4 ||
    new Set(actors.map((actor) => actor.authBindingId)).size !== 4 ||
    legalEntityOnly.legalEntityId !== legalEntityId ||
    actors.some(
      (actor) =>
        actor.tenantId !== tenantId ||
        actor.authenticationNamespaceId !== runtimeHandoff.configuration.authenticationNamespaceId,
    ) ||
    manager.authMethod !== (runtimeHandoff.configuration.managerAuthenticationMethod ?? 'session') ||
    (runtimeHandoff.configuration.additionalLegalEntity === sameTenantEntity) !==
      (runtimeHandoff.secondaryLegalEntityId !== undefined) ||
    actors.some((actor) => actor.authContextRef !== `better-auth-session:${actor.authBindingId}`)
  ) {
    return yield* fixtureFailure('Runtime fixture actor identities are contradictory');
  }
  const { bindingRows, entityRows, moduleRows, principalRows, tenantRows } = yield* Effect.all(
    {
      bindingRows: executor.select().from(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId)),
      entityRows: executor.select().from(legalEntities).where(eq(legalEntities.tenantId, tenantId)),
      moduleRows: executor.select().from(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId)),
      principalRows: executor.select().from(principals).where(eq(principals.tenantId, tenantId)),
      tenantRows: executor.select().from(tenants).where(eq(tenants.tenantId, tenantId)),
    },
    { concurrency: 2 },
  );
  if (
    tenantRows.length !== 1 ||
    tenantRows[0]?.status !== 'active' ||
    tenantRows[0]?.tenantId !== tenantId ||
    !entityRows.some(
      (entity) => entity.legalEntityId === legalEntityId && entity.tenantId === tenantId && entity.status === 'active',
    ) ||
    (runtimeHandoff.secondaryLegalEntityId !== undefined &&
      !entityRows.some(
        (entity) =>
          entity.legalEntityId === runtimeHandoff.secondaryLegalEntityId &&
          entity.tenantId === tenantId &&
          entity.status === 'active',
      )) ||
    actors.some(
      (actor) =>
        !principalRows.some(
          (principal) =>
            principal.principalId === actor.principalId &&
            principal.tenantId === tenantId &&
            principal.status === 'active' &&
            principal.kind === 'human',
        ) ||
        !bindingRows.some(
          (binding) =>
            binding.principalAuthBindingId === actor.authBindingId &&
            binding.tenantId === tenantId &&
            binding.principalId === actor.principalId &&
            binding.status === 'active' &&
            binding.authenticationNamespaceId === runtimeHandoff.configuration.authenticationNamespaceId &&
            binding.provider === 'better_auth' &&
            binding.subjectType === (actor.authMethod === 'api_key' ? 'api_key' : 'user') &&
            binding.providerSubjectId ===
              fixtureProviderSubjectId(actor, manager, reader, runtimeHandoff.configuration),
        ),
    ) ||
    (runtimeHandoff.configuration.moduleKeys ?? [fixturePartyModule]).some(
      (moduleKey) =>
        !moduleRows.some(
          (module) => module.moduleKey === moduleKey && module.tenantId === tenantId && module.state === 'active',
        ),
    )
  ) {
    return yield* fixtureFailure('Runtime fixture identities are not the active persisted creator state');
  }
  return yield* Effect.void;
});

/** Attach to parent-created identities. No administrative configuration, seeding or namespace provisioning. */
export const makeLiveOperationFixtureRuntime = Effect.fn('LiveOperations.attachRuntime')(
  function* makeLiveOperationFixtureRuntime(input: {
    readonly configuration: typeof RuntimeFixtureConfigurationSchema.Encoded;
    readonly handoff: typeof LiveOperationFixtureRuntimeHandoffSchema.Encoded;
    readonly runtimeConnectionString: Redacted.Redacted;
  }) {
    const runtimeHandoff = yield* Schema.decodeUnknownEffect(LiveOperationFixtureRuntimeHandoffSchema, {
      onExcessProperty: 'error',
    })(input.handoff).pipe(Effect.mapError((cause) => fixtureFailure(INVALID_FIXTURE_CONFIGURATION, cause)));
    const expected = yield* Schema.decodeUnknownEffect(RuntimeFixtureConfigurationSchema)(input.configuration).pipe(
      Effect.mapError((cause) => fixtureFailure(INVALID_FIXTURE_CONFIGURATION, cause)),
    );
    const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(RuntimeFixtureConfigurationSchema));
    if ((yield* encodeConfiguration(expected)) !== (yield* encodeConfiguration(runtimeHandoff.configuration))) {
      return yield* fixtureFailure('Runtime fixture configuration differs from its creator');
    }
    const configuration = yield* parseFixtureDatabaseConfig(input.runtimeConnectionString);
    const { target } = runtimeHandoff;
    if (
      !LOCAL_DATABASE_HOSTS.has(configuration.host) ||
      !/^ontos_test_party_gateway_[a-f\d]{32}$/u.test(configuration.database) ||
      configuration.database !== target.database ||
      configuration.host !== target.host ||
      configuration.port !== target.port ||
      configuration.user !== target.user
    ) {
      return yield* fixtureFailure('Runtime fixture requires its creator-owned disposable local target');
    }
    const databaseScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(databaseScope, exit));
    const { executor } = yield* makeCoreDatabase({ ...configuration, maxConnections: 8 }).pipe(
      Scope.provide(databaseScope),
    );
    // Native role metadata cannot be represented by an owner-table query builder.
    const [native] = yield* executor.execute<{
      readonly bypass: boolean;
      readonly createDb: boolean;
      readonly createRole: boolean;
      readonly database: string;
      readonly role: string;
      readonly session: string;
      readonly superuser: boolean;
    }>(
      sql`select current_database() as database, current_user as role, session_user as session,
      rolsuper as superuser, rolbypassrls as bypass, rolcreatedb as "createDb", rolcreaterole as "createRole"
      from pg_roles where rolname=current_user`,
      'objects',
    );
    if (
      native === undefined ||
      native.database !== target.database ||
      native.role !== target.user ||
      native.session !== target.user ||
      native.superuser ||
      native.bypass ||
      native.createDb ||
      native.createRole
    ) {
      return yield* fixtureFailure('Runtime fixture native identity is unsafe or foreign');
    }
    yield* verifyRuntimeFixtureState(executor, runtimeHandoff);
    const spiceDb = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    if (!spiceDb.endpoint.startsWith('localhost:')) {
      return yield* fixtureFailure('Runtime fixture requires disposable localhost services');
    }
    const spice = newSpiceDbGrpcClient(spiceDb);
    yield* Effect.addFinalizer(() => Effect.sync(spice.close.bind(spice))).pipe(Scope.provide(databaseScope));
    const closeResources = Scope.close(databaseScope, Exit.void);
    return yield* makeLiveOperationRuntime({ closeResources, executor, runtimeHandoff, spice, spiceDb });
  },
);

/** One fixed bootstrap exchange. Duplicate/malformed requests never run the creator callback. */
export const makeLiveOperationFixtureBootstrap = Effect.fn('LiveOperations.makeBootstrap')(
  function* makeLiveOperationFixtureBootstrap<Failure, Requirements>(
    prepare: (providerSubjectId: string) => Effect.Effect<LiveOperationFixtureRuntimeHandoff, Failure, Requirements>,
  ) {
    const used = yield* Ref.make(false);
    return Effect.fn('LiveOperations.bootstrap')(function* bootstrap(request: LiveOperationFixtureBootstrapRequest) {
      const decoded = yield* Schema.decodeUnknownEffect(LiveOperationFixtureBootstrapRequestSchema, {
        onExcessProperty: 'error',
      })(request).pipe(Effect.mapError((cause) => fixtureFailure('Malformed fixture bootstrap request', cause)));
      if (yield* Ref.getAndSet(used, true)) {
        return yield* fixtureFailure('Fixture bootstrap request was already consumed');
      }
      const handoff = yield* prepare(decoded.providerSubjectId);
      if (handoff.configuration.managerProviderSubjectId !== decoded.providerSubjectId) {
        return yield* fixtureFailure('Fixture bootstrap subject differs from its creator handoff');
      }
      return { handoff, type: 'fixture-prepared' as const };
    });
  },
);
