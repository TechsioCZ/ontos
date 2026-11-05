import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { DateTime, Effect, Option, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  AccessTeamId,
  ActorContextInput,
  AuthorityCell,
  DecisionAuthorityPort,
  ResolvedAgentConnection,
} from '../../src/access/decision/authority.ts';
import { AccessTeamIdSchema } from '../../src/access/decision/authority.ts';
import type {
  AccessDecision,
  AccessDecisionRequest,
  AccessRecordTarget,
  DecisionCapabilityPolicy,
} from '../../src/access/decision/contract.ts';
import { decideAccess, resolveListAccess } from '../../src/access/decision/engine.ts';
import type { DecisionCheckPort } from '../../src/access/decision/engine.ts';
import { evaluateListAccessPredicate } from '../../src/access/decision/list-access.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { holderIdOf } from '../../src/access/decision/selector.ts';
import { makeSpiceDbDecisionCheckPort } from '../../src/access/decision/spicedb-check-port.ts';
import type { AccessProjectionIntent, ScopeProjectionIntent } from '../../src/access/compiler/intent.ts';
import { capabilityObjectId, recordObjectId, scopeObjectId } from '../../src/access/compiler/object-id.ts';
import { planAccessProjection } from '../../src/access/compiler/plan.ts';
import type { AccessProjectionError } from '../../src/access/compiler/projection-error.ts';
import type { ProjectionFenceAssertion } from '../../src/access/compiler/spice-db-compiler.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import type { AccessScopeId, LegalEntityId } from '../../src/access/ids.ts';
import { GrantIncarnationIdSchema, RecordKeySchema } from '../../src/access/ids.ts';
import type { Assignment, Cell, Holder, RoleRevision } from '../../src/access/model.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { openSpiceDbGrpcRpc, newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import {
  ADMIN,
  AGENT,
  ALICE,
  AT,
  BOB,
  CAP_MARGINS,
  CAP_NOTE,
  CAP_PAY,
  CONNECTION,
  MODULE,
  OTHER_MODULE,
  UNTIL,
  accessScopeId,
  agentHolder,
  assignmentIncarnationId,
  catalogEntries,
  catalogSnapshotId,
  cell,
  ceiling,
  declaredPrincipal,
  delegationId,
  human,
  installation,
  legalEntityId,
  roleId,
  roleRevisionId,
  targetsSelector,
  tenantId,
} from '../unit/access-compiler-fixtures.ts';

const PERMISSIONSHIP = v1.CheckPermissionResponse_Permissionship;
const fullyConsistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
const HUMAN = 'access_human';
const AGENT_SUBJECT = 'agent';
const RPC_TIMEOUT_MS = 5000;

/*
 * End to end (M6): the real compiler projects intent into SpiceDB and the real decision engine
 * answers against that same projection through the real transport. No managed tuple is written by
 * hand here, so this suite fails as soon as the engine and the compiler name a different object,
 * slot, assignment incarnation, binding or caveat.
 *
 * The one thing Core does not project yet is a business record: `access_record` and `access_team`
 * belong to the owning module's record projection, so the suite writes those relations itself — at
 * exactly the object names `recordObjectId` defines (H3) — and removes them again.
 *
 * The suite owns its own tenant, legal entities, scope, roles and incarnations (the 5xx block of the
 * fixture id space), so it can run beside the other SpiceDB suites that share this container.
 */

const TENANT = tenantId(501);
const ENTITY = legalEntityId(502);
const OTHER_ENTITY = legalEntityId(503);
const SCOPE = accessScopeId(504);
const OTHER_SCOPE = accessScopeId(505);
const ROLE = roleId(530);
const REVISION = roleRevisionId(531);
const NEXT_REVISION = roleRevisionId(532);
const AGENT_ROLE = roleId(533);
const ASSIGNMENT = assignmentIncarnationId(540);
const AGENT_ASSIGNMENT = assignmentIncarnationId(541);
const DELEGATION = delegationId(550);
const SNAPSHOT = catalogSnapshotId(570);

const RECORDS = { mine: 'record-mine', other: 'record-other', unowned: 'record-unowned' } as const;
const TEAM_ID: AccessTeamId = AccessTeamIdSchema.make('00000000-0000-4000-9000-000000000110');
const TEAM_OBJECT = '00000000-0000-4000-9000-000000000110';
const RECORD_MODULE = MODULE;

