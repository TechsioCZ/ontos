import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import type { AccessDecision, DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import type { AuthorityDeadline, ResolvedAccessScope } from '../../src/access/decision/authority.ts';
import { decideAccess, decideAccessMany } from '../../src/access/decision/engine.ts';
import { explainAccess } from '../../src/access/decision/explain.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import type { AccessScopeId, CapabilityKey } from '../../src/access/ids.ts';
import { AccessScopeIdSchema, DelegationIdSchema, LegalEntityIdSchema, RoleIdSchema } from '../../src/access/ids.ts';
import type { AccessScope, Delegation } from '../../src/access/model.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import type { AccessDeclaration, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import {
  agent,
  at,
  capability,
  cell,
  connectionId,
  makeAuthority,
  makeCheck,
  otherPerson,
  person,
  scopeId,
  tenant,
} from './access-decision-support.ts';

/*
 * O81 replaces adoption for administration: the same gate decides an `admin` key through a
 * structural branch, with one shared `configureBasesOf` basis — the tenant owner, a company access
 * administrator, or a live delegation — while role cells stay a union beside it. These suites hold the
 * branch to that exact envelope: live intent only, the target scope only, people only, and UNAVAILABLE
 * wherever the intent source cannot answer.
 */

const now = at('2026-11-03T12:00:00Z');
const adminKey: CapabilityKey = capability('core.access.roles.publish');
const otherKey: CapabilityKey = capability('core.access.people.revoke');
const companyA = LegalEntityIdSchema.make('00000000-0000-4000-8000-000000000101');
const companyB = LegalEntityIdSchema.make('00000000-0000-4000-8000-000000000102');
const scopeA = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000103');
const scopeB = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000104');
const tenantScope = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000105');
const delegationId = DelegationIdSchema.make('00000000-0000-4000-8000-000000000106');
const roleId = RoleIdSchema.make('00000000-0000-4000-8000-000000000107');

const policy: DecisionCapabilityPolicy = {
  capabilityKey: adminKey,
  kind: 'admin',
  modes: ['run'],
  risk: 'critical',
  selectors: [],
};

/**
 * An administration SURFACE (O88): the declaration of an admin page, decoded by the same carrier
 * rules every page descriptor passes. The marker reaches the engine only through
 * `capabilityPolicyOf`, so no test here forges a policy field to stand in for a declaration.
 */
const PAGE_OWNER = {
  access: 'read',
  authorization: { kind: 'protected' },
  moduleKey: 'shell-super-app',
  role: 'page',
} as const;
const surfaceKey: CapabilityKey = capability('shell-super-app.access-admin.people');
const surfaceDeclaration = (overrides: Partial<AccessDeclarationInput> = {}): AccessDeclaration =>
  decodeAccessDeclarationOrThrow(
    {
      admitsAdminSurface: true,
      key: surfaceKey,
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'access', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
      ...overrides,
    },
    PAGE_OWNER,
  );
const surfacePolicy = (overrides: Partial<AccessDeclarationInput> = {}): DecisionCapabilityPolicy =>
  capabilityPolicyOf(surfaceDeclaration(overrides));
const tenantContext: AccessScope = { _tag: 'TenantContext', tenantId: tenant };
const companyScopeOf = (legalEntityId: typeof companyA): AccessScope => ({
  _tag: 'LegalEntity',
  legalEntityId,
  tenantId: tenant,
});
const actorIn = (legalEntityId?: typeof companyA) =>
  withOptional(
    { actor: { _tag: 'Principal' as const, principalId: person }, tenantId: tenant },
    'legalEntityId',
    legalEntityId,
  );

