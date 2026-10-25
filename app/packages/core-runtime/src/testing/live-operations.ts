import { v1 } from '@authzed/authzed-node';
import { eq } from 'drizzle-orm';
import {
  Config,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Predicate,
  Random,
  Redacted,
  Schema,
  Scope,
} from 'effect';

import { ActionCommitIndeterminate, ActionTransactionError } from '../actions/errors.ts';
import type { ActionRepositoryService } from '../actions/repository.ts';
import { makeActionRepository } from '../actions/repository.ts';
import { ActionRuntime, makeActionRuntime } from '../actions/runtime.ts';
import { AuthenticationNamespaceIdSchema } from '../auth/external-identity-contracts.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../auth/external-identity/verifier.ts';
import { CoreDatabase, makeCoreDatabase } from '../db/client.ts';
import { parseDatabaseConfig } from '../db/config.ts';
import { DatabaseIdentityEnrollmentContext, defineDatabaseIdentityEnrollment } from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
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
  buildActionAuthorizationRoleGrantRelationships,
} from '../install/action-authorization-provisioning.ts';
import { toScopedRoleObjectId } from '../permissions/scoped-role.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../modules/tenant-module-state-service.ts';
import { makeOperationalScopeRepository, makeOperationalScopeResolver } from '../operations/context.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import {
  makeContextAccessLive,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../permissions/context-access.ts';
import { makeActionPermissionLive } from '../permissions/service.ts';
import { newSpiceDbGrpcClient } from '../permissions/spicedb-grpc-rpc.ts';
import { ReadRuntime, makeReadRuntime } from '../reads/runtime.ts';

const LIVE_FIXTURE_EXTERNAL_TIMEOUT = Duration.seconds(30);
const LOAD_EVIDENCE_FAILURE = 'Unable to load live fixture evidence';
const LOCAL_DATABASE_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

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

const ActionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'));
const LiveOperationFixtureConfigurationSchema = Schema.Struct({
  actionKeys: Schema.optional(Schema.Array(ActionKeySchema)),
  /** Exact subset of actionKeys granted only to the Legal Entity-only actor in its company scope. */
  legalEntityOnlyActionKeys: Schema.optional(Schema.Array(ActionKeySchema)),
  /** Deployment app id whose gateway assertions the fixture namespace accepts. */
  audience: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/u)),
  /**
   * Seeds Core tenancy rows. Defaults to the configured `DATABASE_ADMIN_URL`: dedicated runtime roles
   * cannot insert tenants, Legal Entities or principals.
   */
  adminConnectionString: Schema.optional(Schema.Redacted(Schema.String)),
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  /** Owner-authored relations granted to the fixture manager; Core adds no business grants. */
  tenantManagerRelations: Schema.optional(Schema.Array(Schema.String)),
  /** Owner-authored relations granted to both Legal Entity fixture members. */
  legalEntityManagerRelations: Schema.optional(Schema.Array(Schema.String)),
  /** The module under test: the fixture activates it and grants its module access. */
  moduleKey: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u)).pipe(
    Schema.brand('ModuleKey'),
  ),
  runtimeConnectionString: Schema.Redacted(Schema.String),
});

export type LiveOperationFixtureConfiguration = typeof LiveOperationFixtureConfigurationSchema.Encoded & {
  readonly databaseIdentities?: DatabaseIdentityEnrollment;
};

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
) {
  const [authBindingId, principalId] = yield* Effect.all([makeFixtureId(), makeFixtureId()], {
    concurrency: 2,
  });
  return {
    authBindingId,
    authContextRef: `better-auth-session:${authBindingId}`,
    authenticationNamespaceId,
    authMethod: 'session' as const,
    principalId,
    tenantId,
  };
});

type FixtureActor = Effect.Success<ReturnType<typeof makeFixtureActor>>;

const fixturePrincipalValues = (actors: readonly FixtureActor[], tenantId: string) =>
  actors.map((principal) => ({
    displayName: 'Live actor',
    kind: 'human' as const,
    principalId: principal.principalId,
    status: 'active' as const,
    tenantId,
  }));

const fixtureAuthBindingValues = (
  actors: readonly FixtureActor[],
  tenantId: string,
  authenticationNamespaceId: string,
) =>
  actors.map((principal) => ({
    authenticationNamespaceId,
    principalAuthBindingId: principal.authBindingId,
    principalId: principal.principalId,
    provider: 'better_auth' as const,
    providerSubjectId: principal.authBindingId,
    status: 'active' as const,
    subjectType: 'user' as const,
    tenantId,
  }));

