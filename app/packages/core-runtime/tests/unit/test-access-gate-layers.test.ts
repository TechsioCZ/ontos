import { Effect, Exit, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import { AccessPrincipalKindSource } from '../../src/access/enforcement/actor.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import type { AccessDecisionService, GateInput } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLog } from '../../src/access/enforcement/decision-log.ts';
import { AccessIntent } from '../../src/access/decision/authority.ts';
import { LegalEntityCandidates } from '../../src/access/enforcement/legal-entities.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import type { TestAccessGateScript } from '../../src/testing/access-gate.ts';
import { makeTestAccessGateLayers, makeTestOperationalScopeAccess } from '../../src/testing/access-gate.ts';
import { at } from './access-decision-support.ts';

/*
 * The one test layer factory the module lanes build their suites on (C25). It replaces five copies
 * that differed only in how they scripted "this person holds nothing", so the claims proven here are
 * exactly the ones those copies made: a scripted allow reaches the composition, a principal with no
 * assignment is refused and selects no company (O28), a principal without this capability is refused
 * while its company stays selectable, and an unreadable authority is a retryable failure.
 */

const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const now = at('2026-11-03T12:00:00Z');
const owner = uuid(2);
const colleague = uuid(3);
const company = uuid(5);
const otherCompany = uuid(6);

const entrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.gate.api.read',
  moduleKey: 'test.gate',
  role: 'api',
});
const carrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'test.gate.record.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'gate', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    entrypoint,
  ),
};

const scopeOf = (principalId: string, legalEntityId?: string): OperationalScope =>
  Object.freeze(
    withOptional(
      {
        authBindingId: `binding-${principalId}`,
        authContextRef: `session-${principalId}`,
        authMethod: 'session' as const,
        correlationId: 'c25-gate-layers',
        principalId: PrincipalIdSchema.make(principalId),
        tenantId: TenantIdSchema.make(uuid(1)),
      },
      'legalEntityId',
      legalEntityId === undefined ? undefined : LegalEntityIdSchema.make(legalEntityId),
    ),
  );

const questionOf = (principalId: string, legalEntityId?: string): GateInput => ({
  carrier,
  legalEntityScope: legalEntityId === undefined ? 'optional' : 'required',
  now,
  scope: scopeOf(principalId, legalEntityId),
});

const layersOf = (options: TestAccessGateScript = {}) => makeTestAccessGateLayers(options);

/** The company question a scope resolver asks first (O28), as the caller's typed failure or a list. */
const selectableWith = (gate: AccessDecisionService, input: { readonly scope: OperationalScope }) =>
  Effect.option(gate.selectableLegalEntities({ now, scope: input.scope }));

const allowedAnswer = { spec: { defaultAnswer: { outcome: 'ALLOWED' as const } } };

it.layer(layersOf(allowedAnswer), { excludeTestServices: true })('the scripted access gate (C25)', (suite) => {
  suite.effect('answers a scripted allow and binds every port of the assembly', () =>
    Effect.gen(function* answersScriptedAllow() {
      const gate = yield* AccessDecisionGate;
      const allowed = yield* gate.decide(questionOf(owner));
      expect(allowed.outcome).toBe('ALLOWED');

      // The five ports are bound to the inert double, so a suite's gate never reads real authority.
      const ports = yield* Effect.all([
        AccessIntent,
        AccessDecisionLog,
        AccessPrincipalKindSource,
        DecisionCheck,
        LegalEntityCandidates,
      ]);
      expect(ports.length).toBe(5);
      // The engine port refuses to answer, which is exactly what "the gate read no authority" means.
      expect(Exit.isFailure(yield* Effect.exit(ports[3].checkBulk([])))).toBe(true);
    }),
  );

  suite.effect('admits a principal the fixture names no refusal for', () =>
    Effect.gen(function* admitsUnnamedPrincipal() {
      // The negative control for the two refusal options below: without them the same person is allowed.
      const gate = yield* AccessDecisionGate;
      expect((yield* gate.decide(questionOf(colleague, company))).outcome).toBe('ALLOWED');
    }),
  );

  suite.effect('answers a row-scoped question with a predicate (O25)', () =>
    Effect.gen(function* answersList() {
      const gate = yield* AccessDecisionGate;
      const allowed = yield* gate.list({ carrier, legalEntityScope: 'optional', now, scope: scopeOf(owner, company) });
      expect(allowed.decision.outcome).toBe('ALLOWED');
      expect(allowed.predicate).toBeDefined();
    }),
  );
});

it.layer(layersOf(), { excludeTestServices: true })('the fail-closed default (C62)', (suite) => {
  suite.effect('denies a suite that scripts nothing', () =>
    Effect.gen(function* deniesUnscripted() {
      const gate = yield* AccessDecisionGate;
      expect((yield* gate.decide(questionOf(owner))).outcome).toBe('DENIED');
    }),
  );

  suite.effect('echoes the selected company and answers none in the tenant context (O28)', () =>
    Effect.gen(function* echoesCompany() {
      const gate = yield* AccessDecisionGate;
      const echoed = yield* selectableWith(gate, { scope: scopeOf(owner, company) });
      expect(Option.getOrUndefined(echoed)?.map(String)).toEqual([company]);
      const none = yield* selectableWith(gate, { scope: scopeOf(owner) });
      expect(Option.getOrUndefined(none)).toEqual([]);
    }),
  );
});