const owner: AccessConfigureBasis = { _tag: 'Owner' };
const companyAdmin: AccessConfigureBasis = {
  _tag: 'ScopeAdmin',
  deadlines: [{ legalEntityId: companyA, until: at('2026-12-01T00:00:00Z') }],
  legalEntityIds: [companyA],
  // A tenant access-admin membership never widens O81's tenant admission; it is only carried here.
  tenantContext: true,
};
const delegation: AccessConfigureBasis = {
  _tag: 'DelegatedManager',
  delegation: {
    capabilityKeys: [adminKey],
    grantedBy: otherPerson,
    id: delegationId,
    managerId: person,
    people: [otherPerson],
    roleIds: [roleId],
    scopeId: scopeA,
    status: 'active',
    tenantId: tenant,
    validFrom: at('2026-10-01T00:00:00Z'),
    validUntil: at('2026-11-04T00:00:00Z'),
  },
  scope: { id: scopeA, scope: companyScopeOf(companyA) },
};

interface CaseSpec {
  readonly actor?: ReturnType<typeof actorIn>;
  readonly bases?: readonly AccessConfigureBasis[];
  readonly key?: CapabilityKey;
  readonly membershipDeadlines?: readonly AuthorityDeadline[];
  readonly policy?: DecisionCapabilityPolicy;
  readonly resolvedScope?: AccessScope;
  readonly resolvedScopeId?: AccessScopeId;
  readonly unavailable?: boolean;
}

/** One decision in one resolved scope, over live configure bases and role cells together. */
const decide = (spec: CaseSpec = {}) => {
  const authority = makeAuthority(
    withOptional(
      withOptional(
        withOptional(
          withOptional(
            withOptional({ cells: [] as const }, 'configureBases', spec.bases),
            'configureUnavailable',
            spec.unavailable,
          ),
          'legalEntityScope',
          spec.resolvedScope,
        ),
        'membershipDeadlines',
        spec.membershipDeadlines,
      ),
      'resolvedScopeId',
      spec.resolvedScopeId,
    ),
  );
  const check = makeCheck({ authority: { cells: [] } });
  const base = spec.policy ?? policy;
  return Effect.map(
    decideAccess(authority.port, check.port, {
      actor: spec.actor ?? actorIn(),
      now,
      request: {
        capability: spec.key === undefined ? base : { ...base, capabilityKey: spec.key },
        mode: 'run',
      },
    }),
    (decision) => ({ authority, check, decision }),
  );
};

it.effect('admits an owner on a newly published admin key with no adopted cell in tenant or company', () =>
  Effect.gen(function* ownerAdmission() {
    const cases = [
      { resolvedScope: tenantContext, resolvedScopeId: tenantScope },
      { resolvedScope: companyScopeOf(companyA), resolvedScopeId: scopeA },
      { resolvedScope: companyScopeOf(companyB), resolvedScopeId: scopeB },
    ];
    for (const one of cases) {
      const { check, decision } = yield* decide({ ...one, bases: [owner] });
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.evidence).toEqual([]);
      expect(decision.structuralEvidence?.basis).toBe('owner');
      expect(explainAccess({ decision, policy }).reasonCodes).toEqual(['structural.owner']);
      // No role cell took part: the answer is the structural branch alone.
      expect(check.calls.checkBulk).toBe(0);
    }
  }),
);

