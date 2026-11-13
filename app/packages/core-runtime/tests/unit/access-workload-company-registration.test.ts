import { NodeCrypto } from '@effect/platform-node';
import { Effect, Option, Predicate, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessDecision } from '../../src/access/decision/contract.ts';
import type { DecisionCheckPort } from '../../src/access/decision/engine.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { AccessPrincipalKind, AccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import type { AccessWorkloadBindings } from '../../src/access/enforcement/workload-port.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { LegalEntityId, PrincipalId } from '../../src/access/ids.ts';
import type { AccessIntentError } from '../../src/access/intent/errors.ts';
import type { AccessIntentDatabase } from '../../src/access/intent/persistence.ts';
import { writeWorkloadCompanyBindings } from '../../src/access/workloads/company-bindings.ts';
import { lockWorkloadAuthority } from '../../src/access/workloads/authority-fence.ts';
import { AccessWorkloadCompanyBindingIdSchema } from '../../src/access/workloads/company-store.ts';
import type { RegisterWorkloadCompanyBindingInput } from '../../src/access/workloads/company-store.ts';
import { AccessWorkloadBindingIdSchema } from '../../src/access/workloads/store.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessActorSchema, WorkloadKeySchema } from '../../src/authorization/access-declaration.ts';
import {
  preserveSystemPrincipalContextTrust,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import type { VerifiedGatewayActor } from '../../src/auth/system-principal-context-provenance.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { at, person, tenant } from './access-decision-support.ts';

/*
 * The explicit company registrations (D6), proved against the real seam without a database. A workload
 * selects and acts in a company only when its owner registered that company for one of its active
 * bindings, directly and as the subject of a verified module call alike: no active registration means no
 * company authority, never a tenant-wide one. Every case below is answered by `makeAccessDecisionService`
 * itself, so the suite proves the shipped rule rather than a scripted double.
 */

const now = at('2026-11-09T12:00:00Z');
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const revision = 'b'.repeat(64);
const workloadKey = WorkloadKeySchema.make('commerce.storefront-client');
const storefront = PrincipalIdSchema.make(uid(80));
const companyA = LegalEntityIdSchema.make(uid(31));
const companyB = LegalEntityIdSchema.make(uid(32));
const foreignCompany = LegalEntityIdSchema.make(uid(41));
const otherTenant = TenantIdSchema.make(uid(9));

const kindSource = (kind: AccessPrincipalKind): AccessPrincipalKinds => ({
  readKind: () => Effect.succeed(Option.some(kind)),
});

/** The trusted request scope of a standalone workload: an API key, no verified calling module. */
const scopeOf = (principalId: PrincipalId, legalEntityId?: LegalEntityId): OperationalScope => {
  const input = {
    authBindingId: uid(70),
    authContextRef: 'access-workload-company-registration',
    authMethod: 'api_key' as const,
    principalId,
    tenantId: tenant,
  };
  if (legalEntityId !== undefined) {
    Object.assign(input, { legalEntityId });
  }
  const trusted = Schema.decodeSync(TrustedPrincipalContextSchema)(input);
  return { ...trusted, correlationId: 'access-workload-company-registration' };
};

/** The same request as the subject of a verified module call (D6), which keeps the tenant-wide rule. */
const delegatedScopeOf = (legalEntityId?: LegalEntityId): OperationalScope => {
  const caller: VerifiedGatewayActor = { appId: 'commerce', buildMarker: 'storefront-build', principalId: uid(90) };
  const input = {
    authBindingId: uid(70),
    authContextRef: 'access-workload-company-registration-delegated',
    authMethod: 'session' as const,
    principalId: storefront,
    tenantId: tenant,
  };
  if (legalEntityId !== undefined) {
    Object.assign(input, { legalEntityId });
  }
  const context = Schema.decodeSync(TrustedPrincipalContextSchema)(input);
  const trusted = trustVerifiedGatewayPrincipalContext(context, revision, undefined, caller);
  return preserveSystemPrincipalContextTrust(
    trusted,
    Object.freeze({ ...trusted, correlationId: 'access-workload-company-registration-delegated' }),
  );
};

interface RunOptions {
  readonly candidates?: readonly LegalEntityId[];
  /** The company the trusted scope names; absent means the request selects none. */
  readonly company?: LegalEntityId;
  /** The registry cannot be read at all: keys and companies are one read, so both are unavailable (O48). */
  readonly declarationFails?: boolean;
  /** The companies the owner registered; absent means no registration at all. */
  readonly declaredCompanies?: readonly LegalEntityId[] | undefined;
  readonly delegated?: boolean;
  readonly keys?: readonly string[];
  readonly kind?: AccessPrincipalKind;
}

/** The seam with its ports faked, plus the questions the registry was actually asked. */
const harness = (options: RunOptions = {}) => {
  const asked: { readonly principalId: string; readonly tenantId: string }[] = [];
  const workloadBindings: AccessWorkloadBindings = {
    readWorkloadAuthority: (query) => {
      asked.push({ principalId: query.principalId, tenantId: query.tenantId });
      return options.declarationFails === true
        ? Effect.fail(accessDecisionUnavailable('the workload registry is unavailable'))
        : Effect.succeed({
            activeCompanyIds: new Set(options.declaredCompanies),
            workloadKeys: new Set(options.keys ?? [workloadKey]),
          });
    },
  };
  // Only the first company answers `select`, so the human path proves the engine still narrows the list.
  const check: DecisionCheckPort = {
    checkBulk: (items) =>
      Effect.succeed(
        items.map((_item, index) => ({ permissionship: index === 0 ? ('has' as const) : ('none' as const) })),
      ),
  };
  const candidates = options.candidates ?? [];
  const gate = makeAccessDecisionService({
    authorityFor: () => ({
      readCells: () => Effect.succeed([]),
      readConnection: () => Effect.succeed(Option.none()),
      readScope: () => Effect.succeed(Option.none()),
      readTeamIds: () => Effect.succeed([]),
    }),
    check,
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed(candidates) },
    principalKinds: kindSource(options.kind ?? 'service'),
    workloadBindings,
  });
  const scope = options.delegated === true ? delegatedScopeOf(options.company) : scopeOf(storefront, options.company);
  return { asked, gate, scope };
};