const fixtureAuthorizationRelationships = (input: {
  readonly actionKeys: readonly string[];
  readonly actors: readonly FixtureActor[];
  readonly entityObject: string;
  readonly legalEntityId: string;
  readonly legalEntityManagerRelations: readonly string[];
  readonly legalEntityOnlyActionKeys: readonly string[];
  readonly legalEntityOnly: FixtureActor;
  readonly manager: FixtureActor;
  readonly moduleKey: string;
  readonly moduleObject: string;
  readonly tenantId: string;
  readonly tenantManagerRelations: readonly string[];
}) => {
  // Neither scope inherits the other's grant. The manager receives the published
  // catalog; the Legal Entity-only actor receives only its explicit company subset.
  const companyScope = {
    legalEntityId: input.legalEntityId,
    moduleKeys: [input.moduleKey],
    tenantId: input.tenantId,
  };
  const scopes = [{ moduleKeys: [input.moduleKey], tenantId: input.tenantId }, companyScope];
  const actions = scopes.flatMap((scope) => input.actionKeys.map((actionKey) => ({ ...scope, actionKey })));
  const roleKey = 'live-fixture-manager';
  const legalEntityOnlyRole = { ...companyScope, roleKey: 'live-fixture-legal-entity-only' };
  return [
    ...input.actors.map((principal) =>
      relationship('tenant', input.tenantId, 'member', 'principal', principal.principalId),
    ),
    ...input.tenantManagerRelations.map((relation) =>
      relationship('tenant', input.tenantId, relation, 'principal', input.manager.principalId),
    ),
    relationship('legal_entity', input.entityObject, 'tenant', 'tenant', input.tenantId),
    ...[input.manager, input.legalEntityOnly].flatMap((principal) =>
      ['member', ...input.legalEntityManagerRelations].map((relation) =>
        relationship('legal_entity', input.entityObject, relation, 'principal', principal.principalId),
      ),
    ),
    relationship('module_access', input.moduleObject, 'legal_entity', 'legal_entity', input.entityObject),
    ...[input.manager, input.legalEntityOnly].map((principal) =>
      relationship('module_access', input.moduleObject, 'accessor', 'principal', principal.principalId),
    ),
    ...buildActionAuthorizationRelationships(actions),
    ...buildActionAuthorizationRoleGrantRelationships(
      [
        ...actions.map((action) => ({ ...action, roleKey })),
        ...input.legalEntityOnlyActionKeys.map((actionKey) => ({ ...legalEntityOnlyRole, actionKey })),
      ],
      scopes,
    ),
    ...(input.legalEntityOnlyActionKeys.length === 0
      ? []
      : [
          relationship(
            'scoped_role',
            toScopedRoleObjectId(legalEntityOnlyRole),
            'member',
            'principal',
            input.legalEntityOnly.principalId,
          ),
        ]),
    ...scopes.map((scope) =>
      relationship(
        'scoped_role',
        toScopedRoleObjectId({ ...scope, roleKey }),
        'member',
        'principal',
        input.manager.principalId,
      ),
    ),
  ];
};

const setupLiveOperationFixture = Effect.fn('LiveOperations.setupLiveOperationFixture')(
  function* setupLiveOperationFixtureEffect(input: {
    readonly actionKeys: readonly string[];
    readonly actors: readonly FixtureActor[];
    readonly authenticationNamespaceId: string;
    readonly executor: FixtureExecutor;
    readonly legalEntityId: string;
    readonly legalEntityManagerRelations: readonly string[];
    readonly legalEntityOnlyActionKeys: readonly string[];
    readonly legalEntityOnly: FixtureActor;
    readonly manager: FixtureActor;
    readonly moduleKey: string;
    readonly spice: FixtureSpiceClient;
    readonly tenantId: string;
    readonly tenantManagerRelations: readonly string[];
  }) {
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
      .values({
        legalEntityId: input.legalEntityId,
        legalName: 'Disposable live acceptance',
        registrationCountry: 'CZ',
        registrationNumber: input.legalEntityId,
        status: 'active',
        tenantId: input.tenantId,
      })
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to create the live fixture Legal Entity', cause)));
    yield* input.executor
      .insert(tenantModuleStates)
      .values({
        moduleKey: input.moduleKey,
        state: 'active',
        tenantId: input.tenantId,
      })
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to activate the live fixture module', cause)));
    yield* input.executor
      .insert(principals)
      .values(fixturePrincipalValues(input.actors, input.tenantId))
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to create the live fixture principals', cause)));
    yield* input.executor
      .insert(principalAuthBindings)
      .values(fixtureAuthBindingValues(input.actors, input.tenantId, input.authenticationNamespaceId))
      .pipe(Effect.mapError((cause) => fixtureFailure('Unable to bind the live fixture principals', cause)));
    const entityObject = toLegalEntityAccessObjectId(input.tenantId, input.legalEntityId);
    const moduleObject = toModuleAccessObjectId(input.tenantId, input.legalEntityId, input.moduleKey);
    if (entityObject === undefined || moduleObject === undefined) {
      return yield* fixtureFailure('Invalid fixture authorization scope');
    }
    const relations = fixtureAuthorizationRelationships({
      actionKeys: input.actionKeys,
      actors: input.actors,
      entityObject,
      legalEntityId: input.legalEntityId,
      legalEntityManagerRelations: input.legalEntityManagerRelations,
      legalEntityOnlyActionKeys: input.legalEntityOnlyActionKeys,
      legalEntityOnly: input.legalEntityOnly,
      manager: input.manager,
      moduleKey: input.moduleKey,
      moduleObject,
      tenantId: input.tenantId,
      tenantManagerRelations: input.tenantManagerRelations,
    });
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
    return yield* Effect.void;
  },
);

