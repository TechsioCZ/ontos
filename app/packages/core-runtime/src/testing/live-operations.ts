import { v1 } from '@authzed/authzed-node';
import { eq } from 'drizzle-orm';
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Random,
  Redacted,
  Schema,
  Scope,
} from 'effect';
import { Pool } from 'pg';

import {
  ActionCommitIndeterminate,
  ActionTransactionError,
} from '../actions/errors.ts';
import type { ActionRepositoryService } from '../actions/repository.ts';
import { makeActionRepository } from '../actions/repository.ts';
import { ActionRuntime, makeActionRuntime } from '../actions/runtime.ts';
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
import { buildActionAuthorizationRelationships } from '../install/action-authorization-provisioning.ts';
import { makeModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../modules/tenant-module-state-service.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../operations/context.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import {
  makeContextAccessLive,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../permissions/context-access.ts';
import { makeActionPermissionLive } from '../permissions/service.ts';
import { ReadRuntime, makeReadRuntime } from '../reads/runtime.ts';

const LIVE_FIXTURE_EXTERNAL_TIMEOUT = Duration.seconds(30);
const LOAD_EVIDENCE_FAILURE = 'Unable to load live fixture evidence';

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: resourceId, objectType: resourceType },
    subject: { object: { objectId: subjectId, objectType: subjectType } },
  });

const ActionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'));
const LiveOperationFixtureConfigurationSchema = Schema.Struct({
  actionKeys: Schema.optional(Schema.Array(ActionKeySchema)),
  runtimeConnectionString: Schema.Redacted(Schema.String),
});

export type LiveOperationFixtureConfiguration =
  typeof LiveOperationFixtureConfigurationSchema.Encoded;

class LiveOperationFixtureError extends Schema.TaggedError<LiveOperationFixtureError>()(
  'LiveOperationFixtureError',
  {
    reason: Schema.String,
  }
) {}

const fixtureFailure = (
  reason: string,
  cause?: unknown
): LiveOperationFixtureError => {
  const failure = new LiveOperationFixtureError({ reason });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { value: cause });
};

