import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessTeamId, AuthorityCell, ResolvedAgentConnection } from '../../src/access/decision/authority.ts';
import type { DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import { decideAccess, decideAccessMany, resolveListAccess } from '../../src/access/decision/engine.ts';
import type { DecisionCheckPort } from '../../src/access/decision/engine.ts';
import { evaluateListAccessPredicate } from '../../src/access/decision/list-access.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { holderIdOf } from '../../src/access/decision/selector.ts';
import { makeSpiceDbDecisionCheckPort, toCheckBulkRequest } from '../../src/access/decision/spicedb-check-port.ts';
import {
  capabilityObjectId,
  grantObjectId,
  recordObjectId,
  installationObjectId,
  legalEntityObjectId,
  roleBindingObjectId,
  scopeObjectId,
  assignmentObjectId,
  tenantObjectId,
} from '../../src/access/compiler/object-id.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RecordKeySchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { AmountCeilingSchema } from '../../src/access/model.ts';
import type { AccessMode, AccessScope, CellSelector, Holder } from '../../src/access/model.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient, openSpiceDbGrpcRpc } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

const HAS = v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
const fullyConsistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });

const at = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
const later = at('2100-01-01T00:00:00Z');
const now = at('2026-11-03T12:00:00Z');

const scopeOf = (tenantId: string, legalEntityId: string): AccessScope => ({
  _tag: 'LegalEntity',
  legalEntityId: LegalEntityIdSchema.make(legalEntityId),
  tenantId: TenantIdSchema.make(tenantId),
});

const ref = (objectType: string, objectId: string) => v1.ObjectReference.create({ objectId, objectType });
const subjectRef = (subject: { readonly id: string; readonly relation?: string; readonly type: string }) =>
  v1.SubjectReference.create({
    object: ref(subject.type, subject.id),
    optionalRelation: subject.relation ?? '',
  });
const human = (id: string) => ({ id, type: 'access_human' });
const agent = (id: string) => ({ id, type: 'agent' });
const noTeams: readonly AccessTeamId[] = [];
const actionPolicy = (key: string): DecisionCapabilityPolicy => ({
  capabilityKey: CapabilityKeySchema.make(key),
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  risk: 'routine',
  selectors: [],
});
const countCalls = (port: DecisionCheckPort) => {
  const calls = { count: 0 };
  const counting: DecisionCheckPort = {
    checkBulk: (items) => {
      calls.count += 1;
      return port.checkBulk(items);
    },
  };
  return { calls, port: counting };
};

type SpiceDbClient = ReturnType<typeof newSpiceDbGrpcClient>;
/** One TOUCH update, so a whole projection write stays a single atomic request. */
const touchUpdate = (relationship: v1.Relationship) =>
  v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship });
const writeRelationships = (client: SpiceDbClient, relationships: readonly v1.Relationship[]) =>
  Effect.tryPromise(() =>
    client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({ updates: relationships.map(touchUpdate) }),
    ),
  );
const deleteResource = (client: SpiceDbClient, resource: v1.ObjectReference) =>
  Effect.tryPromise(() =>
    client.promises.deleteRelationships(
      v1.DeleteRelationshipsRequest.create({
        relationshipFilter: v1.RelationshipFilter.create({
          optionalResourceId: resource.objectId,
          resourceType: resource.objectType,
        }),
      }),
    ),
  );
/** The suite leaves SpiceDB as it found it, so the container stays shared with the other access suites. */
const clearTouched = (client: SpiceDbClient, resources: readonly v1.ObjectReference[]) =>
  Effect.forEach(resources, (resource) => deleteResource(client, resource), { concurrency: 4, discard: true }).pipe(
    Effect.orDie,
  );
const cellMatchesQuery =
  (query: { readonly capabilityKey: string; readonly holder: Holder; readonly mode: AccessMode }) =>
  (cell: AuthorityCell) =>
    holderIdOf(cell.holder) === holderIdOf(query.holder) &&
    cell.capabilityKey === query.capabilityKey &&
    cell.mode === query.mode;