const workloadCarrier = (): GateInput['carrier'] => ({
  accessWorkload: { reason: 'the registered storefront reads its own catalog', workloads: [workloadKey] },
});

const gateInput = (scope: OperationalScope): GateInput => ({
  carrier: workloadCarrier(),
  legalEntityScope: scope.legalEntityId === undefined ? 'forbidden' : 'required',
  now,
  scope,
});

/** A carrier a calling module reaches with the storefront client as the subject of its call (D6). */
const moduleCallInput = (scope: OperationalScope): GateInput => ({
  carrier: {
    accessActor: Schema.decodeUnknownSync(AccessActorSchema)({
      callers: ['commerce'],
      reason: 'The calling module acts for the storefront client that started the work.',
      subject: 'workload',
      subjectWorkloads: [workloadKey],
    }),
  },
  legalEntityScope: 'required',
  now,
  scope,
});

const reasonCodesOf = (decision: AccessDecision): readonly string[] => decision.reasons.map(({ code }) => code);

it.effect('answers exactly the one company a standalone workload is registered for', () =>
  Effect.gen(function* exactOneCompany() {
    const { gate, scope } = harness({
      candidates: [companyA, companyB],
      company: companyA,
      declaredCompanies: [companyA],
    });
    expect(yield* gate.selectableLegalEntities({ now, scope })).toEqual([companyA]);
  }),
);

it.effect('answers no company for a standalone workload whose owner declared none', () =>
  Effect.gen(function* unregisteredWorkload() {
    const { gate, scope } = harness({ candidates: [companyA, companyB], company: companyA });
    expect(yield* gate.selectableLegalEntities({ now, scope })).toEqual([]);
  }),
);

it.effect('answers no company while the workload holds no active binding, in one registry read', () =>
  Effect.gen(function* unboundWorkload() {
    const { asked, gate, scope } = harness({
      candidates: [companyA],
      company: companyA,
      declaredCompanies: [companyA],
      keys: [],
    });
    expect(yield* gate.selectableLegalEntities({ now, scope })).toEqual([]);
    // Keys and companies are one consistent read: a registration never outlives its binding (O73).
    expect(asked).toHaveLength(1);
  }),
);

it.effect('answers only this tenant companies, so a foreign registration is never selectable', () =>
  Effect.gen(function* foreignCompanyNeverSelectable() {
    const { gate, scope } = harness({
      candidates: [companyA],
      company: companyA,
      declaredCompanies: [companyB, foreignCompany],
    });
    expect(yield* gate.selectableLegalEntities({ now, scope })).toEqual([]);

    const own = harness({ candidates: [companyA, companyB], company: companyA, declaredCompanies: [companyA] });
    expect(yield* own.gate.selectableLegalEntities({ now, scope })).toEqual([companyA]);
  }),
);