const makeFaultActionRepository = (state: FixtureFaultState): ActionRepositoryService => {
  const repository = makeActionRepository();
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
 * admin client: dedicated request roles cannot read events.
 */
const loadFixtureEvidence = Effect.fn('LiveOperations.loadFixtureEvidence')(
  (executor: FixtureExecutor, tenantId: string) =>
    Effect.all(
      {
        accesses: executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.tenantId, tenantId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
        audits: executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.tenantId, tenantId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
        events: executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.tenantId, tenantId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
        invocations: executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.tenantId, tenantId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
        outbox: executor
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.tenantId, tenantId))
          .pipe(Effect.mapError((cause) => fixtureFailure(LOAD_EVIDENCE_FAILURE, cause))),
      },
      { concurrency: 5 },
    ),
);

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
    const entityObject = toLegalEntityAccessObjectId(tenantId, legalEntityId);
    const moduleObject = toModuleAccessObjectId(tenantId, legalEntityId, resource.moduleId);
    const resourceObject = toResourceAccessObjectId(tenantId, legalEntityId, resource);
    if (entityObject === undefined || moduleObject === undefined || resourceObject === undefined) {
      return yield* fixtureFailure('Invalid resource fixture');
    }
    const relations = [
      relationship('module_access', moduleObject, 'legal_entity', 'legal_entity', entityObject),
      relationship('module_access', moduleObject, 'accessor', 'principal', principalId),
      relationship('resource', resourceObject, 'module', 'module_access', moduleObject),
      relationship('resource', resourceObject, permission, 'principal', principalId),
    ];
    const writeRelationshipsRequest = v1.WriteRelationshipsRequest.create({
      updates: relations.map((item) =>
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

const decodeDatabaseAddress = (connectionString: Redacted.Redacted) =>
  Schema.decodeEffect(Schema.URLFromString)(Redacted.value(connectionString)).pipe(
    Effect.mapError((cause) => fixtureFailure('Invalid live operation database URL', cause)),
  );

const parseFixtureDatabaseConfig = (connectionString: Redacted.Redacted) =>
  parseDatabaseConfig({ DATABASE_URL: Redacted.value(connectionString) }).pipe(
    Effect.mapError((cause) => fixtureFailure('Invalid database configuration', cause)),
  );

/** Real Core persistence and SpiceDB. Call only against a disposable local database. */
const makeLiveOperationFixtureEffect = Effect.fn('LiveOperations.makeLiveOperationFixture')(
  function* makeLiveOperationFixtureEffect(input: LiveOperationFixtureConfiguration) {
    const databaseIdentities = input.databaseIdentities ?? defineDatabaseIdentityEnrollment([]);
    const configuration = yield* Schema.decodeEffect(LiveOperationFixtureConfigurationSchema)(input).pipe(
      Effect.mapError((cause) => fixtureFailure('Invalid live operation fixture configuration', cause)),
    );
    const actionKeys = configuration.actionKeys ?? [];
    const legalEntityOnlyActionKeys = configuration.legalEntityOnlyActionKeys ?? [];
    if (legalEntityOnlyActionKeys.some((actionKey) => !actionKeys.includes(actionKey))) {
      return yield* fixtureFailure('Legal Entity-only fixture Action keys must be included in actionKeys');
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
    const [manager, legalEntityActor, denied] = yield* Effect.all(
      [
        makeFixtureActor(tenantId, configuration.authenticationNamespaceId),
        makeFixtureActor(tenantId, configuration.authenticationNamespaceId),
        makeFixtureActor(tenantId, configuration.authenticationNamespaceId),
      ],
      { concurrency: 3 },
    );
    const legalEntityOnly = { ...legalEntityActor, legalEntityId };
    const actors = [manager, legalEntityOnly, denied];
    const closeResources = Effect.sync(spice.close.bind(spice)).pipe(
      Effect.andThen(Scope.close(databaseScope, Exit.void)),
    );

    // Seed through a short-lived admin pool; the runtimes keep the runtime role's connection.
    yield* Effect.scoped(
      Effect.gen(function* seedLiveOperationFixture() {
        const admin = yield* makeCoreDatabase({ ...adminDatabaseConfiguration, maxConnections: 2 }).pipe(
          Effect.mapError((cause) => fixtureFailure('Unable to initialize the fixture admin database', cause)),
        );
        yield* setupLiveOperationFixture({
          actionKeys,
          actors,
          authenticationNamespaceId: configuration.authenticationNamespaceId,
          executor: admin.executor,
          legalEntityId,
          legalEntityManagerRelations: configuration.legalEntityManagerRelations ?? [],
          legalEntityOnlyActionKeys,
          legalEntityOnly,
          manager,
          moduleKey: configuration.moduleKey,
          spice,
          tenantId,
          tenantManagerRelations: configuration.tenantManagerRelations ?? [],
        });
      }),
    ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? closeResources : Effect.void)));

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
        allowedAudiences: [configuration.audience],
        authenticationNamespaceId: configuration.authenticationNamespaceId,
        provider: 'live-fixture',
        requiresOperationAdmission: false,
        reservationPrincipalKind: 'human',
        subjectTypes: ['user'],
        trustedAttesterPrincipalIds: [],
      },
    ]);
    const layer = Layer.effectContext(
      Effect.gen(function* makeLiveOperationRuntimeContext() {
        const [contextAccess, actionPermission] = yield* Effect.all(
          [
            makeContextAccessLive(undefined, () => Effect.succeed(spiceDb)),
            makeActionPermissionLive(undefined, () => Effect.succeed(spiceDb)),
          ],
          { concurrency: 2 },
        );
        const actionModuleStateGate = makeModuleStateGate(makeTenantModuleStateService(actionDatabase));
        const actionModuleEntrypointGateway = makeModuleEntrypointGateway(actionModuleStateGate);
        const actionScopeResolver = makeOperationalScopeResolver(
          makeOperationalScopeRepository(actionDatabase, databaseIdentities),
          contextAccess,
        );
        const readModuleStateGate = makeModuleStateGate(makeTenantModuleStateService(readDatabase));
        const readModuleEntrypointGateway = makeModuleEntrypointGateway(readModuleStateGate);
        const readScopeResolver = makeOperationalScopeResolver(
          makeOperationalScopeRepository(readDatabase, databaseIdentities),
          contextAccess,
        );
        const baseActionRuntime = makeActionRuntime(
          actionDatabase,
          makeFaultActionRepository(faultState),
          actionPermission,
          actionScopeResolver,
          {
            contextAccess,
            databaseIdentities,
            // This fixture owns authorization and commit-fault acceptance. Release publication
            // is exercised separately against its own disposable composition authority.
            lockCompositionAuthority: () => Effect.succeed([]),
            moduleEntrypointGateway: actionModuleEntrypointGateway,
            moduleStateGate: actionModuleStateGate,
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
        const readRuntime = makeReadRuntime(
          readDatabase,
          readModuleEntrypointGateway,
          readScopeResolver,
          contextAccess,
          { databaseIdentities },
        );
        return Context.empty().pipe(
          Context.add(ActionRuntime, actionRuntime),
          Context.add(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
          Context.add(CoreDatabase, readDatabase),
          Context.add(DatabaseIdentityEnrollmentContext, databaseIdentities),
          Context.add(ReadRuntime, readRuntime),
        );
      }),
    );

    return {
      denied,
      /** Pass the admin executor; the fixture's own runtime connection is not an evidence reader. */
      evidence: (evidenceExecutor: FixtureExecutor) => loadFixtureEvidence(evidenceExecutor, tenantId),
      faultNextTransaction: (fault: FixtureFault) => {
        faultState.next = fault;
      },
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
      tenantId,
      // Retain append-only proof rows until the disposable database is removed.
      close: () => closeResources,
    };
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
