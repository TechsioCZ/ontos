import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, Option, Predicate } from 'effect';
import type { Cause } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';

const HAS = v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
const NO = v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
const CONDITIONAL = v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION;
const MODES = ['run', 'propose', 'approve'] as const;
const SELECTORS = ['all', 'assigned', 'entrusted', 'team'] as const;
const CAPABILITY_PERMISSIONS = MODES.flatMap((mode) => SELECTORS.map((selector) => `${mode}_${selector}`));
// Fixed end dates on either side of any run (2000-01-01 and 2100-01-01 UTC): SpiceDB compares
// relationship expirations with its own clock, so the tests read no clock at all.
const ELAPSED_MS = 946_684_800_000;
const FUTURE_MS = 4_102_444_800_000;
/** gRPC INVALID_ARGUMENT, the answer to a relationship whose subject type the schema forbids. */
const INVALID_ARGUMENT = 3;

const fullyConsistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
const spiceDbEffect = <Value>(operation: PromiseLike<Value>) => Effect.tryPromise(() => operation);

interface WriteRejection {
  readonly code: number | undefined;
  readonly details: string;
}

/**
 * The gRPC rejection of a write the schema's subject types forbid. `Effect.tryPromise` wraps a
 * rejected promise in a `Cause.UnknownError`, so the transport error sits one level down.
 */
/** Empty when the schema accepted the write. */
const rejectionOf = (
  effect: Effect.Effect<unknown, Cause.UnknownError>,
): Effect.Effect<Option.Option<WriteRejection>> =>
  Effect.match(effect, {
    onFailure: (failure): Option.Option<WriteRejection> => {
      const cause = Predicate.hasProperty(failure, 'cause') ? failure.cause : failure;
      return Option.some({
        code: Predicate.hasProperty(cause, 'code') && Predicate.isNumber(cause.code) ? cause.code : undefined,
        details: Predicate.hasProperty(cause, 'details') && Predicate.isString(cause.details) ? cause.details : '',
      });
    },
    onSuccess: () => Option.none(),
  });
/** Asserts that a write was refused because the subject type is not allowed on that relation. */
const expectRejectedSubject = (rejection: Option.Option<WriteRejection>, subjectType: string, label: string) => {
  const failure = Option.getOrUndefined(rejection);
  expect(failure === undefined, label).toBe(false);
  expect(failure?.code, label).toBe(INVALID_ARGUMENT);
  expect(failure?.details ?? '', label).toMatch(new RegExp(`\`${subjectType}\`.*not allowed`, 'u'));
};

const timestamp = (epochMs: number) => ({ nanos: 0, seconds: String(Math.floor(epochMs / 1000)) });

interface Subject {
  readonly id: string;
  readonly relation?: string;
  readonly type: string;
}
const human = (id: string): Subject => ({ id, type: 'access_human' });
const agent = (id: string): Subject => ({ id, type: 'agent' });
/** The legacy multi-kind principal: a v2 relation must never accept it (O46). */
const legacyPrincipal = (id: string): Subject => ({ id, type: 'principal' });

interface TupleOptions {
  readonly caveat?: { readonly context: v1.PbStruct; readonly name: string };
  readonly expiresAtMs?: number;
}

/**
 * One test's v2 graph. Every object ID carries a fresh prefix, and every touched object is deleted
 * on scope close, so the suite can share a SpiceDB with other integration suites.
 */