it.effect('asks the registry only for the trusted scope principal and tenant (O66)', () =>
  Effect.gen(function* trustedScopeOnly() {
    const { asked, gate, scope } = harness({
      candidates: [companyA],
      company: companyA,
      declaredCompanies: [companyA],
    });
    yield* gate.selectableLegalEntities({ now, scope });
    expect(asked).toEqual([{ principalId: storefront, tenantId: tenant }]);
  }),
);

it.effect('fails the company list when the registration cannot be read, never as an empty answer (O48)', () =>
  Effect.gen(function* unreadableDeclaration() {
    const { gate, scope } = harness({
      candidates: [companyA],
      company: companyA,
      declarationFails: true,
      declaredCompanies: [companyA],
    });
    const outcome = yield* Effect.matchEffect(gate.selectableLegalEntities({ now, scope }), {
      onFailure: (failure) => Effect.succeed(failure._tag),
      onSuccess: () => Effect.succeed('answered'),
    });
    expect(outcome).toBe('AccessDecisionUnavailable');
  }),
);

it.effect('pins the subject of a verified module call to its declared companies, as the decision gate does (D6)', () =>
  Effect.gen(function* verifiedModuleSubject() {
    const pinned = harness({
      candidates: [companyA, companyB],
      company: companyA,
      declaredCompanies: [companyA],
      delegated: true,
    });
    // A platform registration acts for exactly one company: the issuer may select no other for it.
    expect(yield* pinned.gate.selectableLegalEntities({ now, scope: pinned.scope })).toEqual([companyA]);
    // A module subject whose workload has no registration selects no company: company authority is never an absence.
    const undeclared = harness({ candidates: [companyA, companyB], company: companyA, delegated: true });
    expect(yield* undeclared.gate.selectableLegalEntities({ now, scope: undeclared.scope })).toEqual([]);
  }),
);

it.effect('keeps the human and agent company paths unchanged', () =>
  Effect.gen(function* humanAndAgentUnchanged() {
    const human = harness({ candidates: [companyA, companyB], kind: 'human' });
    // The engine still narrows the tenant list for a person, and the registry is never consulted.
    expect(yield* human.gate.selectableLegalEntities({ now, scope: human.scope })).toEqual([companyA]);
    expect(human.asked).toEqual([]);

    const agent = harness({ candidates: [companyA], kind: 'agent' });
    expect(yield* agent.gate.selectableLegalEntities({ now, scope: agent.scope })).toEqual([]);
  }),
);

it.effect('admits a pinned workload in the company its owner declared', () =>
  Effect.gen(function* pinnedCompanyAdmitted() {
    const { gate, scope } = harness({ company: companyA, declaredCompanies: [companyA] });
    const decision = yield* gate.decide(gateInput(scope));
    expect(decision.outcome).toBe('ALLOWED');
    expect(reasonCodesOf(decision)).toEqual(['allow.workload']);
  }),
);

it.effect('refuses a pinned workload in any other company, exactly as an unbound one (D6)', () =>
  Effect.gen(function* pinnedCompanyRefused() {
    const other = harness({ company: companyB, declaredCompanies: [companyA] });
    const decision = yield* other.gate.decide(gateInput(other.scope));
    expect(decision.outcome).toBe('DENIED');
    expect(reasonCodesOf(decision)).toEqual(['deny.workload_unbound']);
  }),
);

it.effect('refuses a revoked registration in its former company, so a prepared Action cannot keep it', () =>
  Effect.gen(function* revokedRegistrationRefused() {
    const revoked = harness({ company: companyA });
    const decision = yield* revoked.gate.decide(gateInput(revoked.scope));
    expect(decision.outcome).toBe('DENIED');
    expect(reasonCodesOf(decision)).toEqual(['deny.workload_unbound']);
  }),
);

it.effect('refuses a standalone company decision when its owner declared no company', () =>
  Effect.gen(function* noDeclarationMeansNoCompany() {
    const { gate, scope } = harness({ company: companyB });
    const decision = yield* gate.decide(gateInput(scope));
    expect(decision.outcome).toBe('DENIED');
    expect(reasonCodesOf(decision)).toEqual(['deny.workload_unbound']);
  }),
);

it.effect('cannot unpin a remaining standalone binding when its last registered binding is revoked', () =>
  Effect.gen(function* registrationBearingBindingRevoked() {
    let registered = true;
    const { gate, scope } = harness({
      company: companyA,
      get declaredCompanies() {
        return registered ? [companyA] : undefined;
      },
    });
    expect((yield* gate.decide(gateInput(scope))).outcome).toBe('ALLOWED');
    registered = false;
    const decision = yield* gate.decide(gateInput(scope));
    expect(decision.outcome).toBe('DENIED');
    expect(reasonCodesOf(decision)).toEqual(['deny.workload_unbound']);
    const [batched] = yield* gate.decideMany([gateInput(scope)]);
    expect(batched?.outcome).toBe('DENIED');
  }),
);

