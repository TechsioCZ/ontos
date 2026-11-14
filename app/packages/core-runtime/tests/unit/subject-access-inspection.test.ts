import { Cause, Effect, Exit, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActorContextSchema } from '../../src/access/model.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessActor, decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { ConnectionQuery, DecisionAuthorityPort } from '../../src/access/decision/authority.ts';
import type { AccessCheckPermissionship } from '../../src/access/decision/engine.ts';
import type { AccessPrincipalKind } from '../../src/access/enforcement/actor.ts';
import type { AccessDecisionLogEntry } from '../../src/access/enforcement/decision-log.ts';
import { makeSubjectAccessInspection, SubjectInspectionUnavailable } from '../../src/access/enforcement/index.ts';
import type {
  InspectionSubject,
  SubjectCapabilityInspectionInput,
  SubjectIdentityFacts,
  SubjectInspectionCatalog,
  SubjectInspectionInput,
} from '../../src/access/enforcement/index.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  CapabilityKeySchema,
  LegalEntityIdSchema,
} from '../../src/access/ids.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import type { DeclaredActionAuthority } from '../../src/permissions/action-authority.ts';
import {
  agent,
  cell,
  connect,
  connectionId,
  makeAuthority,
  makeCheck,
  otherPerson,
  person,
  principalHolder,
  tenant,
} from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const [PrincipalActor, AgentActor] = ActorContextSchema.members;
const company = LegalEntityIdSchema.make('00000000-0000-4000-8000-000000000080');
const differentTenant = '00000000-0000-4000-8000-000000000090';
const requesterScope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000084',
    authContextRef: 'better-auth-session:real-inspection-requester',
    authMethod: 'session',
    legalEntityId: company,
    principalId: person,
    tenantId: tenant,
  }),
  correlationId: 'real-requester-correlation',
});
const subject: InspectionSubject = { principalId: otherPerson, tenantId: tenant };
const base: SubjectInspectionInput = {
  queryScope: { legalEntityId: company, tenantId: tenant },
  requesterScope,
  subject,
};
const declaration = (changes: Partial<AccessDeclarationInput> = {}) =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'party.registry.party.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'registry', level: 'basic' },
      risk: 'sensitive',
      selectors: [],
      ...changes,
    },
    {
      access: changes.kind === 'action' ? 'write' : 'read',
      authorization: { kind: 'protected' },
      moduleKey: 'party.registry',
      role: changes.kind === 'action' ? 'action' : 'api',
    },
  );
const read = declaration();
const question: SubjectCapabilityInspectionInput = {
  ...base,
  carrier: { accessDeclaration: read },
  legalEntityScope: 'required',
};
const active: SubjectIdentityFacts = {
  companyStatus: 'active',
  membership: { affiliation: 'external', status: 'active' },
  principalStatus: 'active',
  tenantStatus: 'active',
};
const agentSubject = (changes: Partial<NonNullable<InspectionSubject['agentContext']>> = {}): InspectionSubject => ({
  agentContext: { connectionId, consentRevision: 1, principalId: otherPerson, ...changes },
  principalId: agent,
  tenantId: tenant,
});