const makeGraph = Effect.gen(function* accessV2Graph() {
  const configuration = yield* loadSpiceDbConfig();
  const prefix = yield* (yield* Crypto.Crypto).randomUUIDv4();
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => newSpiceDbGrpcClient(configuration)),
    (current) => Effect.sync(() => current.close()),
  );
  const touched = new Map<string, v1.ObjectReference>();
  const ref = (objectType: string, id: string) =>
    v1.ObjectReference.create({ objectId: `${prefix}-${id}`, objectType });
  const subjectRef = (subject: Subject) =>
    v1.SubjectReference.create({ object: ref(subject.type, subject.id), optionalRelation: subject.relation ?? '' });
  const tuple = (
    resourceType: string,
    resourceId: string,
    relation: string,
    subject: Subject,
    options: TupleOptions = {},
  ) => {
    const resource = ref(resourceType, resourceId);
    touched.set(`${resource.objectType}:${resource.objectId}`, resource);
    const relationship = v1.Relationship.create({ relation, resource, subject: subjectRef(subject) });
    if (options.caveat !== undefined) {
      relationship.optionalCaveat = v1.ContextualizedCaveat.create({
        caveatName: options.caveat.name,
        context: options.caveat.context,
      });
    }
    if (options.expiresAtMs !== undefined) {
      relationship.optionalExpiresAt = timestamp(options.expiresAtMs);
    }
    return relationship;
  };
  const update = (operation: v1.RelationshipUpdate_Operation) => (relationships: readonly v1.Relationship[]) =>
    spiceDbEffect(
      client.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: relationships.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
        }),
      ),
    );
  const touch = update(v1.RelationshipUpdate_Operation.TOUCH);
  const remove = update(v1.RelationshipUpdate_Operation.DELETE);
  const check = (
    resourceType: string,
    resourceId: string,
    permission: string,
    subject: Subject,
    context?: Record<string, number | string | string[]>,
  ) => {
    const request = v1.CheckPermissionRequest.create({
      consistency: fullyConsistent,
      permission,
      resource: ref(resourceType, resourceId),
      subject: subjectRef(subject),
    });
    if (context !== undefined) {
      request.context = v1.createStructFromObject(context);
    }
    return spiceDbEffect(client.promises.checkPermission(request)).pipe(
      Effect.map((response) => response.permissionship),
    );
  };
  /** One CheckBulk snapshot; each item is true only for an unconditional HAS_PERMISSION. */
  const checkBulk = (
    items: readonly {
      readonly permission: string;
      readonly resource: readonly [string, string];
      readonly subject: Subject;
    }[],
  ) =>
    spiceDbEffect(
      client.promises.checkBulkPermissions(
        v1.CheckBulkPermissionsRequest.create({
          consistency: fullyConsistent,
          items: items.map((item) =>
            v1.CheckBulkPermissionsRequestItem.create({
              permission: item.permission,
              resource: ref(...item.resource),
              subject: subjectRef(item.subject),
            }),
          ),
        }),
      ),
    ).pipe(
      Effect.map(({ pairs }) =>
        pairs.map(({ response }) => response.oneofKind === 'item' && response.item.permissionship === HAS),
      ),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...touched.values()],
      (resource) =>
        spiceDbEffect(
          client.promises.deleteRelationships(
            v1.DeleteRelationshipsRequest.create({
              relationshipFilter: v1.RelationshipFilter.create({
                optionalResourceId: resource.objectId,
                resourceType: resource.objectType,
              }),
            }),
          ),
        ),
      { concurrency: 'unbounded', discard: true },
    ).pipe(Effect.orDie),
  );
  yield* spiceDbEffect(client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })));

  const capability = (id: string, scope = 'scope-a', installation = 'install-a') => [
    tuple('access_capability', id, 'scope', { id: scope, type: 'access_scope' }),
    tuple('access_capability', id, 'installation', { id: installation, type: 'access_installation' }),
  ];
  const assignment = (id: string, holder: Subject, scope = 'scope-a', options: TupleOptions = {}) => [
    tuple('access_assignment', id, 'scope', { id: scope, type: 'access_scope' }),
    tuple('access_assignment', id, holder.type === 'agent' ? 'agent_holder' : 'holder', holder, options),
  ];
  const bindingMember = (binding: string, assignmentId: string, holder: 'agent' | 'human' = 'human') =>
    tuple('access_role_binding', binding, holder === 'agent' ? 'agent_member' : 'member', {
      id: assignmentId,
      relation: holder === 'agent' ? 'agent_holder' : 'holder',
      type: 'access_assignment',
    });
  const binding = (id: string, assignmentId: string, scope = 'scope-a', holder: 'agent' | 'human' = 'human') => [
    tuple('access_role_binding', id, 'scope', { id: scope, type: 'access_scope' }),
    bindingMember(id, assignmentId, holder),
  ];
  /** One complete cell: the capability slot, the grant and its (optionally caveated) binding. */
  const cell = (
    id: string,
    capabilityId: string,
    bindingId: string,
    slot = 'run_all_grant',
    caveat?: TupleOptions['caveat'],
  ) => [
    tuple('access_grant', id, 'capability', { id: capabilityId, type: 'access_capability' }),
    tuple(
      'access_grant',
      id,
      'binding',
      { id: bindingId, type: 'access_role_binding' },
      caveat === undefined ? {} : { caveat },
    ),
    tuple('access_capability', capabilityId, slot, { id, type: 'access_grant' }),
  ];

  // One Tenant with Legal Entities A and B; scopes for both and for the Tenant context.
  yield* touch([
    ...['owner', 'admin', 'alice', 'bob', 'delegate', 'approver', 'backup'].map((id) =>
      tuple('access_tenant', 'tenant', 'member', human(id)),
    ),
    tuple('access_tenant', 'tenant', 'member', agent('bot')),
    tuple('access_tenant', 'tenant', 'owner', human('owner')),
    tuple('access_legal_entity', 'entity-a', 'tenant', { id: 'tenant', type: 'access_tenant' }),
    tuple('access_legal_entity', 'entity-b', 'tenant', { id: 'tenant', type: 'access_tenant' }),
    ...['admin', 'alice', 'delegate', 'approver', 'backup'].map((id) =>
      tuple('access_legal_entity', 'entity-a', 'member', human(id)),
    ),
    tuple('access_legal_entity', 'entity-a', 'member', agent('bot')),
    tuple('access_legal_entity', 'entity-a', 'access_admin', human('admin')),
    tuple('access_legal_entity', 'entity-b', 'member', human('bob')),
    tuple('access_scope', 'scope-a', 'tenant', { id: 'tenant', type: 'access_tenant' }),
    tuple('access_scope', 'scope-a', 'legal_entity', { id: 'entity-a', type: 'access_legal_entity' }),
    tuple('access_scope', 'scope-b', 'tenant', { id: 'tenant', type: 'access_tenant' }),
    tuple('access_scope', 'scope-b', 'legal_entity', { id: 'entity-b', type: 'access_legal_entity' }),
    tuple('access_scope', 'scope-tenant', 'tenant', { id: 'tenant', type: 'access_tenant' }),
    tuple('access_scope', 'scope-tenant', 'tenant_context', { id: 'tenant', type: 'access_tenant' }),
    tuple('access_installation', 'install-a', 'enabled_scope', { id: 'scope-a', type: 'access_scope' }),
    tuple('access_installation', 'install-b', 'enabled_scope', { id: 'scope-b', type: 'access_scope' }),
    tuple('access_installation', 'install-tenant', 'enabled_scope', { id: 'scope-tenant', type: 'access_scope' }),
    ...capability('pay'),
    ...capability('pay-b', 'scope-b', 'install-b'),
    ...assignment('alice-assignment', human('alice')),
    ...binding('alice-binding', 'alice-assignment'),
  ]);
  return { assignment, binding, bindingMember, capability, cell, check, checkBulk, remove, touch, tuple };
});