it.layer(NodeServices.layer, { excludeTestServices: true })('access decision engine against SpiceDB', (suite) => {
  suite.effect('decides against a real SpiceDB projection with one bulk snapshot per decision', () =>
    Effect.gen(function* decidesAgainstRealSpiceDb() {
      const configuration = yield* loadSpiceDbConfig();
      const crypto = yield* Crypto.Crypto;
      const uuid = () => crypto.randomUUIDv4();
      const ids = yield* Effect.all({
        agentId: uuid(),
        alice: uuid(),
        aliceIncarnation: uuid(),
        bob: uuid(),
        botIncarnation: uuid(),
        capabilityKeys: Effect.succeed({
          amount: 'finance.invoice.pay',
          read: 'finance.invoice.read',
          target: 'finance.invoice.export',
          void: 'finance.invoice.void',
        }),
        connectionId: uuid(),
        entity: uuid(),
        grantIncarnation: uuid(),
        legalEntityId: uuid(),
        moduleKey: Effect.succeed('finance'),
        r1: uuid(),
        r2: uuid(),
        r3: uuid(),
        roleId: uuid(),
        roleRevisionId: uuid(),
        scopeId: uuid(),
        tenantId: uuid(),
      });
      // The record object is the compiler's projection of that record inside this scope and module.
      const recordObjectOf = (recordKey: string) => recordObjectId(ids.tenantId, ids.scopeId, ids.moduleKey, recordKey);
      const recordOf = (recordKey: string) => ({
        moduleKey: ModuleKeySchema.make(ids.moduleKey),
        recordKey: RecordKeySchema.make(recordKey),
      });
      const tenantObject = tenantObjectId(ids.tenantId);
      const entityObject = legalEntityObjectId(ids.tenantId, ids.legalEntityId);
      const scopeObject = scopeObjectId(ids.tenantId, ids.scopeId);
      const installationObject = installationObjectId(ids.tenantId, ids.scopeId, ids.moduleKey);
      const aliceAssignment = assignmentObjectId(ids.tenantId, ids.scopeId, ids.aliceIncarnation);
      const botAssignment = assignmentObjectId(ids.tenantId, ids.scopeId, ids.botIncarnation);
      const bindingObject = roleBindingObjectId(ids.tenantId, ids.scopeId, ids.roleId);
      const capabilityObject = (key: string) => capabilityObjectId(ids.tenantId, ids.scopeId, key);
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => newSpiceDbGrpcClient(configuration)),
        (current) => Effect.sync(() => current.close()),
      );
      const rpc = yield* Effect.acquireRelease(
        Effect.sync(() => openSpiceDbGrpcRpc(configuration, 5000)),
        (current) => Effect.sync(() => current.close()),
      );
      const touched = new Map<string, v1.ObjectReference>();
      const tuple = (
        resourceType: string,
        resourceId: string,
        relation: string,
        subject: { readonly id: string; readonly relation?: string; readonly type: string },
        caveat?: { readonly context: Record<string, number | string | string[]>; readonly name: string },
      ) => {
        const resource = ref(resourceType, resourceId);
        touched.set(`${resourceType}:${resourceId}`, resource);
        const relationship = v1.Relationship.create({ relation, resource, subject: subjectRef(subject) });
        if (caveat !== undefined) {
          relationship.optionalCaveat = v1.ContextualizedCaveat.create({
            caveatName: caveat.name,
            context: v1.createStructFromObject(caveat.context),
          });
        }
        return relationship;
      };
      const write = (relationships: readonly v1.Relationship[]) => writeRelationships(client, relationships);
      yield* Effect.addFinalizer(() => clearTouched(client, [...touched.values()]));
      yield* Effect.tryPromise(() =>
        client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      );

      const capability = (key: string) => [
        tuple('access_capability', capabilityObject(key), 'scope', { id: scopeObject, type: 'access_scope' }),
        tuple('access_capability', capabilityObject(key), 'installation', {
          id: installationObject,
          type: 'access_installation',
        }),
      ];
      const slot = (key: string, mode: AccessMode, slotName: string, grantId: string) =>
        tuple('access_capability', capabilityObject(key), `${mode}_${slotName}_grant`, {
          id: grantId,
          type: 'access_grant',
        });
      const grant = (
        grantId: string,
        key: string,
        caveat?: { readonly context: Record<string, number | string | string[]>; readonly name: string },
      ) => [
        tuple('access_grant', grantId, 'capability', { id: capabilityObject(key), type: 'access_capability' }),
        tuple('access_grant', grantId, 'binding', { id: bindingObject, type: 'access_role_binding' }, caveat),
      ];
      const grantIdFor = (key: string, mode: AccessMode, selector: CellSelector) =>
        grantObjectId(ids.tenantId, ids.scopeId, ids.roleId, {
          capabilityKey: CapabilityKeySchema.make(key),
          mode,
          selector,
        });

      const allGrant = grantIdFor(ids.capabilityKeys.void, 'run', { _tag: 'all' });
      const assignedGrant = grantIdFor(ids.capabilityKeys.void, 'run', { _tag: 'assigned' });
      const targetGrant = grantIdFor(ids.capabilityKeys.target, 'run', {
        _tag: 'targets',
        recordKeys: [RecordKeySchema.make(ids.r1)],
      });
      const amountGrant = grantIdFor(ids.capabilityKeys.amount, 'run', { _tag: 'all' });
      const readGrant = grantIdFor(ids.capabilityKeys.read, 'run', { _tag: 'all' });

      yield* write([
        tuple('access_tenant', tenantObject, 'member', human(ids.alice)),
        tuple('access_tenant', tenantObject, 'member', human(ids.bob)),
        tuple('access_tenant', tenantObject, 'member', agent(ids.agentId)),
        tuple('access_legal_entity', entityObject, 'tenant', { id: tenantObject, type: 'access_tenant' }),
        tuple('access_legal_entity', entityObject, 'member', human(ids.alice)),
        tuple('access_legal_entity', entityObject, 'member', human(ids.bob)),
        tuple('access_legal_entity', entityObject, 'member', agent(ids.agentId)),
        tuple('access_scope', scopeObject, 'tenant', { id: tenantObject, type: 'access_tenant' }),
        tuple('access_scope', scopeObject, 'legal_entity', { id: entityObject, type: 'access_legal_entity' }),
        tuple('access_installation', installationObject, 'enabled_scope', { id: scopeObject, type: 'access_scope' }),
        ...capability(ids.capabilityKeys.void),
        ...capability(ids.capabilityKeys.target),
        ...capability(ids.capabilityKeys.amount),
        ...capability(ids.capabilityKeys.read),
        tuple('access_assignment', aliceAssignment, 'scope', { id: scopeObject, type: 'access_scope' }),
        tuple('access_assignment', aliceAssignment, 'holder', human(ids.alice)),
        tuple('access_assignment', botAssignment, 'scope', { id: scopeObject, type: 'access_scope' }),
        tuple('access_assignment', botAssignment, 'agent_holder', agent(ids.agentId)),
        tuple('access_role_binding', bindingObject, 'scope', { id: scopeObject, type: 'access_scope' }),
        tuple('access_role_binding', bindingObject, 'member', {
          id: aliceAssignment,
          relation: 'holder',
          type: 'access_assignment',
        }),
        tuple('access_role_binding', bindingObject, 'agent_member', {
          id: botAssignment,
          relation: 'agent_holder',
          type: 'access_assignment',
        }),
        ...grant(allGrant, ids.capabilityKeys.void),
        ...grant(assignedGrant, ids.capabilityKeys.void),
        ...grant(targetGrant, ids.capabilityKeys.target, {
          context: { resource_keys: [ids.r1] },
          name: 'target_set',
        }),
        ...grant(amountGrant, ids.capabilityKeys.amount, {
          context: { limit_currency: 'CZK', limit_minor: 1000 },
          name: 'amount_ceiling',
        }),
        ...grant(readGrant, ids.capabilityKeys.read),
        slot(ids.capabilityKeys.void, 'run', 'all', allGrant),
        slot(ids.capabilityKeys.void, 'run', 'assigned', assignedGrant),
        slot(ids.capabilityKeys.target, 'run', 'all', targetGrant),
        slot(ids.capabilityKeys.amount, 'run', 'all', amountGrant),
        slot(ids.capabilityKeys.read, 'run', 'all', readGrant),
        tuple('access_record', recordObjectOf(ids.r1), 'scope', { id: scopeObject, type: 'access_scope' }),
        tuple('access_record', recordObjectOf(ids.r1), 'assigned', human(ids.alice)),
        tuple('access_record', recordObjectOf(ids.r2), 'scope', { id: scopeObject, type: 'access_scope' }),
        tuple('access_record', recordObjectOf(ids.r2), 'assigned', human(ids.bob)),
        tuple('access_record', recordObjectOf(ids.r3), 'scope', { id: scopeObject, type: 'access_scope' }),
      ]);

      const slotCheck = yield* Effect.tryPromise(() =>
        client.promises.checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: fullyConsistent,
            permission: 'run_all',
            resource: ref('access_capability', capabilityObject(ids.capabilityKeys.void)),
            subject: subjectRef(human(ids.alice)),
          }),
        ),
      );
      expect(slotCheck.permissionship).toBe(HAS);

      const roleId = RoleIdSchema.make(ids.roleId);
      const roleRevisionId = RoleRevisionIdSchema.make(ids.roleRevisionId);
      const alice = PrincipalIdSchema.make(ids.alice);
      const agentId = AgentIdSchema.make(ids.agentId);
      const aliceHolder: Holder = { _tag: 'Principal', principalId: alice };
      const botHolder: Holder = { _tag: 'Agent', agentId };
      const cellOf = (params: {
        readonly amountCeiling?: { readonly currency: string; readonly limitMinor: number };
        readonly capability: string;
        readonly grant: string;
        readonly holder: Holder;
        readonly incarnation: string;
        readonly selector?: CellSelector;
      }): AuthorityCell =>
        withOptional(
          {
            assignedAt: now,
            assignedBy: alice,
            assignmentIncarnationId: AssignmentIncarnationIdSchema.make(params.incarnation),
            capabilityKey: CapabilityKeySchema.make(params.capability),
            deadline: later,
            grantIncarnationId: GrantIncarnationIdSchema.make(params.grant),
            holder: params.holder,
            mode: 'run',
            roleId,
            roleRevisionId,
            selector: params.selector ?? { _tag: 'all' },
          },
          'amountCeiling',
          params.amountCeiling === undefined
            ? undefined
            : Schema.decodeSync(AmountCeilingSchema)({
                currency: params.amountCeiling.currency,
                limitMinor: params.amountCeiling.limitMinor,
              }),
        );
      const assignedCell = cellOf({
        capability: ids.capabilityKeys.void,
        grant: ids.grantIncarnation,
        holder: aliceHolder,
        incarnation: ids.aliceIncarnation,
        selector: { _tag: 'assigned' },
      });
      const cells: readonly AuthorityCell[] = [
        cellOf({
          capability: ids.capabilityKeys.void,
          grant: ids.grantIncarnation,
          holder: aliceHolder,
          incarnation: ids.aliceIncarnation,
        }),
        assignedCell,
        cellOf({
          capability: ids.capabilityKeys.target,
          grant: ids.grantIncarnation,
          holder: aliceHolder,
          incarnation: ids.aliceIncarnation,
          selector: { _tag: 'targets', recordKeys: [RecordKeySchema.make(ids.r1)] },
        }),
        cellOf({
          amountCeiling: { currency: 'CZK', limitMinor: 1000 },
          capability: ids.capabilityKeys.amount,
          grant: ids.grantIncarnation,
          holder: aliceHolder,
          incarnation: ids.aliceIncarnation,
        }),
        cellOf({
          capability: ids.capabilityKeys.read,
          grant: ids.grantIncarnation,
          holder: aliceHolder,
          incarnation: ids.aliceIncarnation,
        }),
        cellOf({
          capability: ids.capabilityKeys.read,
          grant: ids.grantIncarnation,
          holder: botHolder,
          incarnation: ids.botIncarnation,
        }),
      ];
      const connection: ResolvedAgentConnection = {
        agentId,
        ceiling: {
          cells: [
            {
              capabilityKey: CapabilityKeySchema.make(ids.capabilityKeys.read),
              mode: 'run',
              selector: { _tag: 'all' },
            },
          ],
        },
        connectionId: AgentConnectionIdSchema.make(ids.connectionId),
        consentRevision: 1,
        deadline: later,
        principalId: alice,
        scopeId: AccessScopeIdSchema.make(ids.scopeId),
        status: 'active',
      };
      const authorityFor = (cellsForActor: readonly AuthorityCell[]) => ({
        readCells: (query: { readonly capabilityKey: string; readonly holder: Holder; readonly mode: AccessMode }) =>
          Effect.succeed(cellsForActor.filter(cellMatchesQuery(query))),
        readCompanyOwnership: (query: { readonly legalEntityId: string }) =>
          Effect.succeed(query.legalEntityId === ids.legalEntityId),
        readConnection: () => Effect.succeed(Option.some(connection)),
        readScope: () => {
          const membership = [{ source: 'membership' as const, until: later }];
          return Effect.succeed(
            Option.some({
              deadlines: membership,
              holderDeadlines: [
                { deadlines: membership, holder: aliceHolder },
                { deadlines: membership, holder: botHolder },
              ],
              scope: scopeOf(ids.tenantId, ids.legalEntityId),
              scopeId: AccessScopeIdSchema.make(ids.scopeId),
              tenantId: TenantIdSchema.make(ids.tenantId),
            }),
          );
        },
        readTeamIds: () => Effect.succeed(noTeams),
      });
      const authority = authorityFor(cells);
      const assignedAuthority = authorityFor([assignedCell]);
      const checkPort = makeSpiceDbDecisionCheckPort(rpc);
      const humanActor = {
        actor: { _tag: 'Principal' as const, principalId: alice },
        legalEntityId: LegalEntityIdSchema.make(ids.legalEntityId),
        tenantId: TenantIdSchema.make(ids.tenantId),
      };
      const agentActor = {
        actor: {
          _tag: 'Agent' as const,
          agentId,
          connectionId: connection.connectionId,
          consentRevision: 1,
          principalId: alice,
        },
        legalEntityId: LegalEntityIdSchema.make(ids.legalEntityId),
        tenantId: TenantIdSchema.make(ids.tenantId),
      };
      const scopeWide = countCalls(checkPort);
      const allowed = yield* decideAccess(authority, scopeWide.port, {
        actor: humanActor,
        now,
        request: { capability: actionPolicy(ids.capabilityKeys.void), mode: 'run' },
      });
      expect(allowed.outcome).toBe('ALLOWED');
      expect(scopeWide.calls.count).toBe(1);

      const assignedPolicy: DecisionCapabilityPolicy = {
        ...actionPolicy(ids.capabilityKeys.void),
        selectors: ['assigned'],
      };
      const mine = yield* decideAccess(assignedAuthority, checkPort, {
        actor: humanActor,
        now,
        request: { capability: assignedPolicy, mode: 'run', target: recordOf(ids.r1) },
      });
      expect(mine.outcome).toBe('ALLOWED');
      const theirs = yield* decideAccess(assignedAuthority, checkPort, {
        actor: humanActor,
        now,
        request: { capability: assignedPolicy, mode: 'run', target: recordOf(ids.r2) },
      });
      expect(theirs.outcome).toBe('DENIED');
      // A NULL owner relation never matches (D25).
      const unowned = yield* decideAccess(assignedAuthority, checkPort, {
        actor: humanActor,
        now,
        request: { capability: assignedPolicy, mode: 'run', target: recordOf(ids.r3) },
      });
      expect(unowned.outcome).toBe('DENIED');

      const targetPolicy: DecisionCapabilityPolicy = {
        ...actionPolicy(ids.capabilityKeys.target),
        selectors: ['all'],
      };
      const targeted = yield* decideAccess(authority, checkPort, {
        actor: humanActor,
        now,
        request: { capability: targetPolicy, mode: 'run', target: recordOf(ids.r1) },
      });
      expect(targeted.outcome).toBe('ALLOWED');
      const outside = yield* decideAccess(authority, checkPort, {
        actor: humanActor,
        now,
        request: { capability: targetPolicy, mode: 'run', target: recordOf(ids.r2) },
      });
      expect(outside.outcome).toBe('DENIED');

      const payPolicy = actionPolicy(ids.capabilityKeys.amount);
      const within = yield* decideAccess(authority, checkPort, {
        actor: humanActor,
        now,
        request: { amount: { currency: 'CZK', minor: 1000 }, capability: payPolicy, mode: 'run' },
      });
      expect(within.outcome).toBe('ALLOWED');
      const over = yield* decideAccess(authority, checkPort, {
        actor: humanActor,
        now,
        request: { amount: { currency: 'CZK', minor: 1001 }, capability: payPolicy, mode: 'run' },
      });
      expect(over.outcome).toBe('DENIED');

      const routineRead: DecisionCapabilityPolicy = {
        ...actionPolicy(ids.capabilityKeys.read),
        kind: 'read',
        modes: ['run'],
      };
      const agentRead = yield* decideAccess(authority, checkPort, {
        actor: agentActor,
        now,
        request: { capability: routineRead, mode: 'run' },
      });
      expect(agentRead.outcome).toBe('ALLOWED');
      expect(new Set(agentRead.evidence.map(({ side }) => side))).toEqual(new Set(['agent', 'principal']));
      const sensitiveRead: DecisionCapabilityPolicy = { ...routineRead, risk: 'sensitive' };
      const agentSensitive = yield* decideAccess(authority, checkPort, {
        actor: agentActor,
        now,
        request: { capability: sensitiveRead, mode: 'run' },
      });
      expect(agentSensitive.outcome).toBe('DENIED');
      expect(agentSensitive.reasons.map(({ code }) => code)).toContain('deny.agent_sensitive_read');

      const list = yield* resolveListAccess(assignedAuthority, checkPort, {
        actor: humanActor,
        capability: assignedPolicy,
        mode: 'run',
        now,
      });
      const { decision: listDecision, predicate } = list;
      expect(listDecision.outcome).toBe('ALLOWED');
      expect(predicate).toBeDefined();
      const bobHolder: Holder = { _tag: 'Principal', principalId: PrincipalIdSchema.make(ids.bob) };
      const rows = [
        { assigned: aliceHolder, recordKey: RecordKeySchema.make(ids.r1), teamIds: noTeams },
        { assigned: bobHolder, recordKey: RecordKeySchema.make(ids.r2), teamIds: noTeams },
        { recordKey: RecordKeySchema.make(ids.r3), teamIds: noTeams },
      ];
      for (const row of rows) {
        const decision = yield* decideAccess(assignedAuthority, checkPort, {
          actor: humanActor,
          now,
          request: { capability: assignedPolicy, mode: 'run', target: recordOf(row.recordKey) },
        });
        const listed = predicate !== undefined && evaluateListAccessPredicate(predicate, row);
        expect(listed).toBe(decision.outcome === 'ALLOWED');
      }

      // A navigation page: many declarations for one actor, decided in ONE bulk snapshot against
      // the same projection. Two intent scopes travel in one batch, and every answer is exactly
      // the answer its own `decideAccess` gave above.
      const page = countCalls(checkPort);
      const batched = yield* decideAccessMany(page.port, [
        {
          authority,
          inputs: [
            { actor: humanActor, now, request: { capability: actionPolicy(ids.capabilityKeys.void), mode: 'run' } },
            { actor: humanActor, now, request: { capability: targetPolicy, mode: 'run', target: recordOf(ids.r1) } },
            { actor: humanActor, now, request: { capability: targetPolicy, mode: 'run', target: recordOf(ids.r2) } },
            {
              actor: humanActor,
              now,
              request: { amount: { currency: 'CZK', minor: 1000 }, capability: payPolicy, mode: 'run' },
            },
            {
              actor: humanActor,
              now,
              request: { amount: { currency: 'CZK', minor: 1001 }, capability: payPolicy, mode: 'run' },
            },
            { actor: agentActor, now, request: { capability: routineRead, mode: 'run' } },
          ],
        },
        {
          authority: assignedAuthority,
          inputs: [
            { actor: humanActor, now, request: { capability: assignedPolicy, mode: 'run', target: recordOf(ids.r1) } },
            { actor: humanActor, now, request: { capability: assignedPolicy, mode: 'run', target: recordOf(ids.r2) } },
            { actor: humanActor, now, request: { capability: assignedPolicy, mode: 'run', target: recordOf(ids.r3) } },
          ],
        },
      ]);
      expect(page.calls.count).toBe(1);
      expect(batched[0]).toEqual([allowed, targeted, outside, within, over, agentRead]);
      expect(batched[1]).toEqual([mine, theirs, unowned]);
    }).pipe(Effect.scoped),
  );

  suite.effect("answers a batch three times the server's own check maximum, in order, from one snapshot", () =>
    Effect.gen(function* overServerMaximum() {
      const configuration = yield* loadSpiceDbConfig();
      const rpc = yield* Effect.acquireRelease(
        Effect.sync(() => openSpiceDbGrpcRpc(configuration, 30_000)),
        (current) => Effect.sync(() => current.close()),
      );
      // No relationship names these objects: every check is a definite NO, answered at one pinned snapshot.
      const count = 30_000;
      const batch = Array.from({ length: count }, (_, index) => ({
        permission: 'configure',
        resource: { id: `bulk-limit-${index}`, type: 'access_capability' },
        subject: { id: 'bulk-limit-principal', type: 'principal' as const },
      }));
      const answers = yield* makeSpiceDbDecisionCheckPort(rpc).checkBulk(batch);
      expect(answers).toHaveLength(count);
      expect(answers.every(({ permissionship }) => permissionship === 'none')).toBe(true);
      // The same batch in one request is what SpiceDB refuses (more than 10,000 checks).
      const whole = yield* rpc.checkBulkPermissions(toCheckBulkRequest(batch)).pipe(Effect.flip);
      expect(whole._tag).toBe('SpiceDbRpcError');
    }).pipe(Effect.scoped),
  );
});
