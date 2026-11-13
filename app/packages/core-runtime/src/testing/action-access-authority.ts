import { DateTime, Effect, Layer, Option, Predicate } from 'effect';

import { legalEntityScopeId, tenantContextScopeId } from '../access/bootstrap/persistence.ts';
import { stableUuid } from '../access/catalog/stable-id.ts';
import { legalEntityObjectId, objectTypeOf } from '../access/compiler/object-id.ts';
import { AccessIntent } from '../access/decision/authority.ts';
import type {
  AuthorityCell,
  AuthorityCellQuery,
  CompanyOwnershipQuery,
  DecisionAuthorityPort,
  ResolvedAccessScope,
  ScopeQuery,
} from '../access/decision/authority.ts';
import { DecisionCheck } from '../access/decision/engine.ts';
import type { AccessCheckItem, AccessCheckResult, DecisionCheckPort } from '../access/decision/engine.ts';
import {
  assignmentObjectIdOf,
  capabilityObjectIdOf,
  grantObjectIdOf,
  roleBindingObjectIdOf,
} from '../access/decision/projection.ts';
import type { ProjectionScope } from '../access/decision/projection.ts';
import { holderSubjectOf } from '../access/decision/selector.ts';
import { AccessPrincipalKindSource } from '../access/enforcement/actor.ts';
import type { PrincipalKindQuery } from '../access/enforcement/actor.ts';
import { AccessDecisionLog } from '../access/enforcement/decision-log.ts';
import { LegalEntityCandidates } from '../access/enforcement/legal-entities.ts';
import {
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../access/ids.ts';
import type { AccessMode, AccessScope, Holder } from '../access/model.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { CanonicalActionTestAccessPorts } from './access-gate.ts';

/**
 * One native fixture's scripted authority: the persisted tenant it runs in, the one principal it
 * acts for, and the capabilities that principal does NOT hold.
 *
 * This is a *test* source. It creates no intent row, writes no grant and never stands in for the
 * database: the persisted scope and fence rows a prepared Action needs come from the native writer
 * (`writeTestTenantScopes`) and are read back by the production currentness reader.
 */
export interface TestActionAccessAuthorityScript {
  /**
   * The companies of this tenant, in the persisted scope ids `bootstrapScopesOf` derives. The
   * tenant context scope always exists; each company here also gets its own scope and a Ready fence.
   */
  readonly legalEntityIds?: readonly string[];
  /** The one holder this scripted authority answers for; every other holder and kind is refused. */
  readonly principalId: string;
  /** Capability keys the acting principal does not hold, refused exactly as a missing assignment is. */
  readonly refusedCapabilityKeys?: readonly string[];
  readonly tenantId: string;
}

/** The persisted scope ids of one scripted tenant, derived exactly as the native writer derives them. */
export const testActionAccessScopeIds = (script: TestActionAccessAuthorityScript) => {
  const tenantId = TenantIdSchema.make(script.tenantId);
  return Object.freeze({
    legalEntityScopeIds: Object.freeze(
      (script.legalEntityIds ?? []).map((legalEntityId) =>
        legalEntityScopeId(tenantId, LegalEntityIdSchema.make(legalEntityId)),
      ),
    ),
    tenantContextScopeId: tenantContextScopeId(tenantId),
  });
};

interface ScriptedCell {
  readonly cell: AuthorityCell;
  readonly scope: ProjectionScope;
}

const GRANT_OBJECT_TYPE = objectTypeOf('grant');
const CAPABILITY_OBJECT_TYPE = objectTypeOf('capability');
const ASSIGNMENT_OBJECT_TYPE = objectTypeOf('assignment');
const ROLE_BINDING_OBJECT_TYPE = objectTypeOf('role_binding');
const LEGAL_ENTITY_OBJECT_TYPE = objectTypeOf('legal_entity');

interface ExpectedWitness {
  readonly permission: string;
  readonly resourceId: string;
  readonly subject: AccessCheckItem['subject'];
}
const witnessOf = (type: string, { cell, scope }: ScriptedCell): ExpectedWitness | undefined => {
  switch (type) {
    case GRANT_OBJECT_TYPE: {
      return {
        permission: cell.mode === 'approve' ? 'human_use' : 'use',
        resourceId: grantObjectIdOf(scope, cell),
        subject: holderSubjectOf(cell.holder),
      };
    }
    case CAPABILITY_OBJECT_TYPE: {
      return {
        permission: `${cell.mode}_all_grant`,
        resourceId: capabilityObjectIdOf(scope, cell.capabilityKey),
        subject: { id: grantObjectIdOf(scope, cell), type: 'access_grant' },
      };
    }
    case ASSIGNMENT_OBJECT_TYPE: {
      return {
        permission: 'eligible',
        resourceId: assignmentObjectIdOf(scope, cell),
        subject: holderSubjectOf(cell.holder),
      };
    }
    case ROLE_BINDING_OBJECT_TYPE: {
      return {
        permission: 'member',
        resourceId: roleBindingObjectIdOf(scope, cell),
        subject: { id: assignmentObjectIdOf(scope, cell), relation: 'holder', type: 'access_assignment' },
      };
    }
    default: {
      return undefined;
    }
  }
};

/**
 * The ports a native fixture gives its real `AccessDecisionLive` gate when the owned database
 * carries no v2 intent: the fixture's actor holds the capability the request declares, unless the
 * suite refused it, and the engine's four witness relations are answered from the very cells this
 * test authority produced. The script grants the fixture actor's declared capabilities; it is not
 * a production grant or a persisted intent source.
 *
 * Currentness is deliberately absent: `makePersistedActionTestAccessGate` (or the shipped
 * `bindLiveActionAccessGate`) supplies the production fence/revision reader over real rows.
 */
export const makeTestActionAccessPorts = (
  script: TestActionAccessAuthorityScript,
): Omit<CanonicalActionTestAccessPorts, 'currentness'> => {
  const principalId = PrincipalIdSchema.make(script.principalId);
  const tenantId = TenantIdSchema.make(script.tenantId);
  const companies = (script.legalEntityIds ?? []).map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId));
  const refused = new Set<string>(script.refusedCapabilityKeys);
  const holder: Holder = Object.freeze({ _tag: 'Principal', principalId });
  const holderSubject = holderSubjectOf(holder);
  // The cells this authority produced, so the engine's snapshot is answered by the exact witness
  // chain of the cell that was read instead of a blanket permission.
  const produced = new Map<string, ScriptedCell>();
  const cellOf = (scope: ProjectionScope, capabilityKey: string, mode: AccessMode): AuthorityCell =>
    Object.freeze({
      assignedAt: DateTime.toDateUtc(DateTime.makeUnsafe('1970-01-01T00:00:00.000Z')),
      assignedBy: principalId,
      assignmentIncarnationId: AssignmentIncarnationIdSchema.make(
        stableUuid(`ontos.test.action-access.assignment:${scope.tenantId}:${scope.scopeId}:${capabilityKey}`),
      ),
      capabilityKey: CapabilityKeySchema.make(capabilityKey),
      grantIncarnationId: GrantIncarnationIdSchema.make(
        stableUuid(`ontos.test.action-access.grant:${scope.tenantId}:${scope.scopeId}:${capabilityKey}:${mode}`),
      ),
      holder,
      mode,
      roleId: RoleIdSchema.make(stableUuid(`ontos.test.action-access.role:${scope.tenantId}:${scope.scopeId}`)),
      roleRevisionId: RoleRevisionIdSchema.make(
        stableUuid(`ontos.test.action-access.role-revision:${scope.tenantId}:${scope.scopeId}`),
      ),
      selector: Object.freeze({ _tag: 'all' as const }),
    });

  const scopeOf = (query: ScopeQuery): ResolvedAccessScope | undefined => {
    const { legalEntityId } = query;
    if (
      query.tenantId !== tenantId ||
      (legalEntityId !== undefined && !companies.some((company) => company === legalEntityId))
    ) {
      return undefined;
    }
    const scope: AccessScope =
      legalEntityId === undefined
        ? Object.freeze({ _tag: 'TenantContext' as const, tenantId })
        : Object.freeze({ _tag: 'LegalEntity' as const, legalEntityId, tenantId });
    return Object.freeze({
      deadlines: Object.freeze([]),
      holderDeadlines: Object.freeze(query.holders.map((one) => Object.freeze({ deadlines: [], holder: one }))),
      scope,
      scopeId:
        legalEntityId === undefined ? tenantContextScopeId(tenantId) : legalEntityScopeId(tenantId, legalEntityId),
      tenantId,
    });
  };

  const readCells = (query: AuthorityCellQuery) => {
    if (refused.has(query.capabilityKey)) {
      return Effect.succeed([]);
    }
    if (!Predicate.isTagged(query.holder, 'Principal') || query.holder.principalId !== principalId) {
      return Effect.succeed([]);
    }
    const scope: ProjectionScope = Object.freeze({ scopeId: query.scopeId, tenantId: query.tenantId });
    const cell = cellOf(scope, query.capabilityKey, query.mode);
    produced.set(`${query.scopeId}\u0000${query.capabilityKey}\u0000${query.mode}`, Object.freeze({ cell, scope }));
    return Effect.succeed([cell]);
  };

  const authorityFor = (_scope: OperationalScope): DecisionAuthorityPort =>
    Object.freeze({
      readCells,
      // The batched read every live intent port offers: each answer exactly the single read's.
      readCellsMany: (queries: readonly AuthorityCellQuery[]) => Effect.forEach(queries, readCells, { concurrency: 1 }),
      // One fixture tenant: a company it names is the tenant's exactly when its scope exists.
      readCompanyOwnership: (query: CompanyOwnershipQuery) =>
        Effect.succeed(scopeOf({ ...query, holders: [] }) !== undefined),
      readConfigureBases: () => Effect.succeed([]),
      readConnection: () => Effect.succeed(Option.none()),
      readScope: (query: ScopeQuery) => Effect.succeed(Option.fromUndefinedOr(scopeOf(query))),
      readTeamIds: () => Effect.succeed([]),
    });

  /** One item's answer, derived from the exact cell the engine read for this scope and capability. */
  const answerOf = (item: AccessCheckItem): AccessCheckResult => {
    const none: AccessCheckResult = Object.freeze({ permissionship: 'none' as const });
    const has: AccessCheckResult = Object.freeze({ permissionship: 'has' as const });
    if (item.resource.type === LEGAL_ENTITY_OBJECT_TYPE && item.permission === 'select') {
      const selected = companies.some((company) => legalEntityObjectId(tenantId, company) === item.resource.id);
      return selected && item.subject.type === holderSubject.type && item.subject.id === holderSubject.id ? has : none;
    }
    const matches = [...produced.values()].some((cell) => {
      const expected = witnessOf(item.resource.type, cell);
      return (
        expected !== undefined &&
        item.permission === expected.permission &&
        item.resource.id === expected.resourceId &&
        item.subject.type === expected.subject.type &&
        item.subject.id === expected.subject.id &&
        item.subject.relation === expected.subject.relation
      );
    });
    return matches ? has : none;
  };

  const check: DecisionCheckPort = Object.freeze({
    checkBulk: (items: readonly AccessCheckItem[]) => Effect.succeed(items.map(answerOf)),
  });

  return Object.freeze({
    candidates: Object.freeze({ listCandidateIds: () => Effect.succeed(companies) }),
    check,
    decisionLog: Object.freeze({ record: () => Effect.void }),
    intent: Object.freeze({
      authorityFor,
      // The same scripted authority over a transaction the caller already owns (O75): it reads no
      // rows, so the joined read is the request read, exactly as an owner-phase decision expects.
      joined: () => Object.freeze({ authorityFor }),
    }),
    principalKinds: Object.freeze({
      readKind: (query: PrincipalKindQuery) =>
        Effect.succeed(query.principalId === principalId ? Option.some('human' as const) : Option.none()),
    }),
  });
};

/** The five test ports; each native process root composes them with the shipped `AccessDecisionLive`. */
export const makeTestActionAccessLayers = (
  script: TestActionAccessAuthorityScript,
): Layer.Layer<
  AccessDecisionLog | AccessIntent | AccessPrincipalKindSource | DecisionCheck | LegalEntityCandidates
> => {
  const ports = makeTestActionAccessPorts(script);
  return Layer.mergeAll(
    Layer.succeed(AccessIntent, ports.intent),
    Layer.succeed(AccessDecisionLog, ports.decisionLog),
    Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
    Layer.succeed(DecisionCheck, ports.check),
    Layer.succeed(LegalEntityCandidates, ports.candidates),
  );
};