it.effect('keeps tenant-only workload execution independent of company selection', () =>
  Effect.gen(function* tenantOnlyWorkload() {
    const { gate, scope } = harness();
    expect((yield* gate.decide(gateInput(scope))).outcome).toBe('ALLOWED');
  }),
);

it.effect('answers UNAVAILABLE when the declaration cannot be read on a workload carrier (O48)', () =>
  Effect.gen(function* unreadableDeclarationOnDecision() {
    const { gate, scope } = harness({ company: companyA, declarationFails: true });
    const decision = yield* gate.decide(gateInput(scope));
    expect(decision.outcome).toBe('UNAVAILABLE');
    expect(reasonCodesOf(decision)).toEqual(['unavailable.intent']);
  }),
);

it.effect('applies the same company rule to a batched workload entry', () =>
  Effect.gen(function* batchedEntry() {
    const admitted = harness({ company: companyA, declaredCompanies: [companyA] });
    const [allowed] = yield* admitted.gate.decideMany([gateInput(admitted.scope)]);
    expect(allowed?.outcome).toBe('ALLOWED');

    const refused = harness({ company: companyB, declaredCompanies: [companyA] });
    const [denied] = yield* refused.gate.decideMany([gateInput(refused.scope)]);
    expect(denied?.outcome).toBe('DENIED');
    expect(denied === undefined ? [] : reasonCodesOf(denied)).toEqual(['deny.workload_unbound']);
  }),
);

it.effect('pins the workload subject of a module call to its declared company, single and batched (D6)', () =>
  Effect.gen(function* moduleCallSubjectPinned() {
    const admitted = harness({ company: companyA, declaredCompanies: [companyA], delegated: true });
    expect(reasonCodesOf(yield* admitted.gate.decide(moduleCallInput(admitted.scope)))).toEqual(['allow.workload']);
    const [batchAllowed] = yield* admitted.gate.decideMany([moduleCallInput(admitted.scope)]);
    expect(batchAllowed?.outcome).toBe('ALLOWED');

    // The calling module names another company of the same tenant: refused as an unbound workload is.
    const moved = harness({ company: companyB, declaredCompanies: [companyA], delegated: true });
    const single = yield* moved.gate.decide(moduleCallInput(moved.scope));
    expect(single.outcome).toBe('DENIED');
    expect(reasonCodesOf(single)).toEqual(['deny.workload_unbound']);
    const [batched] = yield* moved.gate.decideMany([moduleCallInput(moved.scope)]);
    expect(batched === undefined ? [] : reasonCodesOf(batched)).toEqual(['deny.workload_unbound']);

    // A revoked registration keeps the workload pinned to no company on the module-call path too.
    const revoked = harness({ company: companyA, delegated: true });
    expect(reasonCodesOf(yield* revoked.gate.decide(moduleCallInput(revoked.scope)))).toEqual([
      'deny.workload_unbound',
    ]);
    const [revokedBatch] = yield* revoked.gate.decideMany([moduleCallInput(revoked.scope)]);
    expect(revokedBatch === undefined ? [] : reasonCodesOf(revokedBatch)).toEqual(['deny.workload_unbound']);
  }),
);

it.effect('refuses a module-call workload subject with no registration in every company, as the direct path does', () =>
  Effect.gen(function* moduleCallSubjectUnregistered() {
    // A storefront key nobody registered: a calling module cannot carry it into any company (D6).
    const delegated = harness({ company: companyB, delegated: true });
    expect(reasonCodesOf(yield* delegated.gate.decide(moduleCallInput(delegated.scope)))).toEqual([
      'deny.workload_unbound',
    ]);
    const [batched] = yield* delegated.gate.decideMany([moduleCallInput(delegated.scope)]);
    expect(batched === undefined ? [] : reasonCodesOf(batched)).toEqual(['deny.workload_unbound']);
    // The direct path answers the same workload the same way.
    const direct = harness({ company: companyB });
    expect(reasonCodesOf(yield* direct.gate.decide(gateInput(direct.scope)))).toEqual(['deny.workload_unbound']);
    // In the tenant context no company is named, so both paths still admit it there.
    const tenantOnly = harness({ delegated: true });
    expect(
      (yield* tenantOnly.gate.decide({ ...moduleCallInput(tenantOnly.scope), legalEntityScope: 'forbidden' })).outcome,
    ).toBe('ALLOWED');
  }),
);