const later = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));
const now = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T12:00:00Z'));
const heldFence: ProjectionFenceAssertion = () => Effect.void;

const ref = (objectType: string, objectId: string): v1.ObjectReference =>
  v1.ObjectReference.create({ objectId, objectType });
const recordTarget = (key: string): AccessRecordTarget => ({
  moduleKey: RECORD_MODULE,
  recordKey: RecordKeySchema.make(key),
});
const recordObject = (key: string): string => recordObjectId(TENANT, SCOPE, RECORD_MODULE, key);

const policy = (overrides: Partial<DecisionCapabilityPolicy> = {}): DecisionCapabilityPolicy => ({
  capabilityKey: CAP_PAY,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  risk: 'routine',
  selectors: [],
  ...overrides,
});

/** The person's `all` cell for `pay` carries an amount ceiling, so every `pay` request names one. */
const payRequest = (minor = 500): AccessDecisionRequest => ({
  amount: { currency: 'CZK', minor },
  capability: policy(),
  mode: 'run',
});

const humanActor = (principal = ALICE): ActorContextInput => ({
  actor: { _tag: 'Principal', principalId: principal },
  legalEntityId: ENTITY,
  tenantId: TENANT,
});
const agentActor = (): ActorContextInput => ({
  actor: { _tag: 'Agent', agentId: AGENT, connectionId: CONNECTION, consentRevision: 1, principalId: ALICE },
  legalEntityId: ENTITY,
  tenantId: TENANT,
});

/** The consent the agent acts through: this agent, this person, this scope (H2). */
const connection = (): ResolvedAgentConnection => ({
  agentId: AGENT,
  ceiling: {
    cells: [
      { capabilityKey: CAP_PAY, mode: 'run', selector: { _tag: 'all' } },
      { capabilityKey: CAP_NOTE, mode: 'run', selector: { _tag: 'all' } },
    ],
  },
  connectionId: CONNECTION,
  consentRevision: 1,
  deadline: later,
  principalId: ALICE,
  scopeId: SCOPE,
  status: 'active',
});

const roleRevision = (overrides: Partial<RoleRevision> = {}): RoleRevision => ({
  catalogSnapshotId: SNAPSHOT,
  cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' })],
  createdAt: AT,
  createdBy: ADMIN,
  id: REVISION,
  provenance: 'manual',
  revision: 1,
  roleId: ROLE,
  tenantId: TENANT,
  ...overrides,
});

const assignmentOf = (overrides: Partial<Assignment> = {}): Assignment => ({
  assignedAt: AT,
  assignedBy: ADMIN,
  holder: human(ALICE),
  incarnationId: ASSIGNMENT,
  roleId: ROLE,
  roleRevisionId: REVISION,
  scopeId: SCOPE,
  status: 'active',
  tenantId: TENANT,
  validFrom: AT,
  ...overrides,
});

let grantSequence = 200;
const nextGrantIncarnation = () => {
  grantSequence += 1;
  return GrantIncarnationIdSchema.make(`00000000-0000-4000-8000-${grantSequence.toString().padStart(12, '0')}`);
};

/**
 * What Core's intent reader returns: one authority cell per active assignment x pinned role cell.
 * The engine never reads SpiceDB intent directly; the graph is what the compiler projected from it.
 */
const authorityCellsOf = (scope: ScopeProjectionIntent): readonly AuthorityCell[] => {
  const cells: AuthorityCell[] = [];
  for (const assigned of scope.assignments) {
    if (assigned.status !== 'active') {
      continue;
    }
    const pinned = scope.roleRevisions.find(
      (candidate) => candidate.roleId === assigned.roleId && candidate.id === assigned.roleRevisionId,
    );
    for (const pinnedCell of pinned?.cells ?? []) {
      cells.push(
        withOptional(
          withOptional(
            {
              assignedAt: assigned.assignedAt,
              assignedBy: assigned.assignedBy,
              assignmentIncarnationId: assigned.incarnationId,
              capabilityKey: pinnedCell.capabilityKey,
              deadline: assigned.validUntil ?? UNTIL,
              grantIncarnationId: nextGrantIncarnation(),
              holder: assigned.holder,
              mode: pinnedCell.mode,
              roleId: assigned.roleId,
              roleRevisionId: assigned.roleRevisionId,
              selector: pinnedCell.selector,
            },
            'amountCeiling',
            pinnedCell.amountCeiling,
          ),
          'deadline',
          assigned.validUntil,
        ),
      );
    }
  }
  return cells;
};

