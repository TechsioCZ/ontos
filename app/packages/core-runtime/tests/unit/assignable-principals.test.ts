import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { makeTestDatabase } from '../support/database.ts';
import {
  activeAssignmentMember,
  AssigneeIneligible,
  AssignablePrincipalsUnavailable,
  loadAssignablePrincipalDirectory,
  makeAssignablePrincipals,
} from '../../src/auth/assignable-principals.ts';
import type { AssignablePrincipalDirectory, AssignmentDirectoryMember } from '../../src/auth/assignable-principals.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import {
  LegalEntityIdSchema,
  PrincipalIdSchema,
  AgentIdSchema,
  AgentConnectionIdSchema,
  CapabilityKeySchema,
  ModuleKeySchema,
  RecordKeySchema,
} from '../../src/access/ids.ts';
import type { DecisionAuthorityPort } from '../../src/access/decision/authority.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { AccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import type { AccessDecisionLogEntry } from '../../src/access/enforcement/decision-log.ts';
import type { AccessPrincipalKind } from '../../src/access/enforcement/actor.ts';
import { cell, connect, makeAuthority, makeCheck, tenant, scopeId } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const tenantId = tenant;
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const readDeclaration = (risk: 'routine' | 'sensitive' = 'sensitive') =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'work.tasks.api-records.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'work', level: 'basic' },
      risk,
      selectors: ['all', 'assigned', 'entrusted'],
    },
    { access: 'read', authorization: { kind: 'protected' }, moduleKey: 'work.tasks', role: 'api' },
  );
const carrier = { accessDeclaration: readDeclaration() };

const member = (id: number, changes: Partial<AssignmentDirectoryMember> = {}): AssignmentDirectoryMember => ({
  displayName: `Principal ${id}`,
  membershipStatus: 'active',
  principalRef: { principalId: `30000000-0000-4000-8000-${String(id).padStart(12, '0')}`, tenantId },
  principalStatus: 'active',
  ...changes,
});
const directory = (members: readonly AssignmentDirectoryMember[]): AssignablePrincipalDirectory => ({
  legalEntityId,
  members,
  tenantId,
});
const selectedCompany = { legalEntityId };
const operationalScope = (company: { readonly legalEntityId?: string } = selectedCompany): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:assignment-directory',
    authMethod: 'session',
    principalId: member(1).principalRef.principalId,
    tenantId,
    ...company,
  }),
  correlationId: 'assignment-directory',
});
const eligibility = () => ({ carrier, scope: operationalScope() });

const loadDirectory = (
  installed: OperationalScope,
  requested: OperationalScope,
  rows: Effect.Effect<readonly object[], SqlError> = Effect.succeed([]),
) =>
  Effect.gen(function* scriptedDirectory() {
    const queries: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
    const database = yield* makeTestDatabase((sql, params) => {
      if (sql.includes('access_agent_connections')) {
        return Effect.succeed([]);
      }
      if (sql.includes('principal_company_memberships')) {
        queries.push({ params, sql });
        return rows;
      }
      return Effect.succeed([
        { legal_entity_id: installed.legalEntityId ?? '', role: 'ontos_runtime', tenant_id: installed.tenantId },
      ]);
    });
    const result = yield* Effect.result(
      database.transaction((transaction) =>
        installOperationalScope(transaction, installed, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
          Effect.flatMap((scoped) => loadAssignablePrincipalDirectory(scoped, requested)),
        ),
      ),
    );
    return { queries, result };
  });

for (const [name, installed, requested] of [
  ['no selected company', operationalScope({}), operationalScope({})],
  ['no selected company against a company snapshot', operationalScope(), operationalScope({})],
  ['a tenant mismatch', { ...operationalScope(), tenantId: legalEntityId }, operationalScope()],
  ['a company mismatch', operationalScope({ legalEntityId: tenantId }), operationalScope()],
  ['a missing installed company', operationalScope({}), operationalScope()],
] as const) {
  it.effect(`rejects ${name} before querying the assignment directory`, () =>
    Effect.gen(function* rejectsScope() {
      const { queries, result } = yield* loadDirectory(installed, requested);
      expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
      expect(queries).toEqual([]);
    }),
  );
}