it.layer(layersOf({ ...allowedAnswer, deniedPrincipalIds: [colleague], selectableLegalEntityIds: [company] }), {
  excludeTestServices: true,
})('the no-assignment refusal (O28)', (suite) => {
  suite.effect('refuses a principal with no assignment and lets it select no company', () =>
    Effect.gen(function* refusesUnassignedPrincipal() {
      const gate = yield* AccessDecisionGate;
      const refused = yield* gate.decide(questionOf(colleague, company));
      expect(refused.outcome).toBe('DENIED');
      expect(refused.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
      // The scope resolution itself must refuse this person: the company list comes back empty, which
      // is exactly what makes the resolver deny the selected company (O28).
      const companies = yield* selectableWith(gate, { scope: scopeOf(colleague, company) });
      expect(Option.getOrUndefined(companies)).toEqual([]);

      // Negative control: the assigned principal is allowed and may select the company.
      expect((yield* gate.decide(questionOf(owner, company))).outcome).toBe('ALLOWED');
      const ownerCompanies = yield* selectableWith(gate, { scope: scopeOf(owner, company) });
      expect(Option.getOrUndefined(ownerCompanies)?.map(String)).toEqual([company]);
    }),
  );
});

it.layer(layersOf({ ...allowedAnswer, capabilityDeniedPrincipalIds: [colleague] }), { excludeTestServices: true })(
  'the one-capability refusal',
  (suite) => {
    suite.effect('refuses one capability while the company stays selectable', () =>
      Effect.gen(function* refusesOneCapabilityOnly() {
        const gate = yield* AccessDecisionGate;
        expect((yield* gate.decide(questionOf(colleague, company))).outcome).toBe('DENIED');
        // The company selection still answers, so the request reaches the owner path the suite proves.
        const companies = yield* selectableWith(gate, { scope: scopeOf(colleague, company) });
        expect(Option.getOrUndefined(companies)?.map(String)).toEqual([company]);
      }),
    );
  },
);

it.layer(layersOf({ selectableLegalEntityIds: [company, otherCompany] }), { excludeTestServices: true })(
  'the scripted company list (O28)',
  (suite) => {
    suite.effect('names exactly the scripted companies', () =>
      Effect.gen(function* answersScriptedCompanies() {
        const gate = yield* AccessDecisionGate;
        const companies = yield* selectableWith(gate, { scope: scopeOf(owner, company) });
        expect(Option.getOrUndefined(companies)?.map(String)).toEqual([company, otherCompany]);
      }),
    );
  },
);

it.layer(layersOf({ unavailable: true }), { excludeTestServices: true })('the unreadable authority (O48b)', (suite) => {
  suite.effect('answers an unreadable authority as a retryable failure in both scope questions', () =>
    Effect.gen(function* answersUnavailable() {
      const gate = yield* AccessDecisionGate;
      expect((yield* gate.decide(questionOf(owner, company))).outcome).toBe('UNAVAILABLE');
      expect(Option.isNone(yield* selectableWith(gate, { scope: scopeOf(owner, company) }))).toBe(true);
    }),
  );
});

it.layer(
  layersOf({
    scopeAccess: makeTestOperationalScopeAccess({ decision: 'allowed', legalEntityIds: () => [company] }),
    spec: { defaultAnswer: { outcome: 'DENIED' } },
  }),
  { excludeTestServices: true },
)('the suite-scripted scope questions (O28)', (suite) => {
  suite.effect('answers both scope questions from the suite itself', () =>
    Effect.gen(function* scriptsScopeAccess() {
      const gate = yield* AccessDecisionGate;
      // The suite's own scope answer replaces the capability answer it would otherwise script.
      expect((yield* gate.decide(questionOf(owner, company))).outcome).toBe('ALLOWED');
      const companies = yield* selectableWith(gate, { scope: scopeOf(owner, company) });
      expect(Option.getOrUndefined(companies)?.map(String)).toEqual([company]);
    }),
  );
});

it.layer(
  layersOf({
    deniedPrincipalIds: [colleague],
    scopeAccess: makeTestOperationalScopeAccess({ decision: 'allowed', legalEntityIds: () => [company] }),
    spec: { defaultAnswer: { outcome: 'DENIED' } },
  }),
  { excludeTestServices: true },
)('the refusal that wins over a scripted scope (O28)', (suite) => {
  suite.effect('keeps the fail-closed principal refusal over the suite script', () =>
    Effect.gen(function* refusalWins() {
      const gate = yield* AccessDecisionGate;
      expect((yield* gate.decide(questionOf(colleague, company))).outcome).toBe('DENIED');
    }),
  );
});

it.layer(layersOf({ ...allowedAnswer, deniedPrincipalIds: [owner] }), { excludeTestServices: true })(
  'the refused list answer (O25)',
  (suite) => {
    suite.effect('never hands a refused principal a predicate', () =>
      Effect.gen(function* refusesList() {
        const gate = yield* AccessDecisionGate;
        const refused = yield* gate.list({
          carrier,
          legalEntityScope: 'optional',
          now,
          scope: scopeOf(owner, company),
        });
        expect(refused.decision.outcome).toBe('DENIED');
        expect(refused.predicate).toBeUndefined();
      }),
    );
  },
);