it.effect('admits a company admin only in their own company, never the tenant or another company', () =>
  Effect.gen(function* companyAdminBoundary() {
    const own = yield* decide({
      actor: actorIn(companyA),
      bases: [companyAdmin],
      resolvedScope: companyScopeOf(companyA),
      resolvedScopeId: scopeA,
    });
    expect(own.decision.outcome).toBe('ALLOWED');
    expect(own.decision.admissionDeadline).toEqual(at('2026-12-01T00:00:00Z'));
    expect(explainAccess({ decision: own.decision, policy }).structuralAuthority?.basis).toBe('access_admin');

    const otherCompany = yield* decide({
      actor: actorIn(companyB),
      bases: [companyAdmin],
      resolvedScope: companyScopeOf(companyB),
      resolvedScopeId: scopeB,
    });
    // No access-admin power in company B: the company's cells decide, and there are none.
    expect(otherCompany.decision.outcome).toBe('DENIED');
    expect(otherCompany.decision.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');

    // An UNMARKED tenant-context admin key stays refused to a company administrator: O88's surface
    // admission needs the declaration's own marker, so an operation never inherits it.
    const tenantAnswer = yield* decide({ bases: [companyAdmin], resolvedScope: tenantContext });
    expect(tenantAnswer.decision.outcome).toBe('DENIED');
  }),
);

it.effect('admits a delegation only inside its scope and envelope, and never after it lapses', () =>
  Effect.gen(function* delegationBoundary() {
    const inside = yield* decide({
      actor: actorIn(companyA),
      bases: [delegation],
      resolvedScope: companyScopeOf(companyA),
      resolvedScopeId: scopeA,
    });
    expect(inside.decision.outcome).toBe('ALLOWED');
    expect(inside.decision.admissionDeadline).toEqual(at('2026-11-04T00:00:00Z'));
    expect(inside.decision.structuralEvidence?.delegationId).toBe(delegationId);
    expect(explainAccess({ decision: inside.decision, policy }).reasonCodes).toEqual(['structural.delegation']);

    const anotherCompany = yield* decide({
      actor: actorIn(companyB),
      bases: [delegation],
      resolvedScope: companyScopeOf(companyB),
      resolvedScopeId: scopeB,
    });
    expect(anotherCompany.decision.outcome).toBe('DENIED');

    // A key outside the envelope is a new decision, so the delegation proves nothing (D10, P8).
    const outsideKey = yield* decide({
      actor: actorIn(companyA),
      bases: [delegation],
      key: otherKey,
      resolvedScope: companyScopeOf(companyA),
      resolvedScopeId: scopeA,
    });
    expect(outsideKey.decision.outcome).toBe('DENIED');
  }),
);

it.effect('refuses a delegation whose own end date has passed', () =>
  Effect.gen(function* lapsedDelegation() {
    const expired = {
      _tag: 'DelegatedManager' as const,
      delegation: { ...delegation.delegation, validUntil: at('2026-11-03T12:00:00Z') },
      scope: { id: scopeA, scope: companyScopeOf(companyA) },
    };
    const answer = yield* decide({
      actor: actorIn(companyA),
      bases: [expired],
      resolvedScope: companyScopeOf(companyA),
      resolvedScopeId: scopeA,
    });
    expect(answer.decision.outcome).toBe('DENIED');
    expect(answer.decision.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
  }),
);

it.effect('keeps role cells beside the structural branch and refuses ordinary members', () =>
  Effect.gen(function* roleCellUnion() {
    const granted = cell({ capability: adminKey });
    const authority = makeAuthority({ cells: [granted] });
    const check = makeCheck({ authority: { cells: [granted] } });
    const throughRole = yield* decideAccess(authority.port, check.port, {
      actor: actorIn(),
      now,
      request: { capability: policy, mode: 'run' },
    });
    expect(throughRole.outcome).toBe('ALLOWED');
    expect(throughRole.reasons.map(({ code }) => code)).toContain('allow.granted');
    expect(throughRole.structuralEvidence).toBeUndefined();

    const ordinary = yield* decide();
    expect(ordinary.decision.outcome).toBe('DENIED');
  }),
);

it.effect('never admits an agent to an admin key and never reads the configure bases for one', () =>
  Effect.gen(function* agentRefusal() {
    const authority = makeAuthority({
      cells: [],
      configureBases: [owner],
      connection: {
        agentId: agent,
        ceiling: { cells: [] },
        connectionId,
        consentRevision: 1,
        deadline: at('2027-01-01T00:00:00Z'),
        principalId: person,
        scopeId,
        status: 'active',
      },
    });
    const answer = yield* decideAccess(authority.port, makeCheck({ authority: { cells: [] } }).port, {
      actor: {
        actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision: 1, principalId: person },
        tenantId: tenant,
      },
      now,
      request: { capability: policy, mode: 'run' },
    });
    expect(answer.outcome).toBe('DENIED');
    expect(answer.reasons.map(({ code }) => code)).toContain('deny.agent_forbidden');
    expect(authority.calls.readConfigureBases).toBe(0);
  }),
);

it.effect('never allows an unreadable configure source, even when a role cell grants the key', () =>
  Effect.gen(function* unreadableIntent() {
    const granted = cell({ capability: adminKey });
    const authority = makeAuthority({ cells: [granted], configureUnavailable: true });
    const answer = yield* decideAccess(authority.port, makeCheck({ authority: { cells: [granted] } }).port, {
      actor: actorIn(),
      now,
      request: { capability: policy, mode: 'run' },
    });
    expect(answer.outcome).toBe('UNAVAILABLE');
    expect(answer.reasons.map(({ code }) => code)).toContain('unavailable.intent');
  }),
);

it.effect('treats a composition without the configure-bases port as unavailable, never as a denial', () =>
  Effect.gen(function* missingPort() {
    const authority = makeAuthority({ cells: [] });
    const { readConfigureBases: _configureBases, ...cellOnly } = authority.port;
    const answer = yield* decideAccess(cellOnly, makeCheck({ authority: { cells: [] } }).port, {
      actor: actorIn(),
      now,
      request: { capability: policy, mode: 'run' },
    });
    expect(answer.outcome).toBe('UNAVAILABLE');
    expect(answer.reasons.map(({ code }) => code)).toContain('unavailable.intent');
  }),
);

/** Everything one answer can be compared on, without depending on how it was produced. */
const verdictOf = (decision: AccessDecision) => ({
  admissionDeadline: decision.admissionDeadline,
  outcome: decision.outcome,
  reasons: decision.reasons.map(({ code }) => code),
  selectors: decision.selectors.map(({ selector, side }) => `${side}:${selector}`),
  structuralBasis: decision.structuralEvidence?.basis,
});

it.effect('answers a structural and a role-cell admin key in one batch exactly as one request each', () =>
  Effect.gen(function* structuralBatch() {
    // The envelope names the admin key only, so the second key is decided by its own role cell in the
    // same batch: the structural branch can neither steal nor widen that answer.
    const granted = cell({ capability: otherKey });
    const inScope: AccessConfigureBasis = {
      _tag: 'DelegatedManager',
      delegation: { ...delegation.delegation, scopeId },
      scope: { id: scopeId, scope: companyScopeOf(companyA) },
    };
    const bases: readonly AccessConfigureBasis[] = [inScope];
    const spec = withOptional(
      { cells: [granted], legalEntityScope: companyScopeOf(companyA) },
      'configureBases',
      bases,
    );
    const requests = [policy, { ...policy, capabilityKey: otherKey }].map((one) => ({
      actor: actorIn(companyA),
      now,
      request: { capability: one, mode: 'run' as const },
    }));
    const [answers] = yield* decideAccessMany(makeCheck({ authority: spec }).port, [
      { authority: makeAuthority(spec).port, inputs: requests },
    ]);
    const single = yield* Effect.forEach(
      requests,
      (input) => decideAccess(makeAuthority(spec).port, makeCheck({ authority: spec }).port, input),
      { concurrency: 1 },
    );
    expect(answers?.map(verdictOf)).toEqual(single.map(verdictOf));
    expect(answers?.map(({ reasons }) => reasons[0]?.code)).toEqual(['structural.delegation', 'allow.granted']);
  }),
);

it.effect("reads one actor's configure bases once per batch, however many admin keys it asks", () =>
  Effect.gen(function* sharedConfigureBases() {
    const spec = withOptional({ cells: [] as const, legalEntityScope: companyScopeOf(companyA) }, 'configureBases', [
      owner,
    ] as const);
    const keys = ['core.access.roles.publish', 'core.access.people.revoke', 'core.access.roles.archive'];
    const requests = keys.map((key) => ({
      actor: actorIn(companyA),
      now,
      request: { capability: { ...policy, capabilityKey: capability(key) }, mode: 'run' as const },
    }));
    const batchAuthority = makeAuthority(spec);
    const [answers] = yield* decideAccessMany(makeCheck({ authority: spec }).port, [
      { authority: batchAuthority.port, inputs: requests },
    ]);
    const single = yield* Effect.forEach(
      requests,
      (input) => decideAccess(makeAuthority(spec).port, makeCheck({ authority: spec }).port, input),
      { concurrency: 1 },
    );
    expect(answers?.map(verdictOf)).toEqual(single.map(verdictOf));
    expect(answers?.map(({ reasons }) => reasons[0]?.code)).toEqual(keys.map(() => 'structural.owner'));
    // The same actor, tenant and instant: one read for the whole batch, shared with no other batch.
    expect(batchAuthority.calls.readConfigureBases).toBe(1);
    yield* decideAccessMany(makeCheck({ authority: spec }).port, [
      { authority: batchAuthority.port, inputs: requests },
    ]);
    expect(batchAuthority.calls.readConfigureBases).toBe(2);
  }),
);

/*
 * O88: entering the administration surface. A person who administers access in at least one company
 * of the tenant may open the admin pages without having selected a company, and every operation keeps
 * its own key and its own scope — the surface admission is never tenant authority, never another
 * company's authority, and never a mutation.
 */

/** A delegation that manages the tenant context itself, not one company. */
const tenantDelegationValue: Delegation = {
  capabilityKeys: [surfaceKey],
  grantedBy: otherPerson,
  id: delegationId,
  managerId: person,
  people: [otherPerson],
  roleIds: [roleId],
  scopeId: tenantScope,
  status: 'active',
  tenantId: tenant,
  validFrom: at('2026-10-01T00:00:00Z'),
  validUntil: at('2026-11-04T00:00:00Z'),
};
const tenantDelegation: AccessConfigureBasis = {
  _tag: 'DelegatedManager',
  delegation: tenantDelegationValue,
  scope: { id: tenantScope, scope: tenantContext },
};

const surfaceCase = (spec: CaseSpec = {}) =>
  decide({ policy: surfacePolicy(), resolvedScope: tenantContext, resolvedScopeId: tenantScope, ...spec });

it.effect('admits a company administrator to the marked administration surface in the tenant context', () =>
  Effect.gen(function* surfaceAdmission() {
    const answer = yield* surfaceCase({ bases: [companyAdmin] });
    expect(answer.decision.outcome).toBe('ALLOWED');
    expect(answer.decision.evidence).toEqual([]);
    expect(answer.decision.selectors).toEqual([]);
    expect(answer.decision.reasons.map(({ code }) => code)).toEqual(['structural.access_admin_any']);
    expect(answer.decision.structuralEvidence).toEqual({
      basis: 'access_admin_any',
      deadline: at('2026-12-01T00:00:00Z'),
      scopeId: tenantScope,
    });
    // The structural branch alone answered: no company's cells were consulted for this admission.
    expect(answer.check.calls.checkBulk).toBe(0);
    expect(explainAccess({ decision: answer.decision, policy: surfacePolicy() }).structuralAuthority).toEqual({
      basis: 'access_admin_any',
      deadline: at('2026-12-01T00:00:00Z'),
      scopeId: tenantScope,
    });
  }),
);

it.effect('never turns the surface admission into authority over a company, an operation or a tenant role', () =>
  Effect.gen(function* surfaceBoundary() {
    // The same administrator in their own company is admitted by O81's exact basis, not by O88.
    const own = yield* decide({
      actor: actorIn(companyA),
      bases: [companyAdmin],
      policy: surfacePolicy(),
      resolvedScope: companyScopeOf(companyA),
      resolvedScopeId: scopeA,
    });
    expect(own.decision.outcome).toBe('ALLOWED');
    expect(own.decision.structuralEvidence?.basis).toBe('access_admin');

    // Another company's data or roles: the marker is no authority there, whatever the surface says.
    const foreign = yield* decide({
      actor: actorIn(companyB),
      bases: [companyAdmin],
      policy: surfacePolicy(),
      resolvedScope: companyScopeOf(companyB),
      resolvedScopeId: scopeB,
    });
    expect(foreign.decision.outcome).toBe('DENIED');
    expect(foreign.decision.structuralEvidence).toBeUndefined();

    // A tenant-level operation is the same declaration without the marker: it stays closed.
    const tenantOperation = yield* decide({
      bases: [companyAdmin],
      key: otherKey,
      resolvedScope: tenantContext,
      resolvedScopeId: tenantScope,
    });
    expect(tenantOperation.decision.outcome).toBe('DENIED');
    expect(tenantOperation.decision.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
    // The ordinary path was taken: the surface branch answered nothing and the cells were asked.
    expect(tenantOperation.decision.structuralEvidence).toBeUndefined();
    expect(tenantOperation.authority.calls.readCells).toBeGreaterThan(0);
  }),
);

it.effect('refuses the surface to a person with no live administration in any company', () =>
  Effect.gen(function* noCompanyPower() {
    const noBases = yield* surfaceCase();
    expect(noBases.decision.outcome).toBe('DENIED');
    expect(noBases.decision.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');

    // A revoked or suspended membership never reaches the basis: the loader keeps only live rows.
    const noLiveCompany = yield* surfaceCase({
      bases: [{ _tag: 'ScopeAdmin', deadlines: [], legalEntityIds: [], tenantContext: false }],
    });
    expect(noLiveCompany.decision.outcome).toBe('DENIED');

    // A tenant-context access-admin membership is not a company, so it is not O88's surface power.
    const tenantOnly = yield* surfaceCase({
      bases: [{ _tag: 'ScopeAdmin', legalEntityIds: [], tenantContext: true }],
    });
    expect(tenantOnly.decision.outcome).toBe('DENIED');

    // An access-admin membership that has already ended is not live at this instant.
    const ended = yield* surfaceCase({
      bases: [
        {
          _tag: 'ScopeAdmin',
          deadlines: [{ legalEntityId: companyA, until: now }],
          legalEntityIds: [companyA],
          tenantContext: false,
        },
      ],
    });
    expect(ended.decision.outcome).toBe('DENIED');
    expect(ended.decision.structuralEvidence).toBeUndefined();
  }),
);

it.effect('refuses the surface to a person who is not a live member of the tenant at all', () =>
  Effect.gen(function* nonMember() {
    // An access-admin row is management authority on top of membership, never instead of it (O28):
    // the scope read proves the membership, and here it proves nothing.
    const authority = makeAuthority({ cells: [], configureBases: [companyAdmin] });
    const withoutMembership = {
      ...authority.port,
      readScope: () => Effect.succeed(Option.none<ResolvedAccessScope>()),
    };
    const answer = yield* decideAccess(withoutMembership, makeCheck({ authority: { cells: [] } }).port, {
      actor: actorIn(),
      now,
      request: { capability: surfacePolicy(), mode: 'run' },
    });
    expect(answer.outcome).toBe('DENIED');
    expect(answer.reasons.map(({ code }) => code)).toEqual(['deny.scope_mismatch']);
    expect(answer.structuralEvidence).toBeUndefined();

    // A tenant membership that has ended is refused the same way.
    const ended = yield* surfaceCase({
      bases: [companyAdmin],
      membershipDeadlines: [{ source: 'membership', until: now }],
    });
    expect(ended.decision.outcome).toBe('DENIED');
    expect(ended.decision.reasons.map(({ code }) => code)).toContain('deny.deadline_passed');
  }),
);

it.effect('admits a tenant delegation to the surface only inside its own envelope', () =>
  Effect.gen(function* tenantDelegationBoundary() {
    const inside = yield* surfaceCase({ bases: [tenantDelegation] });
    expect(inside.decision.outcome).toBe('ALLOWED');
    expect(inside.decision.structuralEvidence?.basis).toBe('delegation');
    expect(inside.decision.structuralEvidence?.delegationId).toBe(delegationId);

    // The envelope names other keys, so the surface key is a new decision, never an inherited one.
    const outsideEnvelope = yield* surfaceCase({
      bases: [
        {
          _tag: 'DelegatedManager',
          delegation: { ...tenantDelegationValue, capabilityKeys: [otherKey] },
          scope: { id: tenantScope, scope: tenantContext },
        },
      ],
    });
    expect(outsideEnvelope.decision.outcome).toBe('DENIED');
    expect(outsideEnvelope.decision.structuralEvidence).toBeUndefined();
  }),
);

it.effect('keeps role cells beside the surface branch and never admits an agent or a workload', () =>
  Effect.gen(function* surfaceOutsiders() {
    // A saved cell on the surface key still answers by itself when no company power exists.
    const granted = cell({ capability: surfaceKey });
    const throughRole = yield* decideAccess(
      makeAuthority({ cells: [granted] }).port,
      makeCheck({ authority: { cells: [granted] } }).port,
      {
        actor: actorIn(),
        now,
        request: { capability: surfacePolicy(), mode: 'run' },
      },
    );
    expect(throughRole.outcome).toBe('ALLOWED');
    expect(throughRole.reasons.map(({ code }) => code)).toContain('allow.granted');
    expect(throughRole.structuralEvidence).toBeUndefined();

    const agentAuthority = makeAuthority({
      cells: [],
      configureBases: [companyAdmin],
      connection: {
        agentId: agent,
        ceiling: { cells: [] },
        connectionId,
        consentRevision: 1,
        deadline: at('2027-01-01T00:00:00Z'),
        principalId: person,
        scopeId,
        status: 'active',
      },
    });
    const agentAnswer = yield* decideAccess(agentAuthority.port, makeCheck({ authority: { cells: [] } }).port, {
      actor: {
        actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision: 1, principalId: person },
        tenantId: tenant,
      },
      now,
      request: { capability: surfacePolicy(), mode: 'run' },
    });
    expect(agentAnswer.outcome).toBe('DENIED');
    expect(agentAnswer.reasons.map(({ code }) => code)).toContain('deny.agent_forbidden');
    // Administration is people only, so an agent never even reads the configure source (O81).
    expect(agentAuthority.calls.readConfigureBases).toBe(0);
  }),
);

it.effect('keeps an unreadable configure source on a surface retryable, never a denial', () =>
  Effect.gen(function* surfaceUnavailable() {
    const answer = yield* surfaceCase({ bases: [companyAdmin], unavailable: true });
    expect(answer.decision.outcome).toBe('UNAVAILABLE');
    expect(answer.decision.reasons.map(({ code }) => code)).toEqual(['unavailable.intent']);
    expect(answer.decision.structuralEvidence).toBeUndefined();
  }),
);

it.effect('answers a marked surface in one batch exactly as one request on its own', () =>
  Effect.gen(function* surfaceBatch() {
    const spec = withOptional(
      withOptional({ cells: [] as const, legalEntityScope: tenantContext }, 'configureBases', [companyAdmin]),
      'resolvedScopeId',
      tenantScope,
    );
    const requests = [surfacePolicy(), policy].map((one) => ({
      actor: actorIn(),
      now,
      request: { capability: one, mode: 'run' as const },
    }));
    const [answers] = yield* decideAccessMany(makeCheck({ authority: spec }).port, [
      { authority: makeAuthority(spec).port, inputs: requests },
    ]);
    const single = yield* Effect.forEach(
      requests,
      (input) => decideAccess(makeAuthority(spec).port, makeCheck({ authority: spec }).port, input),
      { concurrency: 1 },
    );
    expect(answers?.map(verdictOf)).toEqual(single.map(verdictOf));
    expect(answers?.map(({ reasons }) => reasons[0]?.code)).toEqual([
      'structural.access_admin_any',
      'deny.insufficient_grant',
    ]);
  }),
);