it.effect('loads the same-snapshot directory without exposing operational scope metadata', () =>
  Effect.gen(function* loadsDirectory() {
    const target = member(2, { membershipStatus: 'departed', principalStatus: 'disabled' });
    const { queries, result } = yield* loadDirectory(
      operationalScope(),
      operationalScope(),
      Effect.succeed([
        {
          displayName: target.displayName,
          membershipStatus: target.membershipStatus,
          principalId: target.principalRef.principalId,
          principalStatus: target.principalStatus,
          tenantId,
        },
      ]),
    );
    expect(Result.isSuccess(result) && result.success).toEqual({ ...directory([target]), agentContexts: [] });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toEqual([tenantId, legalEntityId]);
    expect(queries[0]?.sql).toContain('"principal_company_memberships"."tenant_id" = $1');
    expect(queries[0]?.sql).toContain('"principal_company_memberships"."legal_entity_id" = $2');
    expect(queries[0]?.sql).toContain(
      'order by "core"."principals"."display_name", "core"."principals"."principal_id"',
    );
  }),
);

it.effect('keeps assignment directory SQL failures unavailable instead of returning an empty directory', () =>
  Effect.gen(function* directoryUnavailable() {
    const { queries, result } = yield* loadDirectory(
      operationalScope(),
      operationalScope(),
      Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'controlled outage' }) })),
    );
    expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
    expect(queries).toHaveLength(1);
  }),
);

const fixture = (
  options: {
    readonly cells?: AuthoritySpec['cells'];
    readonly connection?: AuthoritySpec['connection'];
    readonly connections?: readonly NonNullable<AuthoritySpec['connection']>[];
    readonly failure?: boolean;
    readonly kinds?: ReadonlyMap<string, AccessPrincipalKind>;
    readonly nonMembers?: AuthoritySpec['nonMembers'];
    /** Only the scope read for the evidence row fails; the engine's own scope read, which comes first, answers. */
    readonly scopeReadFailsAfterDecision?: boolean;
  } = {},
) => {
  const base: AuthoritySpec = {
    cells: options.cells ?? [
      cell({
        capability: carrier.accessDeclaration.key,
        holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(member(2).principalRef.principalId) },
        selector: { _tag: 'entrusted' },
      }),
    ],
    legalEntityScope: { _tag: 'LegalEntity', legalEntityId: LegalEntityIdSchema.make(legalEntityId), tenantId: tenant },
  };
  const withConnection = options.connection === undefined ? base : { ...base, connection: options.connection };
  const spec =
    options.nonMembers === undefined ? withConnection : { ...withConnection, nonMembers: options.nonMembers };
  const authority = makeAuthority(spec);
  const check = makeCheck(options.failure === true ? { authority: spec, failure: true } : { authority: spec });
  const scopes: OperationalScope[] = [];
  const entries: AccessDecisionLogEntry[] = [];
  const ports: AccessEnforcementPorts = {
    candidates: { listCandidateIds: () => Effect.succeed([]) },
    check: check.port,
    decisionLog: {
      record: (entry) =>
        Effect.sync(() => {
          entries.push(entry);
        }),
    },
    intent: {
      authorityFor: (scope) => {
        scopes.push(scope);
        const port: DecisionAuthorityPort =
          options.connections === undefined
            ? authority.port
            : {
                ...authority.port,
                readConnection: (query) =>
                  Effect.succeed(
                    Option.fromUndefinedOr(
                      options.connections?.find((connection) => connection.connectionId === query.connectionId),
                    ),
                  ),
              };
        return options.scopeReadFailsAfterDecision === true
          ? {
              ...port,
              readScope: (query) =>
                check.calls.checkBulk > 0
                  ? Effect.fail(accessDecisionUnavailable('scope read failed'))
                  : port.readScope(query),
            }
          : port;
      },
    },
    principalKinds: {
      readKind: (query) => {
        scopes.push(query.scope);
        return Effect.succeed(Option.some(options.kinds?.get(query.principalId) ?? 'human'));
      },
    },
  };
  return { check, entries, scopes, service: makeAssignablePrincipals(ports) };
};

it.effect('readonly external target is eligible from its entrusted LIST authority even before owning a record', () =>
  Effect.gen(function* external() {
    const f = fixture();
    expect(yield* f.service.read(directory([member(2)]), eligibility())).toEqual([
      { displayName: member(2).displayName, principalRef: member(2).principalRef },
    ]);
    expect(f.check.sent.length).toBeGreaterThan(0);
    expect(
      f.scopes.every(
        (scope) =>
          scope.principalId === member(1).principalRef.principalId &&
          scope.authBindingId === operationalScope().authBindingId,
      ),
    ).toBe(true);
    expect(f.entries[0]?.scope).toEqual(operationalScope());
    expect(f.entries[0]?.actor).toEqual({ _tag: 'Principal', principalId: member(2).principalRef.principalId });
    expect(f.entries[0]?.onBehalfOfPrincipalId).toBe(member(1).principalRef.principalId);
    expect(f.entries[0]?.capability.capabilityKey).toBe(carrier.accessDeclaration.key);
  }),
);