const sameHolder = (left: Holder, right: Holder): boolean => holderIdOf(left) === holderIdOf(right);

const authorityPortOf = (params: {
  readonly cells: readonly AuthorityCell[];
  readonly entity: LegalEntityId;
  readonly scopeId: AccessScopeId;
}): DecisionAuthorityPort => ({
  readCells: (query) =>
    Effect.succeed(
      params.cells.filter(
        (candidate) =>
          sameHolder(candidate.holder, query.holder) &&
          candidate.capabilityKey === query.capabilityKey &&
          candidate.mode === query.mode,
      ),
    ),
  readConnection: () => Effect.succeed(Option.some(connection())),
  readScope: () =>
    Effect.succeed(
      Option.some({
        deadlines: [{ source: 'membership' as const, until: later }],
        holderDeadlines: [human(ALICE), agentHolder(AGENT)].map((holder) => ({
          deadlines: [{ source: 'membership' as const, until: later }],
          holder,
        })),
        scope: { _tag: 'LegalEntity' as const, legalEntityId: params.entity, tenantId: TENANT },
        scopeId: params.scopeId,
        tenantId: TENANT,
      }),
    ),
  readTeamIds: () => Effect.succeed([TEAM_ID]),
});

/** The person's role covers every selector; the agent's role holds one assigned cell of `pay`. */
const scopeWithCells = (overrides: Partial<ScopeProjectionIntent> = {}): ScopeProjectionIntent => ({
  assignments: [
    assignmentOf(),
    assignmentOf({
      holder: agentHolder(AGENT),
      incarnationId: AGENT_ASSIGNMENT,
      roleId: AGENT_ROLE,
      roleRevisionId: NEXT_REVISION,
    }),
  ],
  connections: [],
  delegations: [],
  installations: [installation(MODULE), installation(OTHER_MODULE)],
  roleRevisions: [
    roleRevision({
      cells: [
        cell({ amountCeiling: ceiling(1000), capabilityKey: CAP_PAY, mode: 'run' }),
        cell({ capabilityKey: CAP_NOTE, mode: 'run', selector: { _tag: 'assigned' } }),
        cell({ capabilityKey: CAP_NOTE, mode: 'run', selector: { _tag: 'entrusted' } }),
        cell({ capabilityKey: CAP_NOTE, mode: 'run', selector: { _tag: 'team' } }),
        cell({ capabilityKey: CAP_MARGINS, mode: 'run', selector: targetsSelector([RECORDS.mine]) }),
      ],
    }),
    roleRevision({
      cells: [cell({ capabilityKey: CAP_PAY, mode: 'run', selector: { _tag: 'assigned' } })],
      id: NEXT_REVISION,
      roleId: AGENT_ROLE,
    }),
  ],
  scope: { id: SCOPE, scope: { _tag: 'LegalEntity', legalEntityId: ENTITY, tenantId: TENANT } },
  ...overrides,
});

/**
 * The agent is a member of the tenant and of the legal entity, exactly like the person it acts for:
 * the schema's `access_assignment.eligible = agent_holder & scope->access`, so an agent outside the
 * scope can hold no eligible assignment (D22).
 */
const intentOf = (scope: Partial<ScopeProjectionIntent> = {}): AccessProjectionIntent => ({
  tenants: [
    {
      catalogEntries: catalogEntries(),
      coverage: 'complete',
      legalEntities: [
        {
          accessAdmins: [ADMIN],
          legalEntityId: ENTITY,
          members: [{ holder: human(ALICE) }, { holder: human(BOB) }, { holder: agentHolder(AGENT) }],
          suspended: [],
        },
      ],
      members: [
        { holder: human(ADMIN) },
        { holder: human(ALICE) },
        { holder: human(BOB) },
        { holder: agentHolder(AGENT) },
      ],
      owners: [ADMIN],
      principals: [
        declaredPrincipal(ADMIN),
        declaredPrincipal(ALICE),
        declaredPrincipal(BOB),
        declaredPrincipal(AGENT, 'agent'),
      ],
      scopes: [scopeWithCells(scope)],
      suspended: [],
      tenantId: TENANT,
    },
  ],
});