interface FixtureOptions {
  readonly catalog?: Effect.Effect<SubjectInspectionCatalog, SubjectInspectionUnavailable>;
  readonly cells?: AuthoritySpec['cells'];
  readonly connection?: AuthoritySpec['connection'];
  readonly connections?: readonly NonNullable<AuthoritySpec['connection']>[];
  readonly engineFailure?: boolean;
  readonly evidenceFailure?: boolean;
  readonly facts?: SubjectIdentityFacts | null;
  readonly factsFailure?: boolean;
  readonly factsInterrupted?: boolean;
  readonly kind?: AccessPrincipalKind;
  readonly kindFailure?: boolean;
  readonly ownerKind?: AccessPrincipalKind;
  readonly permission?: AccessCheckPermissionship;
  readonly scopeAbsent?: boolean;
}
const fixture = (options: FixtureOptions = {}) => {
  const calls: { readonly port: string; readonly scope: OperationalScope }[] = [];
  const entries: AccessDecisionLogEntry[] = [];
  /** The size of every evidence write: each one is one transaction in production. */
  const evidenceBatches: number[] = [];
  const baseSpec: AuthoritySpec = {
    cells: options.cells ?? [cell({ capability: read.key, holder: principalHolder(otherPerson) })],
    legalEntityScope: { _tag: 'LegalEntity', legalEntityId: company, tenantId: tenant },
  };
  const spec: AuthoritySpec =
    options.connection === undefined ? baseSpec : { ...baseSpec, connection: options.connection };
  const authority = makeAuthority(spec);
  const check = makeCheck({ authority: spec, failure: options.engineFailure ?? false });
  const actions = new Map<string, DeclaredActionAuthority>();
  const catalog: SubjectInspectionCatalog = { actions, revision: 'current-approved-revision' };
  const connectionQueries: ConnectionQuery[] = [];
  const connections = options.connections ?? (spec.connection === undefined ? [] : [spec.connection]);
  const keyedAuthority: DecisionAuthorityPort = {
    ...authority.port,
    readConnection: (query) => {
      connectionQueries.push(query);
      return authority.port
        .readConnection(query)
        .pipe(
          Effect.as(
            Option.fromUndefinedOr(connections.find((candidate) => candidate.connectionId === query.connectionId)),
          ),
        );
    },
  };
  const originalAuthority: DecisionAuthorityPort =
    options.scopeAbsent === true
      ? { ...keyedAuthority, readScope: () => Effect.succeed(Option.none()) }
      : keyedAuthority;
  const service = makeSubjectAccessInspection({
    authorityFor: (scope) => {
      calls.push({ port: 'authority', scope });
      return originalAuthority;
    },
    check: {
      checkBulk: (items) =>
        items.every((item) => item.permission === 'select')
          ? Effect.succeed(items.map(() => ({ permissionship: options.permission ?? 'has' })))
          : check.port.checkBulk(items),
    },
    currentCatalog: options.catalog ?? Effect.succeed(catalog),
    decisionLog: {
      recordAll: (batch) => {
        evidenceBatches.push(batch.length);
        for (const entry of batch) {
          calls.push({ port: 'evidence', scope: entry.scope });
          entries.push(entry);
        }
        return options.evidenceFailure === true
          ? Effect.fail(accessDecisionUnavailable('evidence outage'))
          : Effect.void;
      },
    },
    identities: {
      read: ({ principalId, requesterScope: scope }) => {
        calls.push({ port: 'facts', scope });
        if (options.factsInterrupted === true) {
          return Effect.interrupt;
        }
        if (options.factsFailure === true) {
          return Effect.fail(new SubjectInspectionUnavailable({ reason: 'facts outage' }));
        }
        const facts = options.facts === undefined ? active : options.facts;
        return Effect.succeed(
          facts === null
            ? Option.none()
            : Option.some(
                principalId === String(agent)
                  ? { ...facts, membership: { affiliation: null, status: 'active' } }
                  : facts,
              ),
        );
      },
    },
    principalKinds: {
      readKind: ({ principalId, scope }) => {
        calls.push({ port: 'kind', scope });
        if (options.kindFailure === true) {
          return Effect.fail(accessDecisionUnavailable('kind outage'));
        }
        if (principalId === String(agent)) {
          return Effect.succeed(Option.some(options.kind ?? 'agent'));
        }
        return Effect.succeed(Option.some(principalId === otherPerson ? (options.ownerKind ?? 'human') : 'human'));
      },
    },
  });
  return { actions, authority, calls, check, connectionQueries, entries, evidenceBatches, service };
};