it.effect('membership alone and the requester rights do not grant target eligibility', () =>
  Effect.gen(function* membership() {
    const f = fixture({
      cells: [
        cell({
          capability: carrier.accessDeclaration.key,
          holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(member(1).principalRef.principalId) },
        }),
      ],
    });
    expect(yield* f.service.read(directory([member(2)]), eligibility())).toEqual([]);
    const result = yield* Effect.result(
      f.service.resolveAssignee(directory([member(2)]), member(2).principalRef, eligibility()),
    );
    expect(Result.isFailure(result) && Schema.is(AssigneeIneligible)(result.failure)).toBe(true);
  }),
);

it.effect('rejects foreign tenant or selected company before reading candidate authority', () =>
  Effect.gen(function* foreign() {
    const f = fixture();
    for (const scope of [
      { ...operationalScope(), legalEntityId: tenantId },
      { ...operationalScope(), tenantId: legalEntityId },
    ]) {
      const result = yield* Effect.result(f.service.read(directory([member(2)]), { carrier, scope }));
      expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
    }
    expect(f.scopes).toEqual([]);
  }),
);

it.effect('an unrelated explicit record target is not widened into LIST eligibility', () =>
  Effect.gen(function* unrelated() {
    const f = fixture();
    const result = yield* Effect.result(
      f.service.resolveAssignee(directory([member(2)]), member(2).principalRef, {
        ...eligibility(),
        target: { moduleKey: ModuleKeySchema.make('work.tasks'), recordKey: RecordKeySchema.make('unrelated-task') },
      }),
    );
    expect(Result.isFailure(result) && Schema.is(AssigneeIneligible)(result.failure)).toBe(true);
  }),
);

for (const kind of ['agent', 'service', 'integration', 'system'] as const) {
  it.effect(`a standalone ${kind} cannot become a human assignment target`, () =>
    Effect.gen(function* standalone() {
      const f = fixture({ kinds: new Map([[member(2).principalRef.principalId, kind]]) });
      expect(yield* f.service.read(directory([member(2)]), eligibility())).toEqual([]);
      expect(f.check.sent).toEqual([]);
    }),
  );
}

it.effect(
  'real agent connection evaluates full person, agent and consent context independently; sensitive reads stay forbidden',
  () =>
    Effect.gen(function* connectedAgent() {
      const owner = PrincipalIdSchema.make(member(1).principalRef.principalId);
      const agentId = AgentIdSchema.make(member(2).principalRef.principalId);
      const declaration = readDeclaration('routine');
      const connection = connect({
        agentId,
        ceiling: {
          cells: [{ capabilityKey: CapabilityKeySchema.make(declaration.key), mode: 'run', selector: { _tag: 'all' } }],
        },
        principalId: owner,
        scopeId,
      });
      const context = {
        _tag: 'Agent' as const,
        agentId,
        connectionId: connection.connectionId,
        consentRevision: connection.consentRevision,
        principalId: owner,
      };
      const f = fixture({
        cells: [
          cell({ capability: declaration.key, holder: { _tag: 'Principal', principalId: owner } }),
          cell({ capability: declaration.key, holder: { _tag: 'Agent', agentId } }),
        ],
        connection,
        kinds: new Map([[agentId, 'agent']]),
      });
      const snapshot = { ...directory([member(2)]), agentContexts: [context] };
      expect(
        yield* f.service.read(snapshot, { ...eligibility(), carrier: { accessDeclaration: declaration } }),
      ).toHaveLength(1);
      expect(yield* f.service.read(snapshot, eligibility())).toEqual([]);
      expect(
        yield* f.service.read(
          { ...snapshot, agentContexts: [{ ...context, consentRevision: context.consentRevision + 1 }] },
          { ...eligibility(), carrier: { accessDeclaration: declaration } },
        ),
      ).toEqual([]);
    }),
);

it.effect('transport unavailable is not an empty candidate directory', () =>
  Effect.gen(function* outage() {
    const f = fixture({ failure: true });
    const result = yield* Effect.result(f.service.read(directory([member(2)]), eligibility()));
    expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
  }),
);