/** The same tenant with no facts: reconciling it deletes every managed tuple of these units. */
const emptyIntent = (intent: AccessProjectionIntent): AccessProjectionIntent => ({
  tenants: intent.tenants.map((tenant) => ({
    ...tenant,
    legalEntities: tenant.legalEntities.map((entity) => ({ ...entity, accessAdmins: [], members: [], suspended: [] })),
    members: [],
    owners: [],
    scopes: tenant.scopes.map((scope) =>
      scopeWithCells({
        assignments: [],
        delegations: [],
        installations: [],
        roleRevisions: [],
        scope: scope.scope,
      }),
    ),
    suspended: [],
  })),
});

/** A delegated assignment frozen to `pay` only, so a role edit is the only way it could grow. */
const delegatedIntent = (roleCells: readonly Cell[]): AccessProjectionIntent =>
  intentOf({
    assignments: [
      assignmentOf({
        delegated: { capabilityKeys: [CAP_PAY], delegationId: DELEGATION, until: UNTIL },
        validUntil: UNTIL,
      }),
    ],
    delegations: [
      {
        capabilityKeys: [CAP_PAY],
        grantedBy: ADMIN,
        id: DELEGATION,
        managerId: BOB,
        people: [ALICE],
        roleIds: [ROLE],
        scopeId: SCOPE,
        status: 'active',
        tenantId: TENANT,
        validFrom: AT,
        validUntil: UNTIL,
      },
    ],
    roleRevisions: [roleRevision({ cells: [...roleCells] })],
  });

type GraphPermissionship = v1.CheckPermissionResponse_Permissionship;

interface CompileReport {
  readonly deletions: number;
  readonly touches: number;
  readonly verified: boolean;
}

interface SuiteContext {
  /** The same cells read for another scope, to prove the graph does not answer for them. */
  readonly authorityFor: (params: {
    readonly cells: readonly AuthorityCell[];
    readonly entity: LegalEntityId;
    readonly scopeId: AccessScopeId;
  }) => DecisionAuthorityPort;
  readonly check: DecisionCheckPort;
  readonly compile: (intent: AccessProjectionIntent) => Effect.Effect<CompileReport, readonly AccessProjectionError[]>;
  readonly decide: (actor: ActorContextInput, request: AccessDecisionRequest) => Effect.Effect<AccessDecision>;
  readonly graphCheck: (
    resourceType: string,
    resourceId: string,
    permission: string,
    subjectId: string,
    subjectType?: string,
  ) => Effect.Effect<GraphPermissionship>;
}