it.effect(
  'evaluates subject rights, retaining original requester credentials/object identity for all ports and evidence',
  () =>
    Effect.gen(function* inspectSubject() {
      const f = fixture();
      const result = yield* f.service.inspect(question);
      expect(result.inspectionOnly).toBe(true);
      expect(result.decision.outcome).toBe('ALLOWED');
      expect(f.entries).toHaveLength(1);
      expect(f.entries[0]?.actor).toEqual(PrincipalActor.make({ principalId: otherPerson }));
      expect(f.entries[0]?.onBehalfOfPrincipalId).toBe(person);
      expect(f.entries[0]?.scope).toBe(requesterScope);
      expect(f.calls.length).toBeGreaterThan(3);
      expect(f.calls.every(({ scope }) => scope === requesterScope)).toBe(true);
      expect(Object.keys(result).toSorted()).toEqual(['decision', 'inspectionOnly']);
      expect(Object.hasOwn(result, 'scope')).toBe(false);
    }),
);

it.effect('does not borrow requester grants when the subject holds none', () =>
  Effect.gen(function* onlySubjectCells() {
    const f = fixture({ cells: [cell({ capability: read.key, holder: principalHolder(person) })] });
    expect((yield* f.service.inspect(question)).decision.outcome).toBe('DENIED');
    expect(f.entries[0]?.actor).toEqual(PrincipalActor.make({ principalId: otherPerson }));
    expect(f.entries[0]?.onBehalfOfPrincipalId).toBe(person);
  }),
);

for (const [name, changed] of [
  ['disabled principal', { ...active, principalStatus: 'disabled' }],
  ['archived principal', { ...active, principalStatus: 'archived' }],
  ['suspended tenant', { ...active, tenantStatus: 'suspended' }],
  ['suspended company', { ...active, companyStatus: 'suspended' }],
  ['departed company member', { ...active, membership: { affiliation: 'external', status: 'departed' } }],
  ['disabled company member', { ...active, membership: { affiliation: 'employee', status: 'disabled' } }],
  ['invalid human affiliation', { ...active, membership: { affiliation: null, status: 'active' } }],
  ['missing persisted principal', null],
] as const) {
  it.effect(`refuses ${name} before graph rights can grant`, () =>
    Effect.gen(function* invalidFacts() {
      const f = fixture({ facts: changed });
      expect((yield* f.service.inspect(question)).decision.outcome).toBe('DENIED');
      expect(f.check.calls.checkBulk).toBe(0);
    }),
  );
}

it.effect('denies a foreign tenant without reading its identity or rights', () =>
  Effect.gen(function* foreignTenant() {
    const f = fixture();
    expect(
      (yield* f.service.inspect({ ...question, subject: { ...subject, tenantId: differentTenant } })).decision.outcome,
    ).toBe('DENIED');
    expect(f.calls.filter(({ port }) => port !== 'authority')).toEqual([]);
    expect(f.check.calls.checkBulk).toBe(0);
  }),
);

it.effect('does not turn stale/revoked canonical membership into projection authority', () =>
  Effect.gen(function* canonicalMembership() {
    const f = fixture({ scopeAbsent: true });
    expect((yield* f.service.inspect(question)).decision.outcome).toBe('DENIED');
    expect((yield* f.service.scope(base)).decision).toBe('denied');
    expect(f.check.calls.checkBulk).toBe(0);
  }),
);

for (const [name, options] of [
  ['identity store', { factsFailure: true }],
  ['principal kind', { kindFailure: true }],
  ['canonical engine', { engineFailure: true }],
  ['required evidence', { evidenceFailure: true }],
] as const) {
  it.effect(`keeps ${name} outages explicitly unavailable`, () =>
    Effect.gen(function* outage() {
      const f = fixture(options);
      const result = yield* Effect.result(f.service.inspect(question));
      expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
    }),
  );
}

it.effect('returns the canonical selector-bearing LIST predicate, not a targetless execution decision', () =>
  Effect.gen(function* listProjection() {
    const listedRead = declaration({ risk: 'routine', selectors: ['assigned', 'entrusted'] });
    const f = fixture({
      cells: [
        cell({ capability: listedRead.key, holder: principalHolder(otherPerson), selector: { _tag: 'assigned' } }),
      ],
    });
    const list = yield* f.service.list({ ...question, carrier: { accessDeclaration: listedRead } });
    expect(list.decision.outcome).toBe('ALLOWED');
    expect(list.predicate).toEqual({
      groups: [{ clauses: [{ conditions: [{ _tag: 'AssignedTo', holder: principalHolder(otherPerson) }] }] }],
    });
    expect(
      (yield* f.service.inspect({ ...question, carrier: { accessDeclaration: listedRead } })).decision.reasons,
    ).toContainEqual({ code: 'deny.target_required' });
  }),
);