it.effect('a company member without a live access membership is not eligible and does not fail the read', () =>
  Effect.gen(function* withoutAccessMembership() {
    const scopeless = member(3);
    const f = fixture({
      cells: [
        cell({
          capability: carrier.accessDeclaration.key,
          holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(member(2).principalRef.principalId) },
          selector: { _tag: 'entrusted' },
        }),
      ],
      nonMembers: [{ _tag: 'Principal', principalId: PrincipalIdSchema.make(scopeless.principalRef.principalId) }],
    });
    const snapshot = directory([member(2), scopeless]);
    expect(yield* f.service.read(snapshot, eligibility())).toEqual([
      { displayName: member(2).displayName, principalRef: member(2).principalRef },
    ]);
    // The decision log needs a scope id, so only the candidate that has a scope leaves a row.
    expect(f.entries.map(({ actor }) => actor)).toEqual([
      { _tag: 'Principal', principalId: member(2).principalRef.principalId },
    ]);
    const result = yield* Effect.result(f.service.resolveAssignee(snapshot, scopeless.principalRef, eligibility()));
    expect(Result.isFailure(result) && Schema.is(AssigneeIneligible)(result.failure)).toBe(true);
  }),
);

it.effect('stays unavailable, not an empty directory, when the scope read for the evidence row fails', () =>
  Effect.gen(function* evidenceOutage() {
    const f = fixture({ scopeReadFailsAfterDecision: true });
    const result = yield* Effect.result(f.service.read(directory([member(2)]), eligibility()));
    expect(Result.isFailure(result) && Schema.is(AssignablePrincipalsUnavailable)(result.failure)).toBe(true);
  }),
);

it.effect('rechecks active membership at assignment and commit', () =>
  Effect.gen(function* membership() {
    const f = fixture();
    yield* f.service.resolveAssignee(directory([member(2)]), member(2).principalRef, eligibility());
    for (const snapshot of [
      directory([]),
      directory([member(2, { membershipStatus: 'departed' })]),
      directory([member(2, { principalStatus: 'archived' })]),
    ]) {
      const result = yield* Effect.result(activeAssignmentMember(snapshot, member(2).principalRef));
      expect(Result.isFailure(result) && Schema.is(AssigneeIneligible)(result.failure)).toBe(true);
    }
  }),
);

it.effect('does not pick the first agent context or union rights across several complete contexts', () =>
  Effect.gen(function* independentConnections() {
    const owner = PrincipalIdSchema.make(member(1).principalRef.principalId);
    const otherOwner = PrincipalIdSchema.make(member(3).principalRef.principalId);
    const agentId = AgentIdSchema.make(member(2).principalRef.principalId);
    const declaration = readDeclaration('routine');
    const ceiling = {
      cells: [
        {
          capabilityKey: CapabilityKeySchema.make(declaration.key),
          mode: 'run' as const,
          selector: { _tag: 'all' as const },
        },
      ],
    };
    const allowed = connect({ agentId, ceiling, principalId: owner, scopeId });
    const context = {
      _tag: 'Agent' as const,
      agentId,
      connectionId: allowed.connectionId,
      consentRevision: allowed.consentRevision,
      principalId: owner,
    };
    const cells = [
      cell({ capability: declaration.key, holder: { _tag: 'Principal' as const, principalId: owner } }),
      cell({ capability: declaration.key, holder: { _tag: 'Agent' as const, agentId } }),
    ];
    const available = fixture({ cells, connection: allowed, kinds: new Map([[agentId, 'agent']]) });
    const eligibilityInput = { ...eligibility(), carrier: { accessDeclaration: declaration } };
    expect(
      yield* available.service.read(
        {
          ...directory([member(2)]),
          agentContexts: [{ ...context, consentRevision: context.consentRevision + 1 }, context],
        },
        eligibilityInput,
      ),
    ).toHaveLength(1);
    const first = connect({ ...allowed, ceiling: { cells: [] } });
    const second = connect({
      ...allowed,
      connectionId: AgentConnectionIdSchema.make('00000000-0000-4000-8000-000000000088'),
      principalId: otherOwner,
    });
    const separate = fixture({ cells, connections: [first, second], kinds: new Map([[agentId, 'agent']]) });
    expect(
      yield* separate.service.read(
        {
          ...directory([member(2)]),
          agentContexts: [context, { ...context, connectionId: second.connectionId, principalId: otherOwner }],
        },
        eligibilityInput,
      ),
    ).toEqual([]);
  }),
);