it.effect('answers UNAVAILABLE, never "not pinned", when a module-call subject declaration is unreadable (O48)', () =>
  Effect.gen(function* moduleCallSubjectUnreadable() {
    const { gate, scope } = harness({ company: companyA, declarationFails: true, delegated: true });
    const single = yield* gate.decide(moduleCallInput(scope));
    expect(single.outcome).toBe('UNAVAILABLE');
    expect(reasonCodesOf(single)).toEqual(['unavailable.intent']);
    const [batched] = yield* gate.decideMany([moduleCallInput(scope)]);
    expect(batched?.outcome).toBe('UNAVAILABLE');
  }),
);

it.effect('reads the keys and companies of a module-call workload subject in one registry read', () =>
  Effect.gen(function* moduleCallSubjectOneRead() {
    const { asked, gate, scope } = harness({ company: companyA, declaredCompanies: [companyA], delegated: true });
    expect((yield* gate.decide(moduleCallInput(scope))).outcome).toBe('ALLOWED');
    expect(asked).toHaveLength(1);
    yield* gate.decideMany([moduleCallInput(scope), moduleCallInput(scope)]);
    // One read for the whole batch: a binding revoked between two reads can never pair a stale key with a company.
    expect(asked).toHaveLength(2);
  }),
);

for (const state of ['Ready', 'Changing', 'missing'] as const) {
  it.effect(`serializes workload mutation with the native tenant fence: ${state}`, () =>
    Effect.gen(function* nativeWorkloadMutationFence() {
      const statements: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
      const executor = yield* makeTestDatabase((sql, params) => {
        statements.push({ params, sql });
        return Effect.succeed(state === 'missing' ? [] : [{ state }]);
      });
      const result = yield* Effect.result(
        executor.transaction((transaction) => lockWorkloadAuthority(transaction, scopeOf(person))),
      );
      expect(Result.isSuccess(result)).toBe(state === 'Ready');
      const locking = statements.filter(({ sql }) => sql.includes('for update'));
      expect(locking).toHaveLength(1);
      expect(locking[0]?.sql).toContain('"legal_entity_id" is null');
      expect(locking[0]?.params).toEqual([tenant]);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('AccessIntentUnavailableError');
      }
    }),
  );
}

const registrationOf = (
  legalEntityId: LegalEntityId,
  workloadBindingId: string,
  suffix: number,
): RegisterWorkloadCompanyBindingInput => ({
  companyBindingId: AccessWorkloadCompanyBindingIdSchema.make(uid(300 + suffix)),
  createdAt: now,
  incarnation: AccessWorkloadCompanyBindingIdSchema.make(uid(400 + suffix)),
  legalEntityId,
  tenantId: tenant,
  workloadBindingId: AccessWorkloadBindingIdSchema.make(workloadBindingId),
});

const conflictCodeOf = (result: Result.Result<void, AccessIntentError>): string | undefined =>
  Result.isFailure(result) && Predicate.isTagged(result.failure, 'AccessIntentConflictError')
    ? result.failure.code
    : undefined;

it.layer(NodeCrypto.layer)('the company-registration writer', (suite) => {
  suite.effect('refuses a second company for one binding before any SQL reaches the database', () =>
    Effect.gen(function* refusesSecondCompany() {
      const statements: string[] = [];
      const executor = yield* makeTestDatabase((statement) => {
        statements.push(statement);
        return Effect.succeed([]);
      });
      const database: AccessIntentDatabase = { enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor };
      const scope = scopeOf(person);
      const binding = uid(500);
      const refused = yield* Effect.result(
        writeWorkloadCompanyBindings(database, scope, {
          bindings: [registrationOf(companyA, binding, 1), registrationOf(companyB, binding, 2)],
        }),
      );
      expect(conflictCodeOf(refused)).toBe('access_intent_write_refused');
      // The command is refused by the writer itself, so no transaction is opened and nothing is written.
      expect(statements).toEqual([]);
    }),
  );

  suite.effect('refuses a command that names another tenant before any SQL reaches the database', () =>
    Effect.gen(function* refusesForeignTenant() {
      const statements: string[] = [];
      const executor = yield* makeTestDatabase((statement) => {
        statements.push(statement);
        return Effect.succeed([]);
      });
      const database: AccessIntentDatabase = { enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor };
      const scope = { ...scopeOf(person), tenantId: otherTenant };
      const refused = yield* Effect.result(
        writeWorkloadCompanyBindings(database, scope, { bindings: [registrationOf(companyA, uid(501), 3)] }),
      );
      expect(conflictCodeOf(refused)).toBe('access_intent_scope_mismatch');
      expect(statements).toEqual([]);
    }),
  );
});