for (const permission of ['none', 'conditional', 'error'] as const) {
  it.effect(`company select inspection fails closed on ${permission}`, () =>
    Effect.gen(function* companySelection() {
      const result = yield* Effect.result(fixture({ permission }).service.scope(base));
      if (permission === 'none') {
        expect(Result.isSuccess(result) && result.success.decision).toBe('denied');
      } else {
        expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
      }
    }),
  );
}

it.effect('company selection uses the evaluated human rather than requester grants', () =>
  Effect.gen(function* companySelection() {
    const f = fixture();
    expect(yield* f.service.scope(base)).toEqual({
      decision: 'allowed',
      inspectionOnly: true,
      reasonCodes: ['allow.granted'],
    });
    expect(f.calls.every(({ scope }) => scope === requesterScope)).toBe(true);
  }),
);

it.effect('does not classify a service subject as human', () =>
  Effect.gen(function* workloadSubject() {
    const f = fixture({ kind: 'service' });
    const answer = yield* f.service.inspect({ ...question, subject: { principalId: agent, tenantId: tenant } });
    expect(answer.decision.outcome).toBe('DENIED');
    expect(f.check.calls.checkBulk).toBe(0);
  }),
);

it.effect('denies a module workload-only purpose without manufacturing act identity', () =>
  Effect.gen(function* workloadPurpose() {
    const actor = Result.getOrThrow(
      decodeAccessActor(
        {
          callers: ['crm'],
          reason: 'Bound CRM workload only',
          subject: 'workload',
          subjectWorkloads: ['demo.crm.party-intake'],
        },
        { access: 'write', authorization: { kind: 'protected' }, moduleKey: 'party.registry', role: 'action' },
      ),
    );
    const f = fixture();
    expect(
      (yield* f.service.inspect({ ...question, carrier: { accessActor: actor } })).decision.reasons,
    ).toContainEqual({ code: 'deny.workload_only' });
    expect(f.check.calls.checkBulk).toBe(0);
  }),
);

it.effect('keeps agent setup truthfully unavailable without one actual connection context', () =>
  Effect.gen(function* unboundAgent() {
    const f = fixture();
    const result = yield* Effect.result(
      f.service.inspect({ ...question, subject: { principalId: agent, tenantId: tenant } }),
    );
    expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
    expect(f.authority.calls.readConnection).toBe(0);
  }),
);

it.effect('validates a real agent connection and its human independently, preserving sensitive-read denial', () =>
  Effect.gen(function* sensitiveAgent() {
    const f = fixture({ connection: connect({ principalId: otherPerson }) });
    const answer = yield* f.service.inspect({ ...question, subject: agentSubject() });
    expect(answer.decision.reasons).toContainEqual({ code: 'deny.agent_sensitive_read' });
    expect(f.authority.calls.readConnection).toBeGreaterThan(0);
    expect(f.entries[0]?.actor).toEqual(
      AgentActor.make({ agentId: agent, connectionId, consentRevision: 1, principalId: otherPerson }),
    );
    expect(f.entries[0]?.scope).toBe(requesterScope);
    expect(f.entries[0]?.onBehalfOfPrincipalId).toBe(person);
  }),
);