const withSuite = <Value, Failure>(program: (context: SuiteContext) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* suiteHarness() {
    const configuration = yield* loadSpiceDbConfig();
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => newSpiceDbGrpcClient(configuration)),
      (current) => Effect.sync(() => current.close()),
    );
    const rpc = yield* Effect.acquireRelease(
      Effect.sync(() => openSpiceDbGrpcRpc(configuration, RPC_TIMEOUT_MS)),
      (current) => Effect.sync(() => current.close()),
    );
    yield* Effect.tryPromise(() =>
      client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
    );
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const intent = intentOf();
    const baseScope = intent.tenants[0]?.scopes[0] ?? scopeWithCells();

    const subjectRef = (objectId: string, objectType: string) =>
      v1.SubjectReference.create({ object: ref(objectType, objectId), optionalRelation: '' });
    const recordTuple = (key: string, relation: string, subjectId: string, subjectType: string): v1.Relationship =>
      v1.Relationship.create({
        relation,
        resource: ref('access_record', recordObject(key)),
        subject: subjectRef(subjectId, subjectType),
      });
    const recordTuples: readonly v1.Relationship[] = [
      // The owning modules' record projection, at the object names the compiler defines (H3).
      ...Object.values(RECORDS).map((key) =>
        v1.Relationship.create({
          relation: 'scope',
          resource: ref('access_record', recordObject(key)),
          subject: subjectRef(scopeObjectId(TENANT, SCOPE), 'access_scope'),
        }),
      ),
      recordTuple(RECORDS.mine, 'assigned', ALICE, HUMAN),
      recordTuple(RECORDS.mine, 'entrusted', ALICE, HUMAN),
      recordTuple(RECORDS.mine, 'assigned', AGENT, AGENT_SUBJECT),
      recordTuple(RECORDS.other, 'assigned', BOB, HUMAN),
      v1.Relationship.create({
        relation: 'team',
        resource: ref('access_record', recordObject(RECORDS.mine)),
        subject: subjectRef(TEAM_OBJECT, 'access_team'),
      }),
      v1.Relationship.create({
        relation: 'scope',
        resource: ref('access_team', TEAM_OBJECT),
        subject: subjectRef(scopeObjectId(TENANT, SCOPE), 'access_scope'),
      }),
      v1.Relationship.create({
        relation: 'member',
        resource: ref('access_team', TEAM_OBJECT),
        subject: subjectRef(ALICE, HUMAN),
      }),
    ];
    const deleteObject = (resourceType: string, resourceId: string) =>
      Effect.tryPromise(() =>
        client.promises.deleteRelationships(
          v1.DeleteRelationshipsRequest.create({
            relationshipFilter: v1.RelationshipFilter.create({ optionalResourceId: resourceId, resourceType }),
          }),
        ),
      );
    const clearRecords = Effect.forEach(
      [
        ...Object.values(RECORDS).map((key) => ['access_record', recordObject(key)] as const),
        ['access_team', TEAM_OBJECT] as const,
      ],
      ([resourceType, resourceId]) => deleteObject(resourceType, resourceId),
      { discard: true },
    ).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      compiler.reconcile(emptyIntent(intent), { fence: heldFence }).pipe(Effect.ignore, Effect.andThen(clearRecords)),
    );

    yield* Effect.tryPromise(() =>
      client.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: recordTuples.map((relationship) =>
            v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship }),
          ),
        }),
      ),
    );

    const check = makeSpiceDbDecisionCheckPort(rpc);
    const authority = authorityPortOf({ cells: authorityCellsOf(baseScope), entity: ENTITY, scopeId: SCOPE });
    const decide = (actor: ActorContextInput, request: AccessDecisionRequest) =>
      decideAccess(authority, check, { actor, now, request });
    const compile = (next: AccessProjectionIntent) =>
      compiler.reconcile(next, { fence: heldFence }).pipe(
        Effect.map((report): CompileReport => ({
          deletions: report.deletions,
          touches: report.touches,
          verified: report.verified,
        })),
      );
    const graphCheck = (
      resourceType: string,
      resourceId: string,
      permission: string,
      subjectId: string,
      subjectType: string = HUMAN,
    ): Effect.Effect<GraphPermissionship> =>
      Effect.tryPromise(() =>
        client.promises.checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: fullyConsistent,
            permission,
            resource: ref(resourceType, resourceId),
            subject: subjectRef(subjectId, subjectType),
          }),
        ),
      ).pipe(
        Effect.map((response) => response.permissionship),
        Effect.orDie,
      );
    return yield* program({ authorityFor: authorityPortOf, check, compile, decide, graphCheck });
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer, { excludeTestServices: true })('access compiler and decision engine together', (suite) => {
  suite.effect('projects intent and decides every selector on that same graph', () =>
    withSuite(({ compile, decide }) =>
      Effect.gen(function* everySelector() {
        const report = yield* compile(intentOf());
        expect(report.verified).toBe(true);
        expect(report.deletions).toBe(0);

        // `all`: the scope-wide cell needs no record, only the amount its ceiling bounds.
        expect((yield* decide(humanActor(), payRequest())).outcome).toBe('ALLOWED');

        // `assigned`: only the record assigned to the actor; never another owner and never a NULL one.
        const assigned = policy({ capabilityKey: CAP_NOTE, selectors: ['assigned'] });
        for (const [key, expected] of [
          [RECORDS.mine, 'ALLOWED'],
          [RECORDS.other, 'DENIED'],
          [RECORDS.unowned, 'DENIED'],
        ] as const) {
          const decision = yield* decide(humanActor(), {
            capability: assigned,
            mode: 'run',
            target: recordTarget(key),
          });
          expect(decision.outcome).toBe(expected);
        }

        // `entrusted`: the same record through the other relation.
        const entrusted = policy({ capabilityKey: CAP_NOTE, selectors: ['entrusted'] });
        expect(
          (yield* decide(humanActor(), {
            capability: entrusted,
            mode: 'run',
            target: recordTarget(RECORDS.mine),
          })).outcome,
        ).toBe('ALLOWED');
        expect(
          (yield* decide(humanActor(), {
            capability: entrusted,
            mode: 'run',
            target: recordTarget(RECORDS.other),
          })).outcome,
        ).toBe('DENIED');

        // `team`: the actor's team, proven through access_record#team -> access_team#member.
        const team = policy({ capabilityKey: CAP_NOTE, selectors: ['team'] });
        expect(
          (yield* decide(humanActor(), { capability: team, mode: 'run', target: recordTarget(RECORDS.mine) })).outcome,
        ).toBe('ALLOWED');
        expect(
          (yield* decide(humanActor(), { capability: team, mode: 'run', target: recordTarget(RECORDS.other) })).outcome,
        ).toBe('DENIED');

        // `targets`: the explicit set is a caveat on the grant binding the compiler wrote.
        const targets = policy({ capabilityKey: CAP_MARGINS, selectors: ['all'] });
        expect(
          (yield* decide(humanActor(), { capability: targets, mode: 'run', target: recordTarget(RECORDS.mine) }))
            .outcome,
        ).toBe('ALLOWED');
        expect(
          (yield* decide(humanActor(), { capability: targets, mode: 'run', target: recordTarget(RECORDS.other) }))
            .outcome,
        ).toBe('DENIED');
      }),
    ),
  );

  suite.effect('applies the amount ceiling and keeps a narrowed ceiling after the role edit', () =>
    withSuite(({ compile, decide }) =>
      Effect.gen(function* narrowedCeiling() {
        yield* compile(intentOf());
        expect((yield* decide(humanActor(), payRequest(1000))).outcome).toBe('ALLOWED');
        expect((yield* decide(humanActor(), payRequest(1001))).outcome).toBe('DENIED');

        // The narrowing is a content change of the same tuple: it must land and be verifiable (H4).
        const narrowed = intentOf({
          roleRevisions: [
            roleRevision({
              cells: [
                cell({ amountCeiling: ceiling(500), capabilityKey: CAP_PAY, mode: 'run' }),
                cell({ capabilityKey: CAP_NOTE, mode: 'run', selector: { _tag: 'assigned' } }),
                cell({ capabilityKey: CAP_NOTE, mode: 'run', selector: { _tag: 'entrusted' } }),
                cell({ capabilityKey: CAP_NOTE, mode: 'run', selector: { _tag: 'team' } }),
                cell({ capabilityKey: CAP_MARGINS, mode: 'run', selector: targetsSelector([RECORDS.mine]) }),
              ],
            }),
            roleRevision({
              cells: [cell({ capabilityKey: CAP_PAY, mode: 'run', selector: { _tag: 'assigned' } })],
              id: NEXT_REVISION,
              roleId: AGENT_ROLE,
            }),
          ],
        });
        const report = yield* compile(narrowed);
        expect(report.verified).toBe(true);
        expect((yield* decide(humanActor(), payRequest(400))).outcome).toBe('ALLOWED');
        expect((yield* decide(humanActor(), payRequest(600))).outcome).toBe('DENIED');
      }),
    ),
  );

  suite.effect('intersects the person, the agent and the connection on the projected graph', () =>
    withSuite(({ compile, decide }) =>
      Effect.gen(function* agentIntersection() {
        yield* compile(intentOf());
        const pay = policy({ selectors: ['all', 'assigned'] });
        // The person holds `all` and the agent holds `assigned`, so the record must also be assigned
        // to the agent (D22).
        const mine = yield* decide(agentActor(), {
          amount: { currency: 'CZK', minor: 500 },
          capability: pay,
          mode: 'run',
          target: recordTarget(RECORDS.mine),
        });
        expect(mine.outcome).toBe('ALLOWED');
        expect(mine.evidence.map(({ side }) => side).toSorted()).toEqual(['agent', 'principal']);
        expect(mine.selectors).toEqual([
          { selector: 'all', side: 'principal' },
          { selector: 'assigned', side: 'agent' },
        ]);
        expect(
          (yield* decide(agentActor(), {
            amount: { currency: 'CZK', minor: 500 },
            capability: pay,
            mode: 'run',
            target: recordTarget(RECORDS.other),
          })).outcome,
        ).toBe('DENIED');
      }),
    ),
  );

  suite.effect('stops every use on uninstall and restores it on reinstall', () =>
    withSuite(({ compile, decide }) =>
      Effect.gen(function* uninstall() {
        yield* compile(intentOf());
        expect((yield* decide(humanActor(), payRequest())).outcome).toBe('ALLOWED');

        const uninstalled = yield* compile(intentOf({ installations: [] }));
        expect(uninstalled.verified).toBe(true);
        expect((yield* decide(humanActor(), payRequest())).outcome).toBe('DENIED');

        yield* compile(intentOf());
        expect((yield* decide(humanActor(), payRequest())).outcome).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('keeps another legal entity out of reach of the same intent cells', () =>
    withSuite(({ authorityFor, check, compile, graphCheck }) =>
      Effect.gen(function* crossEntity() {
        yield* compile(intentOf());
        // The other legal entity has its own scope objects and no tuples for them.
        expect(
          yield* graphCheck('access_capability', capabilityObjectId(TENANT, OTHER_SCOPE, CAP_PAY), 'run_all', ALICE),
        ).toBe(PERMISSIONSHIP.NO_PERMISSION);
        const otherScope = scopeWithCells({
          scope: { id: OTHER_SCOPE, scope: { _tag: 'LegalEntity', legalEntityId: OTHER_ENTITY, tenantId: TENANT } },
        });
        const decision = yield* decideAccess(
          authorityFor({ cells: authorityCellsOf(otherScope), entity: OTHER_ENTITY, scopeId: OTHER_SCOPE }),
          check,
          {
            actor: {
              actor: { _tag: 'Principal', principalId: ALICE },
              legalEntityId: OTHER_ENTITY,
              tenantId: TENANT,
            },
            now,
            request: payRequest(),
          },
        );
        expect(decision.outcome).toBe('DENIED');
      }),
    ),
  );

  suite.effect('answers a list exactly as the per-record decisions do', () =>
    withSuite(({ authorityFor, check, compile, decide }) =>
      Effect.gen(function* listEqualsPerRecord() {
        yield* compile(intentOf());
        const authority = authorityFor({ cells: authorityCellsOf(scopeWithCells()), entity: ENTITY, scopeId: SCOPE });
        const assigned = policy({ capabilityKey: CAP_NOTE, selectors: ['assigned'] });
        const list = yield* resolveListAccess(authority, check, {
          actor: humanActor(),
          capability: assigned,
          mode: 'run',
          now,
        });
        expect(list.decision.outcome).toBe('ALLOWED');
        const rows = [
          { assigned: human(ALICE), recordKey: RecordKeySchema.make(RECORDS.mine), teamIds: [] },
          { assigned: human(BOB), recordKey: RecordKeySchema.make(RECORDS.other), teamIds: [] },
          { recordKey: RecordKeySchema.make(RECORDS.unowned), teamIds: [] },
        ];
        for (const row of rows) {
          const decision = yield* decide(humanActor(), {
            capability: assigned,
            mode: 'run',
            target: recordTarget(row.recordKey),
          });
          const listed = list.predicate !== undefined && evaluateListAccessPredicate(list.predicate, row);
          expect(listed).toBe(decision.outcome === 'ALLOWED');
        }
      }),
    ),
  );

  suite.effect('refuses a role edit that would grow a delegated assignment', () =>
    Effect.sync(() => {
      const contained = delegatedIntent([cell({ amountCeiling: ceiling(1000), capabilityKey: CAP_PAY, mode: 'run' })]);
      expect(Result.isSuccess(planAccessProjection(contained))).toBe(true);

      // The same frozen limits, but the role now also grants `add-note`. The planner refuses the
      // growth instead of clipping it, so no shared binding can hand the delegate more (H6, D10).
      const grown = delegatedIntent([
        cell({ amountCeiling: ceiling(1000), capabilityKey: CAP_PAY, mode: 'run' }),
        cell({ capabilityKey: CAP_NOTE, mode: 'run' }),
      ]);
      const refused = planAccessProjection(grown);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) {
        expect(refused.failure.map(({ code }) => code)).toContain('access_projection_delegation_containment');
      }
    }),
  );
});