type Graph = Effect.Success<typeof makeGraph>;
const withGraph = <Value, Failure, Requirements>(test: (graph: Graph) => Effect.Effect<Value, Failure, Requirements>) =>
  makeGraph.pipe(Effect.flatMap(test), Effect.scoped);

/**
 * Core's agent decision for one capability: the user and agent witnesses from one CheckBulk
 * snapshot, then the connection ceiling that Core reads from fresh SQL intent.
 */
const agentUse = (graph: Graph, capabilityId: string, connection: ReadonlySet<string>) =>
  graph
    .checkBulk([
      { permission: 'run_all', resource: ['access_capability', capabilityId], subject: human('alice') },
      { permission: 'run_all', resource: ['access_capability', capabilityId], subject: agent('bot') },
    ])
    .pipe(Effect.map((witnesses) => [...witnesses, connection.has(capabilityId)]));

it.layer(NodeServices.layer, { excludeTestServices: true })('access v2 schema graph', (suite) => {
  suite.effect('makes a new capability configurable by administrators and usable by nobody without a grant', () =>
    withGraph(({ capability, cell, check, touch }) =>
      Effect.gen(function* newCapability() {
        yield* touch([
          ...capability('new'),
          ...capability('tenant-new', 'scope-tenant', 'install-tenant'),
          // Alice already holds a role with other cells; a role never follows new capabilities.
          ...cell('alice-pay', 'pay', 'alice-binding'),
        ]);
        expect(yield* check('access_capability', 'pay', 'run_all', human('alice'))).toBe(HAS);
        for (const id of ['owner', 'admin']) {
          expect(yield* check('access_capability', 'new', 'configure', human(id)), id).toBe(HAS);
        }
        for (const id of ['alice', 'bob', 'delegate', 'stranger']) {
          expect(yield* check('access_capability', 'new', 'configure', human(id)), id).toBe(NO);
        }
        expect(yield* check('access_capability', 'new', 'configure', agent('bot'))).toBe(NO);
        // Tenant-context capabilities are configured by the owner, not by a Legal Entity administrator.
        expect(yield* check('access_capability', 'tenant-new', 'configure', human('owner'))).toBe(HAS);
        expect(yield* check('access_capability', 'tenant-new', 'configure', human('admin'))).toBe(NO);
        const actors = [...['owner', 'admin', 'alice', 'bob', 'delegate', 'stranger'].map(human), agent('bot')];
        for (const actor of actors) {
          for (const permission of CAPABILITY_PERMISSIONS) {
            for (const id of ['new', 'tenant-new']) {
              expect(yield* check('access_capability', id, permission, actor), `${actor.id} ${id} ${permission}`).toBe(
                NO,
              );
            }
          }
        }
      }),
    ),
  );

  suite.effect('gives the owner and administrators management only; operation requires membership', () =>
    withGraph(({ assignment, binding, cell, check, touch, tuple }) =>
      Effect.gen(function* ownerIsNotMember() {
        expect(yield* check('access_scope', 'scope-a', 'administer', human('owner'))).toBe(HAS);
        expect(yield* check('access_scope', 'scope-a', 'select', human('owner'))).toBe(HAS);
        expect(yield* check('access_scope', 'scope-a', 'access', human('owner'))).toBe(NO);
        // An administrator title is no business access: without a grant the admin runs nothing.
        expect(yield* check('access_scope', 'scope-a', 'access', human('admin'))).toBe(HAS);
        expect(yield* check('access_capability', 'pay', 'configure', human('admin'))).toBe(HAS);
        expect(yield* check('access_capability', 'pay', 'run_all', human('admin'))).toBe(NO);
        // A Legal Entity admin relation without membership administers nothing.
        yield* touch([tuple('access_legal_entity', 'entity-a', 'access_admin', human('owner-assistant'))]);
        expect(yield* check('access_capability', 'pay', 'configure', human('owner-assistant'))).toBe(NO);

        yield* touch([
          ...assignment('owner-assignment', human('owner')),
          ...binding('owner-binding', 'owner-assignment'),
          ...cell('owner-pay', 'pay', 'owner-binding'),
        ]);
        expect(yield* check('access_capability', 'pay', 'run_all', human('owner'))).toBe(NO);
        yield* touch([tuple('access_legal_entity', 'entity-a', 'member', human('owner'))]);
        expect(yield* check('access_capability', 'pay', 'run_all', human('owner'))).toBe(HAS);
        // Suspension in the Legal Entity removes both operation and administration there.
        yield* touch([tuple('access_legal_entity', 'entity-a', 'suspended', human('owner'))]);
        expect(yield* check('access_capability', 'pay', 'run_all', human('owner'))).toBe(NO);
        expect(yield* check('access_scope', 'scope-a', 'administer', human('owner'))).toBe(NO);
        expect(yield* check('access_scope', 'scope-b', 'administer', human('owner'))).toBe(HAS);
      }),
    ),
  );

  suite.effect('never lets access in one Legal Entity or Tenant authorize another', () =>
    withGraph(({ assignment, binding, cell, check, touch, tuple }) =>
      Effect.gen(function* legalEntityIsolation() {
        yield* touch([
          ...cell('alice-pay', 'pay', 'alice-binding'),
          ...assignment('bob-assignment', human('bob'), 'scope-b'),
          ...binding('bob-binding', 'bob-assignment', 'scope-b'),
          ...cell('bob-pay', 'pay-b', 'bob-binding'),
        ]);
        expect(yield* check('access_capability', 'pay', 'run_all', human('alice'))).toBe(HAS);
        expect(yield* check('access_capability', 'pay-b', 'run_all', human('bob'))).toBe(HAS);
        expect(yield* check('access_capability', 'pay-b', 'run_all', human('alice'))).toBe(NO);
        expect(yield* check('access_capability', 'pay', 'run_all', human('bob'))).toBe(NO);
        // Membership in B alone adds nothing: the grant cell is per scope.
        yield* touch([tuple('access_legal_entity', 'entity-b', 'member', human('alice'))]);
        expect(yield* check('access_capability', 'pay-b', 'run_all', human('alice'))).toBe(NO);
        expect(yield* check('access_capability', 'pay', 'run_all', human('alice'))).toBe(HAS);
        // A Legal Entity membership never stands without its Tenant membership.
        yield* touch([
          tuple('access_legal_entity', 'foreign-entity', 'tenant', { id: 'foreign-tenant', type: 'access_tenant' }),
          tuple('access_legal_entity', 'foreign-entity', 'member', human('alice')),
          tuple('access_scope', 'foreign-scope', 'tenant', { id: 'foreign-tenant', type: 'access_tenant' }),
          tuple('access_scope', 'foreign-scope', 'legal_entity', { id: 'foreign-entity', type: 'access_legal_entity' }),
        ]);
        expect(yield* check('access_scope', 'foreign-scope', 'access', human('alice'))).toBe(NO);
        expect(yield* check('access_scope', 'foreign-scope', 'select', human('owner'))).toBe(NO);
      }),
    ),
  );

  suite.effect('requires the user, the agent and the connection together for agent use; agents never approve', () =>
    withGraph((graph) =>
      Effect.gen(function* agentIntersection() {
        const { assignment, binding, capability, cell, check, remove, touch, tuple } = graph;
        // `pay` is just a capability key here: neither risk nor the agent policy exists in the graph,
        // so an agent's run witness is not by itself a decision (O48).
        const userCell = cell('user-pay', 'pay', 'alice-binding');
        const agentCell = cell('agent-pay', 'pay', 'bot-binding');
        yield* touch([
          ...capability('export'),
          ...assignment('bot-assignment', agent('bot')),
          ...binding('bot-binding', 'bot-assignment', 'scope-a', 'agent'),
          ...userCell,
          ...agentCell,
          ...cell('agent-approve', 'pay', 'bot-binding', 'approve_all_grant'),
          ...cell('user-export', 'export', 'alice-binding'),
        ]);
        const decide = (capabilityId: string, connection: ReadonlySet<string>) =>
          agentUse(graph, capabilityId, connection);
        const connection = new Set(['pay', 'export']);
        expect(yield* decide('pay', connection)).toEqual([true, true, true]);
        expect(yield* decide('pay', new Set(['export']))).toEqual([true, true, false]);
        // The user's own cell never flows to the agent, and the agent profile never to the user.
        expect(yield* decide('export', connection)).toEqual([true, false, true]);
        yield* remove(userCell);
        expect(yield* decide('pay', connection)).toEqual([false, true, true]);
        yield* touch(userCell);
        yield* remove(agentCell);
        expect(yield* decide('pay', connection)).toEqual([true, false, true]);
        yield* touch(agentCell);
        // Agents can never approve or administer, even with an approval cell in their binding.
        expect(yield* check('access_capability', 'pay', 'approve_all', agent('bot'))).toBe(NO);
        expect(yield* check('access_capability', 'pay', 'configure', agent('bot'))).toBe(NO);
        expect(yield* check('access_scope', 'scope-a', 'administer', agent('bot'))).toBe(NO);
        // Removing the agent stops it at once; an elapsed agent end date stops it as well.
        yield* remove([tuple('access_tenant', 'tenant', 'member', agent('bot'))]);
        expect(yield* decide('pay', connection)).toEqual([true, false, true]);
        yield* touch([tuple('access_tenant', 'tenant', 'member', agent('bot'))]);
        expect(yield* decide('pay', connection)).toEqual([true, true, true]);
        yield* touch([
          tuple('access_assignment', 'bot-assignment', 'agent_holder', agent('bot'), {
            expiresAtMs: ELAPSED_MS,
          }),
        ]);
        expect(yield* decide('pay', connection)).toEqual([true, false, true]);
      }),
    ),
  );

  suite.effect('accepts only a verified human or an agent, never the legacy principal kind', () =>
    withGraph(({ check, touch, tuple }) =>
      Effect.gen(function* v2SubjectTypes() {
        // A human-only v2 relation refuses an agent and every other principal kind (O46).
        for (const relation of ['owner', 'access_admin'] as const) {
          const [resourceType, resourceId] =
            relation === 'owner'
              ? (['access_tenant', 'tenant'] as const)
              : (['access_legal_entity', 'entity-a'] as const);
          for (const subject of [agent('bot'), legacyPrincipal('alice'), legacyPrincipal('workload')]) {
            expectRejectedSubject(
              yield* rejectionOf(touch([tuple(resourceType, resourceId, relation, subject)])),
              subject.type,
              `${relation} ${subject.type}`,
            );
          }
        }
        for (const [resourceType, resourceId, relation] of [
          ['access_assignment', 'alice-assignment', 'holder'],
          ['access_delegation', 'crm', 'manager'],
          ['access_team', 'sales', 'member'],
          ['access_record', 'invoice', 'creator'],
          ['access_tenant', 'tenant', 'suspended'],
          ['access_mandate', 'mandate', 'executor'],
        ] as const) {
          const rejection = yield* rejectionOf(
            touch([tuple(resourceType, resourceId, relation, legacyPrincipal('alice'))]),
          );
          expectRejectedSubject(rejection, 'principal', relation);
        }
        // The types are disjoint in both directions: a legacy relation never takes an access_human.
        for (const [resourceType, resourceId, relation] of [
          ['tenant', 'tenant', 'member'],
          ['legal_entity', 'entity-a', 'member'],
          ['action', 'direct-action', 'executor'],
        ] as const) {
          const rejection = yield* rejectionOf(touch([tuple(resourceType, resourceId, relation, human('alice'))]));
          expectRejectedSubject(rejection, 'access_human', relation);
        }
        // Agents still reach the relations that name them, and only those.
        yield* touch([
          tuple('access_team', 'sales-agent', 'scope', { id: 'scope-a', type: 'access_scope' }),
          tuple('access_team', 'sales-agent', 'member', agent('bot')),
        ]);
        expect(yield* check('access_team', 'sales-agent', 'eligible', agent('bot'))).toBe(HAS);
        expect(yield* check('access_team', 'sales-agent', 'eligible', human('alice'))).toBe(NO);
      }),
    ),
  );

  suite.effect('lapses a mandate with the approver assignment incarnation and never revives it', () =>
    withGraph(({ assignment, binding, bindingMember, cell, check, remove, touch, tuple }) =>
      Effect.gen(function* mandateIncarnation() {
        const executor = (expiresAtMs: number) =>
          tuple('access_mandate', 'mandate', 'executor', human('approver'), { expiresAtMs });
        yield* touch([
          ...assignment('approver-original', human('approver')),
          ...assignment('backup-assignment', human('backup')),
          ...binding('manager-binding', 'approver-original'),
          bindingMember('manager-binding', 'backup-assignment'),
          ...cell('manager-pay', 'pay', 'manager-binding'),
          ...cell('manager-approve', 'pay', 'manager-binding', 'approve_all_grant'),
          tuple('access_mandate', 'mandate', 'scope', { id: 'scope-a', type: 'access_scope' }),
          executor(FUTURE_MS),
          tuple('access_mandate', 'mandate', 'execution_assignment', {
            id: 'approver-original',
            type: 'access_assignment',
          }),
          tuple('access_mandate', 'mandate', 'approval_assignment', {
            id: 'approver-original',
            type: 'access_assignment',
          }),
          tuple('access_mandate', 'mandate', 'execution_grant', { id: 'manager-pay', type: 'access_grant' }),
          tuple('access_mandate', 'mandate', 'approval_grant', { id: 'manager-approve', type: 'access_grant' }),
        ]);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(HAS);
        expect(yield* check('access_mandate', 'mandate', 'live', human('backup'))).toBe(NO);
        // The approval window (P10) is the executor end date.
        yield* touch([executor(ELAPSED_MS)]);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(NO);
        yield* touch([executor(FUTURE_MS)]);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(HAS);

        // The approver loses the role: the original incarnation goes, a shared member keeps the binding live.
        yield* remove([tuple('access_assignment', 'approver-original', 'holder', human('approver'))]);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(NO);
        expect(yield* check('access_capability', 'pay', 'approve_all', human('backup'))).toBe(HAS);
        // Reassignment creates a new incarnation; it restores the right but not the mandate.
        yield* touch([
          ...assignment('approver-again', human('approver')),
          bindingMember('manager-binding', 'approver-again'),
        ]);
        expect(yield* check('access_capability', 'pay', 'approve_all', human('approver'))).toBe(HAS);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(NO);
      }),
    ),
  );

  suite.effect('needs Core to delete the executor so that recoverable paths never revive a mandate', () =>
    withGraph(({ assignment, binding, cell, check, remove, touch, tuple }) =>
      Effect.gen(function* mandateRevocation() {
        const executor = tuple('access_mandate', 'mandate', 'executor', human('approver'), {
          expiresAtMs: FUTURE_MS,
        });
        const installation = tuple('access_installation', 'install-a', 'enabled_scope', {
          id: 'scope-a',
          type: 'access_scope',
        });
        yield* touch([
          ...assignment('approver-assignment', human('approver')),
          ...binding('approver-binding', 'approver-assignment'),
          ...cell('approver-pay', 'pay', 'approver-binding'),
          ...cell('approver-approve', 'pay', 'approver-binding', 'approve_all_grant'),
          tuple('access_mandate', 'mandate', 'scope', { id: 'scope-a', type: 'access_scope' }),
          executor,
          tuple('access_mandate', 'mandate', 'execution_assignment', {
            id: 'approver-assignment',
            type: 'access_assignment',
          }),
          tuple('access_mandate', 'mandate', 'approval_assignment', {
            id: 'approver-assignment',
            type: 'access_assignment',
          }),
          tuple('access_mandate', 'mandate', 'execution_grant', { id: 'approver-pay', type: 'access_grant' }),
          tuple('access_mandate', 'mandate', 'approval_grant', { id: 'approver-approve', type: 'access_grant' }),
        ]);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(HAS);
        yield* remove([installation]);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(NO);
        // The graph alone revives the mandate on reinstall, so Core's revocation deletes executor.
        yield* touch([installation]);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(HAS);
        yield* remove([installation, executor]);
        yield* touch([installation]);
        expect(yield* check('access_capability', 'pay', 'approve_all', human('approver'))).toBe(HAS);
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(NO);
      }),
    ),
  );

  suite.effect('cannot relate an approval assignment to its grant, so Core must prove the binding witness', () =>
    withGraph(({ assignment, binding, bindingMember, cell, check, touch, tuple }) =>
      Effect.gen(function* mandateCorrelation() {
        /** Live approver witness of the binding membership relation, for one exact incarnation. */
        const bindingHas = (bindingId: string, assignmentId: string) =>
          check('access_role_binding', bindingId, 'member', {
            id: assignmentId,
            relation: 'holder',
            type: 'access_assignment',
          });
        const mandate = (approvalAssignmentId: string) => [
          tuple('access_mandate', 'mandate', 'scope', { id: 'scope-a', type: 'access_scope' }),
          tuple('access_mandate', 'mandate', 'executor', human('approver'), { expiresAtMs: FUTURE_MS }),
          tuple('access_mandate', 'mandate', 'execution_assignment', {
            id: 'approver-original',
            type: 'access_assignment',
          }),
          tuple('access_mandate', 'mandate', 'approval_assignment', {
            id: approvalAssignmentId,
            type: 'access_assignment',
          }),
          tuple('access_mandate', 'mandate', 'execution_grant', { id: 'manager-pay', type: 'access_grant' }),
          tuple('access_mandate', 'mandate', 'approval_grant', { id: 'manager-approve', type: 'access_grant' }),
        ];
        yield* touch([
          ...assignment('approver-original', human('approver')),
          // A second incarnation of the same person, in the same scope, outside the approval binding.
          ...assignment('approver-alias', human('approver')),
          ...binding('manager-binding', 'approver-original'),
          bindingMember('manager-binding', 'approver-alias'),
          ...cell('manager-pay', 'pay', 'manager-binding'),
          ...cell('manager-approve', 'pay', 'manager-binding', 'approve_all_grant'),
        ]);
        // The correlation Core checks is expressible: the binding names this exact incarnation only.
        expect(yield* bindingHas('manager-binding', 'approver-original')).toBe(HAS);
        expect(yield* bindingHas('manager-binding', 'approver-alias')).toBe(HAS);
        yield* touch([
          ...assignment('approver-outsider', human('approver')),
          ...binding('other-binding', 'approver-outsider'),
        ]);
        expect(yield* bindingHas('other-binding', 'approver-outsider')).toBe(HAS);
        expect(yield* bindingHas('manager-binding', 'approver-outsider')).toBe(NO);

        yield* touch(mandate('approver-original'));
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(HAS);
        // The alias hole (O49): a permission cannot compare two relation targets, so an
        // approval_assignment outside the binding is still live because the same person holds one
        // inside it. Core must deny on the binding witness in the same CheckBulk snapshot.
        yield* touch(mandate('approver-alias'));
        expect(yield* check('access_mandate', 'mandate', 'live', human('approver'))).toBe(HAS);
        expect(yield* bindingHas('manager-binding', 'approver-alias')).toBe(HAS);
        yield* touch(mandate('approver-outsider'));
        expect(yield* bindingHas('manager-binding', 'approver-outsider')).toBe(NO);
      }),
    ),
  );

  suite.effect('bounds a delegation to its exact capabilities, live scope and end date, and never to execution', () =>
    withGraph(({ capability, cell, check, remove, touch, tuple }) =>
      Effect.gen(function* delegationEnvelope() {
        const manager = (expiresAtMs?: number) =>
          tuple(
            'access_delegation',
            'crm',
            'manager',
            human('delegate'),
            expiresAtMs === undefined ? {} : { expiresAtMs },
          );
        yield* touch([
          ...capability('crm-note'),
          ...capability('finance-void'),
          tuple('access_delegation', 'crm', 'scope', { id: 'scope-a', type: 'access_scope' }),
          manager(),
          tuple('access_capability', 'crm-note', 'delegated_manager', { id: 'crm', type: 'access_delegation' }),
          ...cell('alice-note', 'crm-note', 'alice-binding'),
        ]);
        expect(yield* check('access_capability', 'crm-note', 'configure', human('delegate'))).toBe(HAS);
        expect(yield* check('access_capability', 'finance-void', 'configure', human('delegate'))).toBe(NO);
        expect(yield* check('access_capability', 'pay-b', 'configure', human('delegate'))).toBe(NO);
        expect(yield* check('access_scope', 'scope-a', 'administer', human('delegate'))).toBe(NO);
        for (const permission of CAPABILITY_PERMISSIONS) {
          expect(yield* check('access_capability', 'crm-note', permission, human('delegate')), permission).toBe(NO);
        }
        expect(yield* check('access_capability', 'crm-note', 'run_all', human('alice'))).toBe(HAS);
        // An elapsed end date, a revocation, or leaving the Legal Entity each end the delegation.
        yield* touch([manager(ELAPSED_MS)]);
        expect(yield* check('access_capability', 'crm-note', 'configure', human('delegate'))).toBe(NO);
        yield* touch([manager(FUTURE_MS)]);
        expect(yield* check('access_capability', 'crm-note', 'configure', human('delegate'))).toBe(HAS);
        yield* remove([manager()]);
        expect(yield* check('access_capability', 'crm-note', 'configure', human('delegate'))).toBe(NO);
        yield* touch([manager()]);
        yield* remove([tuple('access_legal_entity', 'entity-a', 'member', human('delegate'))]);
        expect(yield* check('access_capability', 'crm-note', 'configure', human('delegate'))).toBe(NO);
      }),
    ),
  );

  suite.effect('evaluates amount ceilings and target sets per cell, never combining two cells', () =>
    withGraph(({ cell, check, touch }) =>
      Effect.gen(function* caveatedCells() {
        yield* touch(
          cell('limited', 'pay', 'alice-binding', 'run_all_grant', {
            context: v1.createStructFromObject({ limit_currency: 'CZK', limit_minor: 10_000_000 }),
            name: 'amount_ceiling',
          }),
        );
        expect(yield* check('access_capability', 'pay', 'run_all', human('alice'))).toBe(CONDITIONAL);
        for (const [amount, currency, expected] of [
          [0, 'CZK', HAS],
          [10_000_000, 'CZK', HAS],
          [10_000_001, 'CZK', NO],
          [-1, 'CZK', NO],
          [1, 'EUR', NO],
        ] as const) {
          expect(
            yield* check('access_capability', 'pay', 'run_all', human('alice'), { amount_minor: amount, currency }),
            `${amount} ${currency}`,
          ).toBe(expected);
        }

        yield* touch(
          cell('targets', 'pay', 'alice-binding', 'run_assigned_grant', {
            context: v1.createStructFromObject({ resource_keys: ['invoice-a'] }),
            name: 'target_set',
          }),
        );
        expect(
          yield* check('access_capability', 'pay', 'run_assigned', human('alice'), { resource_key: 'invoice-a' }),
        ).toBe(HAS);
        expect(
          yield* check('access_capability', 'pay', 'run_assigned', human('alice'), { resource_key: 'invoice-b' }),
        ).toBe(NO);

        // A small limit on invoice A and a large one on invoice B never make a large limit on A.
        for (const [id, target, limit] of [
          ['small', 'invoice-a', 100],
          ['large', 'invoice-b', 10_000],
        ] as const) {
          yield* touch(
            cell(id, 'pay', 'alice-binding', 'run_team_grant', {
              context: v1.createStructFromObject({
                limit_currency: 'CZK',
                limit_minor: limit,
                resource_keys: [target],
              }),
              name: 'bounded_target_set',
            }),
          );
        }
        for (const [target, amount, expected] of [
          ['invoice-a', 100, HAS],
          ['invoice-a', 101, NO],
          ['invoice-b', 10_000, HAS],
          ['invoice-b', 10_001, NO],
          ['invoice-c', 1, NO],
        ] as const) {
          expect(
            yield* check('access_capability', 'pay', 'run_team', human('alice'), {
              amount_minor: amount,
              currency: 'CZK',
              resource_key: target,
            }),
            `${target} ${amount}`,
          ).toBe(expected);
        }
      }),
    ),
  );

  suite.effect('stops every use on uninstall, keeps configuration, and never resurrects a revoked cell', () =>
    withGraph(({ cell, check, remove, touch, tuple }) =>
      Effect.gen(function* uninstall() {
        const installation = tuple('access_installation', 'install-a', 'enabled_scope', {
          id: 'scope-a',
          type: 'access_scope',
        });
        const revoked = cell('alice-propose', 'pay', 'alice-binding', 'propose_all_grant');
        yield* touch([...cell('alice-pay', 'pay', 'alice-binding'), ...revoked]);
        expect(yield* check('access_capability', 'pay', 'run_all', human('alice'))).toBe(HAS);
        expect(yield* check('access_capability', 'pay', 'propose_all', human('alice'))).toBe(HAS);

        yield* remove([installation]);
        for (const permission of CAPABILITY_PERMISSIONS) {
          expect(yield* check('access_capability', 'pay', permission, human('alice')), permission).toBe(NO);
        }
        expect(yield* check('access_grant', 'alice-pay', 'use', human('alice'))).toBe(NO);
        expect(yield* check('access_capability', 'pay', 'configure', human('owner'))).toBe(HAS);
        expect(yield* check('access_capability', 'pay', 'configure', human('admin'))).toBe(HAS);

        // Revoked while uninstalled; a reinstall restores the current cells only.
        yield* remove(revoked);
        yield* touch([installation]);
        expect(yield* check('access_capability', 'pay', 'run_all', human('alice'))).toBe(HAS);
        expect(yield* check('access_capability', 'pay', 'propose_all', human('alice'))).toBe(NO);
      }),
    ),
  );

  suite.effect('matches record predicates only inside the live scope and never grants a capability', () =>
    withGraph(({ check, touch, tuple }) =>
      Effect.gen(function* recordPredicates() {
        yield* touch([
          tuple('access_team', 'sales', 'scope', { id: 'scope-a', type: 'access_scope' }),
          tuple('access_team', 'sales', 'member', human('alice')),
          tuple('access_team', 'sales', 'member', human('bob')),
          tuple('access_record', 'invoice', 'projection', { id: 'invoices', type: 'access_projection' }),
          tuple('access_record', 'invoice', 'scope', { id: 'scope-a', type: 'access_scope' }),
          ...['alice', 'bob'].flatMap((id) => [
            tuple('access_record', 'invoice', 'assigned', human(id)),
            tuple('access_record', 'invoice', 'entrusted', human(id)),
          ]),
          tuple('access_record', 'invoice', 'team', { id: 'sales', type: 'access_team' }),
          tuple('access_record', 'invoice', 'creator', human('owner')),
        ]);
        for (const permission of ['assigned_match', 'entrusted_match', 'team_match']) {
          expect(yield* check('access_record', 'invoice', permission, human('alice')), permission).toBe(HAS);
          // Bob is linked to the record but is no member of Legal Entity A.
          expect(yield* check('access_record', 'invoice', permission, human('bob')), permission).toBe(NO);
          expect(yield* check('access_record', 'invoice', permission, human('owner')), permission).toBe(NO);
        }
        expect(yield* check('access_capability', 'pay', 'run_assigned', human('alice'))).toBe(NO);
        yield* touch([tuple('access_legal_entity', 'entity-a', 'suspended', human('alice'))]);
        expect(yield* check('access_record', 'invoice', 'assigned_match', human('alice'))).toBe(NO);
      }),
    ),
  );
});