for (const [name, connection] of [
  ['revoked', connect({ principalId: otherPerson, status: 'revoked' })],
  ['wrong human', connect({ principalId: person })],
  [
    'wrong agent',
    connect({ agentId: AgentIdSchema.make('00000000-0000-4000-8000-000000000091'), principalId: otherPerson }),
  ],
  [
    'wrong scope',
    connect({ principalId: otherPerson, scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000092') }),
  ],
] as const) {
  it.effect(`refuses ${name} connection`, () =>
    Effect.gen(function* badConnection() {
      const f = fixture({ connection });
      expect((yield* f.service.inspect({ ...question, subject: agentSubject() })).decision.outcome).toBe('DENIED');
    }),
  );
}

it.effect('rejects stale consent instead of unioning or borrowing another connection', () =>
  Effect.gen(function* staleConsent() {
    const f = fixture({ connection: connect({ consentRevision: 2, principalId: otherPerson }) });
    expect((yield* f.service.inspect({ ...question, subject: agentSubject() })).decision.reasons).toContainEqual({
      code: 'deny.consent_stale',
    });
    expect(f.authority.calls.readConnection).toBe(1);
  }),
);

it.effect('does not borrow the evaluator as the connection human', () =>
  Effect.gen(function* wrongOwner() {
    const f = fixture({ connection: connect({ principalId: otherPerson }) });
    expect(
      (yield* f.service.inspect({ ...question, subject: agentSubject({ principalId: person }) })).decision.outcome,
    ).toBe('DENIED');
  }),
);

it.effect('an actual agent can project only the intersection of human/agent cells and its one consent', () =>
  Effect.gen(function* realAgent() {
    const routine = declaration({ risk: 'routine' });
    const humanCell = cell({ capability: routine.key, holder: principalHolder(otherPerson) });
    const agentCell = cell({ capability: routine.key, holder: { _tag: 'Agent', agentId: agent } });
    const ceiling = {
      cells: [
        {
          capabilityKey: CapabilityKeySchema.make(routine.key),
          mode: 'run' as const,
          selector: { _tag: 'all' as const },
        },
      ],
    };
    const f = fixture({ cells: [humanCell, agentCell], connection: connect({ ceiling, principalId: otherPerson }) });
    expect(
      (yield* f.service.inspect({ ...question, carrier: { accessDeclaration: routine }, subject: agentSubject() }))
        .decision.outcome,
    ).toBe('ALLOWED');
    const incomplete = fixture({ cells: [humanCell], connection: connect({ ceiling, principalId: otherPerson }) });
    expect(
      (yield* incomplete.service.inspect({
        ...question,
        carrier: { accessDeclaration: routine },
        subject: agentSubject(),
      })).decision.outcome,
    ).toBe('DENIED');
  }),
);

it.effect('projects Action run and propose modes separately and never executes an Action', () =>
  Effect.gen(function* actionModes() {
    const action = declaration({
      key: 'party.registry.party.change',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      risk: 'sensitive',
    });
    const f = fixture({
      cells: [cell({ capability: action.key, holder: principalHolder(otherPerson), mode: 'propose' })],
    });
    f.actions.set('party.registry.change-party', {
      actionKey: 'party.registry.change-party',
      carrier: { accessDeclaration: action },
      legalEntityScope: 'required',
    });
    expect(
      yield* f.service.actions({ ...base, actionKeys: ['party.registry.change-party', 'unknown.action'] }),
    ).toEqual({
      authorities: [
        { actionKey: 'party.registry.change-party', propose: 'allowed', run: 'denied' },
        { actionKey: 'unknown.action', propose: 'denied', run: 'denied' },
      ],
      inspectionOnly: true,
    });
    expect(f.entries.every(({ actor, scope }) => actor.principalId === otherPerson && scope === requesterScope)).toBe(
      true,
    );
  }),
);

it.effect('does not claim a run-only Action can be proposed', () =>
  Effect.gen(function* runOnly() {
    const action = declaration({ key: 'party.registry.party.touch', kind: 'action', modes: ['run'], risk: 'routine' });
    const f = fixture({ cells: [cell({ capability: action.key, holder: principalHolder(otherPerson) })] });
    f.actions.set('party.registry.touch-party', {
      actionKey: 'party.registry.touch-party',
      carrier: { accessDeclaration: action },
      legalEntityScope: 'required',
    });
    expect((yield* f.service.actions({ ...base, actionKeys: ['party.registry.touch-party'] })).authorities).toEqual([
      { actionKey: 'party.registry.touch-party', propose: 'denied', run: 'allowed' },
    ]);
  }),
);

it.effect('refuses an unavailable or changed composition rather than disclose stale projection', () =>
  Effect.gen(function* currentness() {
    let reads = 0;
    const f = fixture({
      catalog: Effect.sync(() => {
        reads += 1;
        return { actions: new Map(), revision: reads === 1 ? 'before' : 'after' };
      }),
    });
    const result = yield* Effect.result(f.service.inspect(question));
    expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
    const down = fixture({ catalog: Effect.fail(new SubjectInspectionUnavailable({ reason: 'composition down' })) });
    expect(Result.isFailure(yield* Effect.result(down.service.inspect(question)))).toBe(true);
    expect(down.calls).toEqual([]);
  }),
);

for (const [name, queryScope] of [
  ['another company', { legalEntityId: differentTenant, tenantId: tenant }],
  ['another tenant', { legalEntityId: company, tenantId: differentTenant }],
  ['an omitted selected company', { tenantId: tenant }],
] as const) {
  it.effect(`refuses query scope for ${name} before subject I/O instead of overriding requester`, () =>
    Effect.gen(function* mismatchedQuery() {
      const f = fixture();
      const result = yield* Effect.result(f.service.inspect({ ...question, queryScope }));
      expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
      expect(f.calls).toEqual([]);
    }),
  );
}

it.effect('does not silently change a company query to tenant scope for owner selection', () =>
  Effect.gen(function* companyQuery() {
    const f = fixture();
    const result = yield* Effect.result(f.service.scope({ ...base, queryScope: { tenantId: tenant } }));
    expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
    expect(f.calls).toEqual([]);
  }),
);

it.effect('does not use LIST to evade a sensitive field parent-read requirement', () =>
  Effect.gen(function* fieldParent() {
    const field = declaration({
      fieldClass: 'personal_data',
      key: 'party.registry.party.personal-data',
      kind: 'field_read',
    });
    const f = fixture({ cells: [cell({ capability: field.key, holder: principalHolder(otherPerson) })] });
    const input = { ...question, carrier: { accessDeclaration: field } };
    expect((yield* f.service.inspect(input)).decision.reasons).toContainEqual({ code: 'deny.parent_read_required' });
    expect((yield* f.service.list(input)).decision.outcome).toBe('DENIED');
  }),
);

it.effect('rejects a human that supplies agent consent metadata instead of treating it as authentication', () =>
  Effect.gen(function* humanWithAgentContext() {
    const f = fixture();
    expect(
      (yield* f.service.inspect({
        ...question,
        subject: { ...subject, agentContext: { connectionId, consentRevision: 1, principalId: person } },
      })).decision.outcome,
    ).toBe('DENIED');
    expect(f.authority.calls.readConnection).toBe(0);
  }),
);

it.effect('denies an agent whose actual consent owner is not a persisted human', () =>
  Effect.gen(function* nonHumanConsentOwner() {
    const f = fixture({ connection: connect({ principalId: otherPerson }), ownerKind: 'service' });
    expect((yield* f.service.inspect({ ...question, subject: agentSubject() })).decision.outcome).toBe('DENIED');
    expect(f.authority.calls.readConnection).toBe(0);
  }),
);

it.effect('does not synthesize a usable agent context by unioning incomplete persisted connections', () =>
  Effect.gen(function* noContextUnion() {
    const otherConnectionId = AgentConnectionIdSchema.make('00000000-0000-4000-8000-000000000096');
    const wrongAgentId = AgentIdSchema.make('00000000-0000-4000-8000-000000000097');
    const f = fixture({
      connections: [
        connect({ agentId: wrongAgentId, principalId: otherPerson }),
        connect({ connectionId: otherConnectionId, principalId: person }),
      ],
    });
    expect((yield* f.service.inspect({ ...question, subject: agentSubject() })).decision.outcome).toBe('DENIED');
    expect(
      (yield* f.service.inspect({ ...question, subject: agentSubject({ connectionId: otherConnectionId }) })).decision
        .outcome,
    ).toBe('DENIED');
    expect(f.connectionQueries.map(({ connectionId: id }) => id)).toEqual([connectionId, otherConnectionId]);
    expect(f.check.calls.checkBulk).toBe(0);
  }),
);

it.effect('does not use an OAuth grant identifier as a registered agent connection', () =>
  Effect.gen(function* grantIsNotConnection() {
    const f = fixture({ connection: connect({ principalId: otherPerson }) });
    const missingConnection = '00000000-0000-4000-8000-000000000098';
    expect(
      (yield* f.service.inspect({ ...question, subject: agentSubject({ connectionId: missingConnection }) })).decision
        .reasons,
    ).toContainEqual({ code: 'deny.connection_inactive' });
    expect(f.connectionQueries).toEqual([{ connectionId: missingConnection, tenantId: tenant }]);
  }),
);

it.effect('preserves interruption without returning a projection or writing decision evidence', () =>
  Effect.gen(function* interruptedIdentity() {
    const f = fixture({ factsInterrupted: true });
    const exit = yield* Effect.exit(f.service.inspect(question));
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(f.entries).toEqual([]);
    expect(f.check.calls.checkBulk).toBe(0);
  }),
);

const listedRead = declaration({ key: 'party.registry.party.list', risk: 'routine', selectors: ['assigned'] });
const deniedRead = declaration({ key: 'party.registry.party.secret' });
const fieldRead = declaration({
  fieldClass: 'personal_data',
  key: 'party.registry.party.personal-data',
  kind: 'field_read',
});
const changeAction = declaration({ key: 'party.registry.party.change', kind: 'action', modes: ['run', 'propose'] });
/** The subject's cells, built once so every fixture of a comparison holds the very same grants. */
const batchCells = [
  cell({ capability: read.key, holder: principalHolder(otherPerson) }),
  cell({ capability: listedRead.key, holder: principalHolder(otherPerson), selector: { _tag: 'assigned' } }),
  cell({ capability: fieldRead.key, holder: principalHolder(otherPerson) }),
  cell({ capability: changeAction.key, holder: principalHolder(otherPerson), mode: 'propose' }),
];

/** A mixed batch: every seam refusal, an allow, a denial, a LIST, a field question and a sensitive Action. */
const batchOf = (options: FixtureOptions = {}) => {
  const field = fieldRead;
  const action = changeAction;
  const questions = [
    { carrier: { accessDeclaration: read }, legalEntityScope: 'required', listing: false },
    { carrier: { accessDeclaration: deniedRead }, legalEntityScope: 'required', listing: false },
    { carrier: { accessDeclaration: listedRead }, legalEntityScope: 'required', listing: true },
    { carrier: { accessDeclaration: listedRead }, legalEntityScope: 'required', listing: false },
    { carrier: { accessDeclaration: field }, legalEntityScope: 'required', listing: false },
    { carrier: { accessDeclaration: field }, legalEntityScope: 'required', listing: true },
    { carrier: { accessDeclaration: action }, legalEntityScope: 'required', listing: true },
    { carrier: {}, legalEntityScope: 'required', listing: false },
    { carrier: { accessDeclaration: read }, legalEntityScope: 'forbidden', listing: false },
    { carrier: { accessDeclaration: read }, legalEntityScope: 'optional', listing: false },
    { carrier: { accessDeclaration: action }, legalEntityScope: 'required', listing: false, mode: 'propose' },
  ] as const;
  const f = fixture({ cells: batchCells, ...options });
  f.actions.set('party.registry.change-party', {
    actionKey: 'party.registry.change-party',
    carrier: { accessDeclaration: action },
    legalEntityScope: 'required',
  });
  return { f, questions };
};

/** What one decision row says, without the instant it was taken at: each single call takes its own. */
const rowOf = ({ decidedAt: _decidedAt, ...entry }: AccessDecisionLogEntry) => entry;

it.effect('answers and records every batch question exactly as the single inspect, list and actions calls do', () =>
  Effect.gen(function* batchEquivalence() {
    const single = batchOf();
    const singleAnswers = yield* Effect.forEach(
      single.questions,
      ({ listing, ...rest }) => {
        const asked = { ...base, ...rest };
        return listing
          ? single.f.service.list(asked).pipe(Effect.map(({ inspectionOnly: _inspectionOnly, ...answer }) => answer))
          : single.f.service.inspect(asked).pipe(Effect.map(({ decision }) => ({ decision })));
      },
      { concurrency: 1 },
    );
    const singleActions = yield* single.f.service.actions({
      ...base,
      actionKeys: ['party.registry.change-party', 'unknown.action'],
    });
    const batched = batchOf();
    const batch = yield* batched.f.service.capabilities({
      ...base,
      actionKeys: ['party.registry.change-party', 'unknown.action'],
      questions: batched.questions,
    });
    expect(batch.answers).toEqual(singleAnswers);
    expect(batch.authorities).toEqual(singleActions.authorities);
    // Every row a single call writes is written by the batch too, with the same content and in the same order.
    expect(batched.f.entries.map(rowOf)).toEqual(single.f.entries.map(rowOf));
    expect(batched.f.entries.length).toBeGreaterThan(3);
    // ...all of it in one write, where the single calls needed one write per recorded inspect/list decision.
    expect(batched.f.evidenceBatches).toEqual([batched.f.entries.length]);
    expect(single.f.evidenceBatches.length).toBeGreaterThan(1);
    expect(single.f.evidenceBatches.reduce((sum, size) => sum + size, 0)).toBe(batched.f.entries.length);
    // Each outcome kind is present, so the comparison covers allows, denials, refusals and a LIST predicate.
    expect(new Set(batch.answers.map(({ decision }) => decision.outcome))).toEqual(new Set(['ALLOWED', 'DENIED']));
    expect(batch.answers[2]?.predicate).toBeDefined();
    expect(batch.answers.map(({ decision }) => decision.reasons[0]?.code)).toEqual(
      singleAnswers.map(({ decision }) => decision.reasons[0]?.code),
    );
  }),
);

it.effect('resolves the subject once per company context and asks the engine once for a whole batch', () =>
  Effect.gen(function* batchReads() {
    const { f, questions } = batchOf();
    yield* f.service.capabilities({ ...base, actionKeys: ['party.registry.change-party'], questions });
    const ports = f.calls.map(({ port }) => port);
    // Two contexts are asked about: the company (required) and the tenant (optional resolves to the company here).
    expect(ports.filter((port) => port === 'facts').length).toBeLessThanOrEqual(2);
    expect(ports.filter((port) => port === 'kind').length).toBeLessThanOrEqual(2);
    // One snapshot for every targetless question, plus one per LIST question.
    expect(f.check.calls.checkBulk).toBeLessThanOrEqual(1 + questions.filter(({ listing }) => listing).length);
    expect(f.calls.every(({ scope }) => scope === requesterScope)).toBe(true);
  }),
);

for (const [name, options] of [
  ['identity store', { factsFailure: true }],
  ['principal kind', { kindFailure: true }],
  ['canonical engine', { engineFailure: true }],
  ['required evidence', { evidenceFailure: true }],
] as const) {
  it.effect(`fails a whole batch on a ${name} outage instead of answering any question`, () =>
    Effect.gen(function* batchOutage() {
      const { f, questions } = batchOf(options);
      const result = yield* Effect.result(
        f.service.capabilities({ ...base, actionKeys: ['party.registry.change-party'], questions }),
      );
      expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
    }),
  );
}

it.effect('reads a batch against one composition revision and refuses a batch whose composition changed', () =>
  Effect.gen(function* batchCurrentness() {
    let revision = 0;
    const { questions } = batchOf();
    const changing = batchOf({
      catalog: Effect.sync(() => {
        revision += 1;
        return { actions: new Map(), revision: `revision-${revision}` };
      }),
    });
    const result = yield* Effect.result(changing.f.service.capabilities({ ...base, actionKeys: [], questions }));
    expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
  }),
);