const attemptFixturePromise = <Value>(
  reason: string,
  operation: () => PromiseLike<Value>
): Effect.Effect<Value, LiveOperationFixtureError> =>
  Effect.tryPromise({
    catch: (cause) => fixtureFailure(reason, cause),
    try: operation,
  }).pipe(
    Effect.timeoutOrElse({
      duration: LIVE_FIXTURE_EXTERNAL_TIMEOUT,
      orElse: () => Effect.fail(fixtureFailure(`${reason}: timed out`)),
    })
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

const makeFixtureId = Effect.fn('LiveOperations.makeFixtureId')(
  function* makeFixtureIdEffect() {
    const chunks = yield* Effect.all(
      [
        Random.nextIntBetween(0, 4_294_967_296, { halfOpen: true }),
        Random.nextIntBetween(0, 4_294_967_296, { halfOpen: true }),
        Random.nextIntBetween(0, 4_294_967_296, { halfOpen: true }),
        Random.nextIntBetween(0, 4_294_967_296, { halfOpen: true }),
      ],
      { concurrency: 4 }
    );
    const value = chunks
      .map((chunk) => chunk.toString(16).padStart(8, '0'))
      .join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`;
  }
);

const makeFixtureActor = Effect.fn('LiveOperations.makeFixtureActor')(
  function* makeFixtureActorEffect(tenantId: string) {
    const [authBindingId, principalId] = yield* Effect.all(
      [makeFixtureId(), makeFixtureId()],
      {
        concurrency: 2,
      }
    );
    return {
      authBindingId,
      authContextRef: `better-auth-session:${authBindingId}`,
      authMethod: 'session' as const,
      principalId,
      tenantId,
    };
  }
);

type FixtureActor = Effect.Success<ReturnType<typeof makeFixtureActor>>;

const fixturePrincipalValues = (
  actors: readonly FixtureActor[],
  tenantId: string
) =>
  actors.map((principal) => ({
    displayName: 'Live actor',
    kind: 'human' as const,
    principalId: principal.principalId,
    status: 'active' as const,
    tenantId,
  }));

const fixtureAuthBindingValues = (
  actors: readonly FixtureActor[],
  tenantId: string
) =>
  actors.map((principal) => ({
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
  readonly legalEntityOnly: FixtureActor;
  readonly manager: FixtureActor;
  readonly tenantId: string;
}) => [
  ...input.actors.map((principal) =>
    relationship(
      'tenant',
      input.tenantId,
      'member',
      'principal',
      principal.principalId
    )
  ),
  ...[
    'party_identity_manager',
    'party_identity_reader',
    'party_identity_reviewer',
    'party_relationship_manager',
  ].map((relation) =>
    relationship(
      'tenant',
      input.tenantId,
      relation,
      'principal',
      input.manager.principalId
    )
  ),
  relationship(
    'legal_entity',
    input.entityObject,
    'tenant',
    'tenant',
    input.tenantId
  ),
  ...[input.manager, input.legalEntityOnly].flatMap((principal) =>
    ['member', 'counterparty_manager', 'counterparty_reader'].map((relation) =>
      relationship(
        'legal_entity',
        input.entityObject,
        relation,
        'principal',
        principal.principalId
      )
    )
  ),
  ...buildActionAuthorizationRelationships(input.actionKeys, [
    { principalId: input.manager.principalId, tenantId: input.tenantId },
  ]),
];

const setupLiveOperationFixture = Effect.fn(
  'LiveOperations.setupLiveOperationFixture'
)(function* setupLiveOperationFixtureEffect(input: {
  readonly actionKeys: readonly string[];
  readonly actors: readonly FixtureActor[];
  readonly executor: FixtureExecutor;
  readonly legalEntityId: string;
  readonly legalEntityOnly: FixtureActor;
  readonly manager: FixtureActor;
  readonly spice: FixtureSpiceClient;
  readonly tenantId: string;
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
    .pipe(
      Effect.mapError((cause) =>
        fixtureFailure('Unable to create the live fixture tenant', cause)
      )
    );
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
    .pipe(
      Effect.mapError((cause) =>
        fixtureFailure('Unable to create the live fixture Legal Entity', cause)
      )
    );
  yield* input.executor
    .insert(tenantModuleStates)
    .values({
      moduleKey: 'party.registry',
      state: 'active',
      tenantId: input.tenantId,
    })
    .pipe(
      Effect.mapError((cause) =>
        fixtureFailure('Unable to activate the live fixture module', cause)
      )
    );
  yield* input.executor
    .insert(principals)
    .values(fixturePrincipalValues(input.actors, input.tenantId))
    .pipe(
      Effect.mapError((cause) =>
        fixtureFailure('Unable to create the live fixture principals', cause)
      )
    );
  yield* input.executor
    .insert(principalAuthBindings)
    .values(fixtureAuthBindingValues(input.actors, input.tenantId))
    .pipe(
      Effect.mapError((cause) =>
        fixtureFailure('Unable to bind the live fixture principals', cause)
      )
    );
  const entityObject = toLegalEntityAccessObjectId(
    input.tenantId,
    input.legalEntityId
  );
  if (entityObject === undefined) {
    return yield* fixtureFailure('Invalid fixture Legal Entity');
  }
  const relations = fixtureAuthorizationRelationships({
    actionKeys: input.actionKeys,
    actors: input.actors,
    entityObject,
    legalEntityOnly: input.legalEntityOnly,
    manager: input.manager,
    tenantId: input.tenantId,
  });
  const writeRelationshipsRequest = v1.WriteRelationshipsRequest.create({
    updates: relations.map((item) =>
      v1.RelationshipUpdate.create({
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relationship: item,
      })
    ),
  });
  yield* attemptFixturePromise(
    'Unable to write live fixture authorization relationships',
    input.spice.promises.writeRelationships.bind(
      input.spice.promises,
      writeRelationshipsRequest
    )
  );
  return yield* Effect.void;
});

const makeFaultActionRepository = (
  state: FixtureFaultState
): ActionRepositoryService => {
  const repository = makeActionRepository();
  const flushSuccess: ActionRepositoryService['flushSuccess'] = Effect.fn(
    'LiveOperations.flushSuccess'
  )(function* flushSuccessEffect(transaction, input) {
    state.invocationId = input.actionInvocationId;
    if (state.active === 'rollback') {
      return yield* new ActionTransactionError({
        code: 'action_transaction_failed',
        reason: 'Controlled precommit rollback',
      });
    }
    return yield* repository.flushSuccess(transaction, input);
  });
  return { ...repository, flushSuccess };
};

const loadFixtureEvidence = Effect.fn('LiveOperations.loadFixtureEvidence')(
  (executor: FixtureExecutor, tenantId: string) =>
    Effect.all(
      {
        accesses: executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.tenantId, tenantId))
          .pipe(
            Effect.mapError((cause) =>
              fixtureFailure(LOAD_EVIDENCE_FAILURE, cause)
            )
          ),
        audits: executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.tenantId, tenantId))
          .pipe(
            Effect.mapError((cause) =>
              fixtureFailure(LOAD_EVIDENCE_FAILURE, cause)
            )
          ),
        events: executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.tenantId, tenantId))
          .pipe(
            Effect.mapError((cause) =>
              fixtureFailure(LOAD_EVIDENCE_FAILURE, cause)
            )
          ),
        invocations: executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.tenantId, tenantId))
          .pipe(
            Effect.mapError((cause) =>
              fixtureFailure(LOAD_EVIDENCE_FAILURE, cause)
            )
          ),
        outbox: executor
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.tenantId, tenantId))
          .pipe(
            Effect.mapError((cause) =>
              fixtureFailure(LOAD_EVIDENCE_FAILURE, cause)
            )
          ),
      },
      { concurrency: 5 }
    )
);

const grantFixtureResourceAccess = Effect.fn(
  'LiveOperations.grantResourceAccess'
)(function* grantFixtureResourceAccessEffect(
  spice: FixtureSpiceClient,
  tenantId: string,
  legalEntityId: string,
  resource: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
  },
  principalId: string,
  permission: 'reader' | 'writer'
) {
  const entityObject = toLegalEntityAccessObjectId(tenantId, legalEntityId);
  const moduleObject = toModuleAccessObjectId(
    tenantId,
    legalEntityId,
    resource.moduleId
  );
  const resourceObject = toResourceAccessObjectId(
    tenantId,
    legalEntityId,
    resource
  );
  if (
    entityObject === undefined ||
    moduleObject === undefined ||
    resourceObject === undefined
  ) {
    return yield* fixtureFailure('Invalid resource fixture');
  }
  const relations = [
    relationship(
      'module_access',
      moduleObject,
      'legal_entity',
      'legal_entity',
      entityObject
    ),
    relationship(
      'module_access',
      moduleObject,
      'accessor',
      'principal',
      principalId
    ),
    relationship(
      'resource',
      resourceObject,
      'module',
      'module_access',
      moduleObject
    ),
    relationship(
      'resource',
      resourceObject,
      permission,
      'principal',
      principalId
    ),
  ];
  const writeRelationshipsRequest = v1.WriteRelationshipsRequest.create({
    updates: relations.map((item) =>
      v1.RelationshipUpdate.create({
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relationship: item,
      })
    ),
  });
  return yield* attemptFixturePromise(
    'Unable to grant live fixture resource access',
    spice.promises.writeRelationships.bind(
      spice.promises,
      writeRelationshipsRequest
    )
  );
});

/** Real Core persistence and SpiceDB. Call only against a disposable local database. */
const makeLiveOperationFixtureEffect = Effect.fn(
  'LiveOperations.makeLiveOperationFixture'
)(function* makeLiveOperationFixtureEffect(
  input: LiveOperationFixtureConfiguration
) {
  const configuration = yield* Schema.decodeEffect(
    LiveOperationFixtureConfigurationSchema
  )(input).pipe(
    Effect.mapError((cause) =>
      fixtureFailure('Invalid live operation fixture configuration', cause)
    )
  );
  const spiceDb = yield* loadSpiceDbConfig().pipe(
    Effect.mapError((cause) =>
      fixtureFailure('Unable to load the SpiceDB configuration', cause)
    )
  );
  const runtimeConnectionString = Redacted.value(
    configuration.runtimeConnectionString
  );
  const address = yield* Schema.decodeEffect(Schema.URLFromString)(
    runtimeConnectionString
  ).pipe(
    Effect.mapError((cause) =>
      fixtureFailure('Invalid live operation database URL', cause)
    )
  );
  if (
    !['localhost', '127.0.0.1'].includes(address.hostname) ||
    !spiceDb.endpoint.startsWith('localhost:')
  ) {
    return yield* fixtureFailure(
      'Live test fixtures require disposable localhost services'
    );
  }

  const pool = new Pool({ connectionString: runtimeConnectionString, max: 8 });
  const databaseScope = yield* Scope.make();
  const databaseConfiguration = yield* parseDatabaseConfig({
    DATABASE_URL: runtimeConnectionString,
  }).pipe(
    Effect.mapError((cause) =>
      fixtureFailure('Invalid database configuration', cause)
    )
  );
  const { executor } = yield* makeCoreDatabase(
    databaseConfiguration,
    () => pool
  ).pipe(
    Scope.provide(databaseScope),
    Effect.mapError((cause) =>
      fixtureFailure('Unable to initialize fixture database', cause)
    )
  );
  const spice = v1.NewClient(
    spiceDb.preSharedKey,
    spiceDb.endpoint,
    v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
  );
  const [tenantId, legalEntityId] = yield* Effect.all(
    [makeFixtureId(), makeFixtureId()],
    {
      concurrency: 2,
    }
  );
  const [manager, legalEntityActor, denied] = yield* Effect.all(
    [
      makeFixtureActor(tenantId),
      makeFixtureActor(tenantId),
      makeFixtureActor(tenantId),
    ],
    { concurrency: 3 }
  );
  const legalEntityOnly = { ...legalEntityActor, legalEntityId };
  const actors = [manager, legalEntityOnly, denied];
  const closeResources = Effect.sync(spice.close.bind(spice)).pipe(
    Effect.andThen(Scope.close(databaseScope, Exit.void))
  );

  yield* setupLiveOperationFixture({
    actionKeys: configuration.actionKeys ?? [],
    actors,
    executor,
    legalEntityId,
    legalEntityOnly,
    manager,
    spice,
    tenantId,
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? closeResources : Effect.void
    )
  );

  const faultState: FixtureFaultState = {
    active: null,
    invocationId: null,
    next: null,
  };
  const actionDatabase = {
    executor,
  } satisfies (typeof CoreDatabase)['Service'];
  const readDatabase = { executor } satisfies (typeof CoreDatabase)['Service'];
  const layer = Layer.effectContext(
    Effect.gen(function* makeLiveOperationRuntimeContext() {
      const [contextAccess, actionPermission] = yield* Effect.all(
        [
          makeContextAccessLive(undefined, () => Effect.succeed(spiceDb)),
          makeActionPermissionLive(undefined, () => Effect.succeed(spiceDb)),
        ],
        { concurrency: 2 }
      );
      const actionModuleStateGate = makeModuleStateGate(
        makeTenantModuleStateService(actionDatabase)
      );
      const actionModuleEntrypointGateway = makeModuleEntrypointGateway(
        actionModuleStateGate
      );
      const actionScopeResolver = makeOperationalScopeResolver(
        makeOperationalScopeRepository(actionDatabase),
        contextAccess
      );
      const readModuleStateGate = makeModuleStateGate(
        makeTenantModuleStateService(readDatabase)
      );
      const readModuleEntrypointGateway =
        makeModuleEntrypointGateway(readModuleStateGate);
      const readScopeResolver = makeOperationalScopeResolver(
        makeOperationalScopeRepository(readDatabase),
        contextAccess
      );
      const baseActionRuntime = makeActionRuntime(
        actionDatabase,
        makeFaultActionRepository(faultState),
        actionPermission,
        actionScopeResolver,
        {
          contextAccess,
          moduleEntrypointGateway: actionModuleEntrypointGateway,
          moduleStateGate: actionModuleStateGate,
        }
      );
      const runAction: (typeof ActionRuntime)['Service']['runAction'] =
        Effect.fn('LiveOperations.runAction')(
          function* runActionEffect(actionInput) {
            const fault = faultState.next;
            faultState.active = fault;
            faultState.invocationId = null;
            faultState.next = null;
            const actionExit = yield* Effect.exit(
              baseActionRuntime.runAction(actionInput)
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  faultState.active = null;
                })
              )
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
          }
        );
      const actionRuntime = { ...baseActionRuntime, runAction };
      const readRuntime = makeReadRuntime(
        readDatabase,
        readModuleEntrypointGateway,
        readScopeResolver,
        contextAccess
      );
      return Context.empty().pipe(
        Context.add(ActionRuntime, actionRuntime),
        Context.add(CoreDatabase, readDatabase),
        Context.add(ReadRuntime, readRuntime)
      );
    })
  );

  return {
    denied,
    evidence: () => loadFixtureEvidence(executor, tenantId),
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
      permission: 'reader' | 'writer' = 'reader'
    ) =>
      grantFixtureResourceAccess(
        spice,
        tenantId,
        legalEntityId,
        resource,
        principalId,
        permission
      ),
    layer,
    legalEntityId,
    legalEntityOnly,
    manager,
    tenantId,
    // Retain append-only proof rows until the disposable database is removed.
    close: () => closeResources,
  };
});

/** Real Core persistence and SpiceDB. Call only against a disposable local database. */
export const makeLiveOperationFixture = Effect.fn(
  'LiveOperations.makeLiveOperationFixture'
)(function* makeLiveOperationFixturePublicEffect(
  input: LiveOperationFixtureConfiguration
) {
  return yield* makeLiveOperationFixtureEffect(input).pipe(
    Effect.mapError((cause) =>
      Schema.is(LiveOperationFixtureError)(cause)
        ? cause
        : fixtureFailure('Unable to create live operation fixture', cause)
    )
  );
});
