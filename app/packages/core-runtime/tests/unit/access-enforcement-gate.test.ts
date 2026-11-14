import { organizationProcessingReadPrincipal } from '../support/organization-processing-read-principal.ts';
import { organizationGovernanceReadPrincipal } from '../support/organization-governance-read-principal.ts';
import { privacyDispatchPrincipal } from '../support/privacy-dispatch-principal.ts';
import { preserveSystemPrincipalContextTrust } from '../../src/auth/system-principal-context-provenance.ts';
import { ActorContextSchema } from '../../src/access/model.ts';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AccessActorSchema,
  WorkloadKeySchema,
  decodeAccessDeclarationOrThrow,
} from '../../src/authorization/access-declaration.ts';
import type {
  AccessDeclaration,
  AccessDeclarationInput,
  WorkloadKey,
} from '../../src/authorization/access-declaration.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { AccessPrincipalKinds, AccessPrincipalKind } from '../../src/access/enforcement/actor.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import type { DecisionCheckPort } from '../../src/access/decision/engine.ts';
import type { CompanyOwnershipQuery, DecisionAuthorityPort, ScopeQuery } from '../../src/access/decision/authority.ts';
import type { GateInput, ListGateInput } from '../../src/access/enforcement/contract.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import type { AccessDecisionLogEntry, AccessDecisionLogWriter } from '../../src/access/enforcement/decision-log.ts';
import { makeActionAuthorityService } from '../../src/permissions/action-authority.ts';
import type { DeclaredActionAuthority } from '../../src/permissions/action-authority.ts';
import type { AccessLegalEntityCandidates } from '../../src/access/enforcement/legal-entities.ts';
import type { AccessWorkloadBindings } from '../../src/access/enforcement/workload-port.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { LegalEntityIdSchema, PrincipalIdSchema } from '../../src/access/ids.ts';
import type { LegalEntityId, PrincipalId } from '../../src/access/ids.ts';
import {
  agent,
  agentHolder,
  at,
  cell,
  connect,
  connectionId,
  makeAuthority,
  makeCheck,
  person,
  recordTarget,
  tenant,
} from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const now = at('2026-11-03T12:00:00Z');
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

/** A protected Action entrypoint: the carrier rules read the role, so the owner needs one (C03). */
const ACTION_OWNER = {
  access: 'write',
  authorization: { kind: 'protected' },
  moduleKey: 'finance',
  role: 'action',
} as const;

/** A Core-owned administrative Action: its key starts with the module that declares it (O27). */
const ADMIN_OWNER = {
  access: 'write',
  authorization: { kind: 'protected' },
  moduleKey: 'core.identity',
  role: 'action',
} as const;

const declarationOf = (overrides: Partial<AccessDeclarationInput> = {}): AccessDeclaration =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'finance.invoice.void',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'finance', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
      ...overrides,
    },
    ACTION_OWNER,
  );

const adminDeclarationOf = (overrides: Partial<AccessDeclarationInput> = {}): AccessDeclaration =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'core.identity.support.impersonate',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'critical',
      selectors: [],
      ...overrides,
    },
    ADMIN_OWNER,
  );

const scopeFor = (principalId: PrincipalId, legalEntityId?: LegalEntityId): OperationalScope => {
  const trusted = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: uid(70),
    authContextRef: 'session-enforcement-gate',
    authMethod: 'session',
    principalId,
    tenantId: tenant,
  });
  return legalEntityId === undefined
    ? { ...trusted, correlationId: 'access-enforcement-gate' }
    : { ...trusted, correlationId: 'access-enforcement-gate', legalEntityId };
};

const kindSource = (kind: AccessPrincipalKind | 'unreadable' | 'unknown'): AccessPrincipalKinds => ({
  readKind: () =>
    kind === 'unreadable'
      ? Effect.fail(accessDecisionUnavailable('the identity rows are unavailable'))
      : Effect.succeed(kind === 'unknown' ? Option.none() : Option.some(kind)),
});

interface LogState {
  readonly entries: AccessDecisionLogEntry[];
}

const logWriter = (fail = false) => {
  const state: LogState = { entries: [] };
  const log: AccessDecisionLogWriter = {
    record: (entry) => {
      if (fail) {
        return Effect.fail(accessDecisionUnavailable('the evidence store is unavailable'));
      }
      state.entries.push(entry);
      return Effect.void;
    },
  };
  return { log, state };
};

const legalEntityCandidates = (ids: readonly LegalEntityId[]): AccessLegalEntityCandidates => ({
  listCandidateIds: () => Effect.succeed(ids),
});

/** The one workload key the gate suites register; a binding for it is the only way in (O73). */
const BOUND_WORKLOAD = WorkloadKeySchema.make('finance.machine-provisioner');
/** A second key, so a binding for another workload than the carrier declares is testable (O73). */
const OTHER_WORKLOAD = WorkloadKeySchema.make('finance.other-workload');

/** A workload carrier declaring one key; the second is what a binding for another key refuses. */
const workloadCarrier = (
  reason: string,
  workloads: readonly [WorkloadKey, ...WorkloadKey[]] = [BOUND_WORKLOAD],
): GateInput['carrier'] => ({ accessWorkload: { reason, workloads } });

interface RunOptions {
  readonly authority?: AuthoritySpec;
  /** A batch evidence writer: each call's rows are kept, or the whole call fails. */
  readonly batchLog?: 'fails' | 'writes';
  /** A scripted engine port, for the suites that answer `select` themselves. */
  readonly check?: DecisionCheckPort;
  /** The declaration cannot be read: the gate must answer UNAVAILABLE, never "no declaration" (O48, D6). */
  readonly companyDeclarationReadFails?: boolean;
  /** The companies this workload is pinned to; absent means its owner declared none (D6). */
  readonly declaredCompanies?: readonly LegalEntityId[];
  /** The owner declared a company and then revoked it: the workload is pinned to none (D6). */
  readonly declaredCompaniesRevoked?: boolean;
  readonly engineFailure?: boolean;
  /** Companies the asked tenant does not own: their scope read finds nothing. */
  readonly foreignCompanies?: readonly LegalEntityId[];
  readonly kinds?: AccessPrincipalKinds;
  readonly logFails?: boolean;
  /** Company ownership cannot be read: every company-naming request is UNAVAILABLE, never decided. */
  readonly ownershipFails?: boolean;
  readonly privacyDispatchLive?: boolean;
  readonly scopeMissing?: boolean;
  readonly selectableLegalEntities?: readonly LegalEntityId[];
  /** The active workload keys the registry answers for this actor; default none (O73). */
  readonly workloadKeys?: readonly string[];
  /** The registry cannot be read: the gate must answer UNAVAILABLE, never an unbound denial (O48). */
  readonly workloadReadFails?: boolean;
}

/** The seam with its six ports faked, plus the observation handles a suite needs. */
const harness = (options: RunOptions = {}) => {
  const authoritySpec: AuthoritySpec = options.authority ?? {
    cells: [cell({ capability: 'finance.invoice.void' })],
  };
  const authority = makeAuthority(authoritySpec);
  const checkSpec =
    options.engineFailure === true ? { authority: authoritySpec, failure: true } : { authority: authoritySpec };
  const check = makeCheck(checkSpec);
  const scopes: ScopeQuery[] = [];
  const ownership: CompanyOwnershipQuery[] = [];
  const port: DecisionAuthorityPort = {
    ...authority.port,
    readCompanyOwnership: (query) => {
      ownership.push(query);
      return options.ownershipFails === true
        ? Effect.fail(accessDecisionUnavailable('company ownership is unreadable'))
        : Effect.succeed(options.foreignCompanies?.includes(query.legalEntityId) !== true);
    },
    readScope: (query) => {
      scopes.push(query);
      // As the loader answers: a company the tenant does not own resolves no scope, whether the request selects it or
      // names it in the tenant context.
      const named = query.legalEntityId ?? query.checkedCompany;
      const foreign = named !== undefined && options.foreignCompanies?.includes(named);
      return options.scopeMissing === true || foreign === true
        ? Effect.succeed(Option.none())
        : authority.port.readScope(query);
    },
  };
  const { log, state } = logWriter(options.logFails === true);
  const workloadBindings: AccessWorkloadBindings = {
    readWorkloadAuthority: () =>
      options.workloadReadFails === true
        ? Effect.fail(accessDecisionUnavailable('the workload registry is unavailable'))
        : Effect.succeed({
            activeCompanyIds: new Set(options.declaredCompanies),
            workloadKeys: new Set(options.workloadKeys),
          }),
  };
  const batches: (readonly AccessDecisionLogEntry[])[] = [];
  const ports = {
    authorityFor: () => port,
    check: options.check ?? check.port,
    decisionLog: log,
    legalEntities: legalEntityCandidates(options.selectableLegalEntities ?? []),
    principalKinds: options.kinds ?? kindSource('human'),
    privacyDispatchLiveness: { read: () => Effect.succeed(options.privacyDispatchLive === true) },
    workloadBindings,
  };
  const gate = makeAccessDecisionService(
    options.batchLog === undefined
      ? ports
      : {
          ...ports,
          decisionLogBatch: {
            recordAll: (entries: readonly AccessDecisionLogEntry[]) =>
              options.batchLog === 'fails'
                ? Effect.fail(accessDecisionUnavailable('the evidence batch could not be written'))
                : Effect.sync(() => {
                    batches.push(entries);
                  }),
          },
        },
  );
  return { authority, batches, check, gate, ownership, scopes, state };
};

const gateOf = (overrides: Partial<GateInput> = {}): GateInput => ({
  carrier: { accessDeclaration: declarationOf() },
  legalEntityScope: 'forbidden',
  now,
  scope: scopeFor(person),
  ...overrides,
});

it.effect('allows a granted human through one decision and records the sensitive allow', () =>
  Effect.gen(function* allowsGrantedHuman() {
    const { gate, state } = harness();
    const decision = yield* gate.decide(gateOf());
    expect(decision.outcome).toBe('ALLOWED');
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.capability.capabilityKey).toBe('finance.invoice.void');
    expect(state.entries[0]?.scope.correlationId).toBe('access-enforcement-gate');
  }),
);

it.effect('records the asker when an administrator explains somebody else (O86)', () =>
  Effect.gen(function* recordsTheAsker() {
    const { gate, state } = harness();
    const asker = PrincipalIdSchema.make(uid(7));
    const decision = yield* gate.decide(gateOf({ onBehalfOfPrincipalId: asker }));
    expect(decision.outcome).toBe('ALLOWED');
    // The evaluated principal stays the subject; the asker is kept beside it, never in its place.
    expect(state.entries[0]?.actor.principalId).toBe(person);
    expect(state.entries[0]?.onBehalfOfPrincipalId).toBe(asker);
  }),
);

it.effect('leaves the asker unset when the evaluated actor asked for itself (O86)', () =>
  Effect.gen(function* leavesTheAskerUnset() {
    const { gate, state } = harness();
    yield* gate.decide(gateOf());
    expect(state.entries[0]?.onBehalfOfPrincipalId).toBeUndefined();
  }),
);

/** The trusted scope of an agent's OAuth connection: the agent acts, the operator delegated it, the credential binds it. */
const agentConnectionScope = (carried?: { readonly connectionId: string; readonly revision: number }) => {
  const base = {
    authBindingId: uid(71),
    authContextRef: `oauth-grant:${uid(72)}`,
    authMethod: 'oauth_connection',
    connection: {
      clientId: 'https://client.example/metadata.json',
      clientName: 'Client',
      grantId: uid(72),
      modules: 'all',
      writePolicy: 'direct',
    },
    delegatedByPrincipalId: person,
    legalEntityId: uid(73),
    principalId: agent,
    tenantId: tenant,
  };
  const trusted = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(
    carried === undefined ? base : { ...base, connection: { ...base.connection, agentConnection: carried } },
  );
  return { ...trusted, correlationId: 'access-enforcement-gate' } satisfies OperationalScope;
};

it.effect('decides an agent on its credential-bound connection as the agent, on both sides', () =>
  Effect.gen(function* decidesAgentOnConnection() {
    const agentCell = cell({ capability: 'finance.invoice.void', holder: agentHolder(), mode: 'propose' });
    const operatorCell = cell({ capability: 'finance.invoice.void', mode: 'propose' });
    const ceiling = {
      cells: [{ capabilityKey: agentCell.capabilityKey, mode: 'propose' as const, selector: { _tag: 'all' as const } }],
    };
    const { gate, state } = harness({
      authority: { cells: [agentCell, operatorCell], connection: connect({ ceiling }) },
      kinds: kindSource('agent'),
    });
    const scope = agentConnectionScope({ connectionId, revision: 1 });
    // A sensitive run by an agent is a proposal a person decides: the engine answers NEEDS_APPROVAL, never ALLOWED.
    const decision = yield* gate.decide(gateOf({ legalEntityScope: 'required', scope }));
    expect(decision.outcome).toBe('NEEDS_APPROVAL');
    // The evidence names the agent, the operator and the connection: the gate decided AS the agent (O46).
    expect(state.entries[0]?.actor).toEqual(
      ActorContextSchema.make({
        _tag: 'Agent',
        agentId: agent,
        connectionId,
        consentRevision: 1,
        principalId: person,
      }),
    );
  }),
);

it.effect('refuses an agent whose connection the engine cannot find, or whose consent revision is stale', () =>
  Effect.gen(function* refusesDeadConnection() {
    const agentCell = cell({ capability: 'finance.invoice.void', holder: agentHolder(), mode: 'propose' });
    const missing = yield* harness({ authority: { cells: [agentCell] }, kinds: kindSource('agent') }).gate.decide(
      gateOf({ legalEntityScope: 'required', scope: agentConnectionScope({ connectionId, revision: 1 }) }),
    );
    expect(missing.reasons.map(({ code }) => code)).toEqual(['deny.connection_inactive']);
    const revoked = yield* harness({
      authority: { cells: [agentCell], connection: connect({ status: 'revoked' }) },
      kinds: kindSource('agent'),
    }).gate.decide(
      gateOf({ legalEntityScope: 'required', scope: agentConnectionScope({ connectionId, revision: 1 }) }),
    );
    expect(revoked.reasons.map(({ code }) => code)).toEqual(['deny.connection_inactive']);
    const stale = yield* harness({
      authority: { cells: [agentCell], connection: connect({ consentRevision: 2 }) },
      kinds: kindSource('agent'),
    }).gate.decide(
      gateOf({ legalEntityScope: 'required', scope: agentConnectionScope({ connectionId, revision: 1 }) }),
    );
    expect(stale.reasons.map(({ code }) => code)).toEqual(['deny.consent_stale']);
  }),
);

it.effect('refuses an agent on an OAuth connection that carries no credential-bound connection', () =>
  Effect.gen(function* refusesUnboundAgent() {
    const { gate } = harness({ kinds: kindSource('agent') });
    const decision = yield* gate.decide(gateOf({ legalEntityScope: 'required', scope: agentConnectionScope() }));
    expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.agent_forbidden']);
  }),
);

it.effect('never admits an agent on an administration declaration, even on a live connection', () =>
  Effect.gen(function* refusesAgentAdministration() {
    const adminCell = cell({ capability: 'core.identity.support.impersonate', holder: agentHolder() });
    const { gate } = harness({
      authority: {
        cells: [adminCell, cell({ capability: 'core.identity.support.impersonate' })],
        connection: connect(),
      },
      kinds: kindSource('agent'),
    });
    const decision = yield* gate.decide(
      gateOf({
        carrier: { accessDeclaration: adminDeclarationOf() },
        legalEntityScope: 'required',
        scope: agentConnectionScope({ connectionId, revision: 1 }),
      }),
    );
    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasons.map(({ code }) => code)).toContain('deny.agent_forbidden');
  }),
);

it.effect('refuses an agent principal with deny.agent_forbidden and never asks the engine', () =>
  Effect.gen(function* refusesAgent() {
    const { gate, state } = harness({ kinds: kindSource('agent') });
    const decision = yield* gate.decide(gateOf({ scope: scopeFor(PrincipalIdSchema.make(uid(4))) }));
    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.agent_forbidden']);
    expect(state.entries.length).toBe(0);
  }),
);

it.effect('refuses a workload principal on a declaration and never grants it', () =>
  Effect.gen(function* refusesWorkloadOnDeclaration() {
    for (const kind of ['integration', 'service', 'system'] as const) {
      const { gate } = harness({ kinds: kindSource(kind) });
      const decision = yield* gate.decide(gateOf());
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_forbidden']);
    }
  }),
);

it.effect('refuses a workload on an admin declaration as an agent, and never as a grant (O81)', () =>
  Effect.gen(function* refusesWorkloadOnAdminDeclaration() {
    for (const kind of ['integration', 'service', 'system'] as const) {
      const { gate } = harness({ kinds: kindSource(kind) });
      const decision = yield* gate.decide(gateOf({ carrier: { accessDeclaration: adminDeclarationOf() } }));
      expect(decision.outcome).toBe('DENIED');
      // Structural admission is for people only, so a machine is refused exactly as an agent is (O81).
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.agent_forbidden']);
    }
    // The negative control: a non-admin declaration keeps the O71 workload vocabulary.
    const ordinary = yield* harness({ kinds: kindSource('service') }).gate.decide(gateOf());
    expect(ordinary.reasons.map(({ code }) => code)).toEqual(['deny.workload_forbidden']);
    // The batch path agrees with the single decision, index for index.
    const batched = yield* harness({ kinds: kindSource('service') }).gate.decideMany([
      gateOf(),
      gateOf({ carrier: { accessDeclaration: adminDeclarationOf() } }),
    ]);
    expect(batched.map(({ reasons }) => reasons.map(({ code }) => code))).toEqual([
      ['deny.workload_forbidden'],
      ['deny.agent_forbidden'],
    ]);
  }),
);

/** A workload-only list question: one scope, the carrier a machine-provisioning entrypoint declares. */
const workloadList: ListGateInput = {
  carrier: workloadCarrier('machine provisioning'),
  legalEntityScope: 'forbidden',
  now,
  scope: scopeFor(person),
};

it.effect('refuses a human on a workload carrier: a v2 decision never admits a workload', () =>
  Effect.gen(function* refusesHumanOnWorkloadCarrier() {
    const { gate } = harness();
    const decision = yield* gate.decide(gateOf({ carrier: workloadCarrier('machine provisioning') }));
    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_only']);
  }),
);

it.effect('admits a bound workload on a workload carrier without asking the engine or logging it', () =>
  Effect.gen(function* admitsBoundWorkload() {
    for (const kind of ['integration', 'service', 'system'] as const) {
      // A failing engine proves the seam never asks it: a decision would surface as UNAVAILABLE.
      const { gate, state } = harness({
        engineFailure: true,
        kinds: kindSource(kind),
        workloadKeys: [BOUND_WORKLOAD],
      });
      const decision = yield* gate.decide(gateOf({ carrier: workloadCarrier('machine identity provisioning') }));
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
      // The workload path is the owner's classification, never a v2 grant, so it leaves no evidence row.
      expect(state.entries.length).toBe(0);
    }
  }),
);

it.effect('refuses an unbound managed key with deny.workload_unbound, never with a grant', () =>
  Effect.gen(function* refusesUnboundWorkload() {
    // The registry holds no binding for this principal, so the kind alone must not admit it (O73).
    for (const kind of ['integration', 'service', 'system'] as const) {
      const { gate, state } = harness({ engineFailure: true, kinds: kindSource(kind) });
      const decision = yield* gate.decide(gateOf({ carrier: workloadCarrier('machine provisioning') }));
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
      expect(state.entries.length).toBe(0);
    }
  }),
);

it.effect('refuses a binding that names another workload than the carrier declares', () =>
  Effect.gen(function* refusesForeignBinding() {
    const { gate } = harness({
      engineFailure: true,
      kinds: kindSource('service'),
      workloadKeys: [OTHER_WORKLOAD],
    });
    const decision = yield* gate.decide(gateOf({ carrier: workloadCarrier('machine provisioning') }));
    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
  }),
);

it.effect('refuses a workload whose only binding was revoked: a revoked key is never active (O73)', () =>
  Effect.gen(function* refusesRevokedBinding() {
    // A revoked binding is absent from the active set the registry answers with.
    const { gate } = harness({ engineFailure: true, kinds: kindSource('service'), workloadKeys: [] });
    const decision = yield* gate.decide(gateOf({ carrier: workloadCarrier('machine provisioning') }));
    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
  }),
);

it.effect('answers UNAVAILABLE when the workload registry cannot be read, never an unbound denial', () =>
  Effect.gen(function* unavailableWorkloadRegistry() {
    const { gate, state } = harness({
      engineFailure: true,
      kinds: kindSource('service'),
      workloadReadFails: true,
    });
    const decision = yield* gate.decide(gateOf({ carrier: workloadCarrier('machine provisioning') }));
    expect(decision.outcome).toBe('UNAVAILABLE');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['unavailable.intent']);
    expect(state.entries.length).toBe(0);
  }),
);

it.effect('routes a dual carrier by actor kind: the bound workload is admitted, the human is decided', () =>
  Effect.gen(function* routesDualCarrier() {
    const dual = {
      accessDeclaration: adminDeclarationOf(),
      ...workloadCarrier('the provisioning workload runs the same Action'),
    };

    const machine = harness({
      authority: { cells: [] },
      kinds: kindSource('service'),
      workloadKeys: [BOUND_WORKLOAD],
    });
    const machineDecision = yield* machine.gate.decide(gateOf({ carrier: dual }));
    expect(machineDecision.outcome).toBe('ALLOWED');
    expect(machineDecision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
    expect(machine.state.entries.length).toBe(0);

    // The declaration path never admits a workload, and the workload path never admits a human.
    const granted = harness({ authority: { cells: [cell({ capability: 'core.identity.support.impersonate' })] } });
    const humanDecision = yield* granted.gate.decide(gateOf({ carrier: dual }));
    expect(humanDecision.outcome).toBe('ALLOWED');
    expect(humanDecision.reasons.map(({ code }) => code)).toEqual(['allow.granted']);
    expect(granted.state.entries.length).toBe(1);

    const ungranted = harness({ authority: { cells: [] } });
    const refused = yield* ungranted.gate.decide(gateOf({ carrier: dual }));
    expect(refused.reasons.map(({ code }) => code)).toEqual(['deny.insufficient_grant']);
  }),
);

it.effect('admits a bound workload entry of a batch while its declaration sibling stays refused', () =>
  Effect.gen(function* batchesWorkloadAndDeclaration() {
    const { gate, state } = harness({
      engineFailure: true,
      kinds: kindSource('system'),
      workloadKeys: [BOUND_WORKLOAD],
    });
    const decisions = yield* gate.decideMany([gateOf(), gateOf({ carrier: workloadCarrier('machine provisioning') })]);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['DENIED', 'ALLOWED']);
    expect(decisions[0]?.reasons.map(({ code }) => code)).toEqual(['deny.workload_forbidden']);
    expect(decisions[1]?.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
    expect(state.entries.length).toBe(0);
  }),
);

it.effect('answers a bound workload list as the whole scope, never as an owner predicate of a grant', () =>
  Effect.gen(function* listsWorkloadScope() {
    const machine = yield* harness({
      engineFailure: true,
      kinds: kindSource('integration'),
      workloadKeys: [BOUND_WORKLOAD],
    }).gate.list(workloadList);
    expect(machine.decision.outcome).toBe('ALLOWED');
    expect(machine.decision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
    // R5a-4: a row-scoped list read needs a predicate; a bound workload sees the whole scope.
    expect(machine.predicate).toEqual({ groups: [] });

    const human = yield* harness({ engineFailure: true, kinds: kindSource('human') }).gate.list(workloadList);
    expect(human.decision.outcome).toBe('DENIED');
    expect(human.decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_only']);
    expect(human.predicate).toBeUndefined();
  }),
);

it.effect('answers a workload list with a predicate even beside a declaration (O67-Q4, R5a-4)', () =>
  Effect.gen(function* listsDualWorkloadScope() {
    const dual: ListGateInput = {
      ...workloadList,
      carrier: { accessDeclaration: declarationOf(), ...workloadCarrier('machine provisioning') },
    };
    const machine = yield* harness({
      engineFailure: true,
      kinds: kindSource('service'),
      workloadKeys: [BOUND_WORKLOAD],
    }).gate.list(dual);
    expect(machine.decision.outcome).toBe('ALLOWED');
    expect(machine.decision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
    expect(machine.predicate).toEqual({ groups: [] });
  }),
);

it.effect('answers UNAVAILABLE for a bound workload list whose registry cannot be read, never a whole scope', () =>
  Effect.gen(function* unavailableWorkloadList() {
    const machine = yield* harness({
      engineFailure: true,
      kinds: kindSource('service'),
      workloadReadFails: true,
    }).gate.list(workloadList);
    expect(machine.decision.outcome).toBe('UNAVAILABLE');
    expect(machine.decision.reasons.map(({ code }) => code)).toEqual(['unavailable.intent']);
    expect(machine.predicate).toBeUndefined();
  }),
);

it.effect('keeps a declaration-only entry of a batch refused when the workload registry is down (R5a-5)', () =>
  Effect.gen(function* keepsDeclarationOnlyRefusalWhenRegistryDown() {
    // A single declaration-only decide already answers deny.workload_forbidden; a batch must agree.
    const alone = yield* harness({
      engineFailure: true,
      kinds: kindSource('service'),
      workloadReadFails: true,
    }).gate.decide(gateOf());
    expect(alone.outcome).toBe('DENIED');
    expect(alone.reasons.map(({ code }) => code)).toEqual(['deny.workload_forbidden']);

    const decisions = yield* harness({
      engineFailure: true,
      kinds: kindSource('service'),
      workloadReadFails: true,
    }).gate.decideMany([gateOf(), gateOf({ carrier: workloadCarrier('machine provisioning') })]);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['DENIED', 'UNAVAILABLE']);
    expect(decisions[0]?.reasons.map(({ code }) => code)).toEqual(['deny.workload_forbidden']);
    expect(decisions[1]?.reasons.map(({ code }) => code)).toEqual(['unavailable.intent']);
  }),
);

it.effect('refuses an unbound workload list as an owner-predicate refusal, not a whole scope', () =>
  Effect.gen(function* refusesUnboundWorkloadList() {
    const machine = yield* harness({ engineFailure: true, kinds: kindSource('service') }).gate.list(workloadList);
    expect(machine.decision.outcome).toBe('DENIED');
    expect(machine.decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
    expect(machine.predicate).toBeUndefined();
  }),
);

it.effect('refuses a protected carrier without any carrier and a principal of no known kind', () =>
  Effect.gen(function* refusesMissingCarrierAndUnknownKind() {
    const missing = yield* harness().gate.decide(gateOf({ carrier: {} }));
    expect(missing.outcome).toBe('DENIED');
    expect(missing.reasons.map(({ code }) => code)).toEqual(['deny.declaration_missing']);
    const unknown = yield* harness({ kinds: kindSource('unknown') }).gate.decide(gateOf());
    expect(unknown.outcome).toBe('DENIED');
    expect(unknown.reasons.map(({ code }) => code)).toEqual(['deny.principal_kind_forbidden']);
  }),
);

it.effect('answers UNAVAILABLE when the identity row cannot be read', () =>
  Effect.gen(function* unavailableIdentity() {
    const decision = yield* harness({ kinds: kindSource('unreadable') }).gate.decide(gateOf());
    expect(decision.outcome).toBe('UNAVAILABLE');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['unavailable.intent']);
  }),
);

it.effect('refuses a request whose scope does not exist rather than inventing one', () =>
  Effect.gen(function* refusesUnknownScope() {
    const decision = yield* harness({ authority: { cells: [] }, scopeMissing: true }).gate.decide(gateOf());
    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.scope_mismatch']);
  }),
);

it.effect('decides an admin capability in its declared scope: tenant context when company-independent', () =>
  Effect.gen(function* adminInTenantContext() {
    const legalEntityId = LegalEntityIdSchema.make(uid(20));
    const { gate, ownership, scopes } = harness({
      authority: { cells: [cell({ capability: 'core.identity.support.impersonate' })] },
    });
    // O81: structural admission follows the declaration's own scope. A company-independent admin key
    // stays in the tenant context even when a company is selected.
    const decision = yield* gate.decide(
      gateOf({
        carrier: { accessDeclaration: adminDeclarationOf() },
        legalEntityScope: 'forbidden',
        scope: scopeFor(person, legalEntityId),
      }),
    );
    expect(decision.outcome).toBe('ALLOWED');
    // The named company is checked by the tenant scope read itself: no ownership read, no holder-less read.
    expect(ownership).toEqual([]);
    expect(scopes.every((query) => query.legalEntityId === undefined && query.holders.length > 0)).toBe(true);
    expect(scopes[0]).toMatchObject({ checkedCompany: legalEntityId });
  }),
);

for (const legalEntityScope of ['optional', 'forbidden', 'required'] as const) {
  it.effect(`refuses a company the asked tenant does not own in ${legalEntityScope} scope`, () =>
    Effect.gen(function* refusesForeignCompany() {
      const foreignCompany = LegalEntityIdSchema.make(uid(22));
      const { gate } = harness({ foreignCompanies: [foreignCompany] });
      const single = yield* gate.decide(gateOf({ legalEntityScope, scope: scopeFor(person, foreignCompany) }));
      const [batched] = yield* gate.decideMany([gateOf({ legalEntityScope, scope: scopeFor(person, foreignCompany) })]);
      for (const decision of [single, batched]) {
        expect(decision?.outcome).toBe('DENIED');
        expect(decision?.reasons.map(({ code }) => code)).toEqual(['deny.scope_mismatch']);
      }
    }),
  );
}

it.effect('refuses a workload in a company its tenant does not own, even one its registration names', () =>
  Effect.gen(function* refusesForeignWorkloadCompany() {
    const ours = LegalEntityIdSchema.make(uid(23));
    const foreignCompany = LegalEntityIdSchema.make(uid(24));
    // The registration names both companies: only the company-of-tenant rule can refuse the foreign one.
    const { gate } = harness({
      declaredCompanies: [ours, foreignCompany],
      engineFailure: true,
      foreignCompanies: [foreignCompany],
      kinds: kindSource('service'),
      workloadKeys: [BOUND_WORKLOAD],
    });
    const carrier = workloadCarrier('the storefront client runs the Action');
    const ask = (company: LegalEntityId) =>
      gateOf({ carrier, legalEntityScope: 'required', scope: scopeFor(person, company) });
    const single = yield* gate.decide(ask(foreignCompany));
    expect(single.outcome).toBe('DENIED');
    expect(single.reasons.map(({ code }) => code)).toEqual(['deny.scope_mismatch']);
    // In one batch, the foreign row is refused, and the rows of the owned company around it are not affected.
    const batched = yield* gate.decideMany([ask(ours), ask(foreignCompany), ask(ours)]);
    expect(batched.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'DENIED', 'ALLOWED']);
    expect(batched[1]?.reasons.map(({ code }) => code)).toEqual(['deny.scope_mismatch']);
    const listed = yield* gate.listMany([
      { ...workloadList, legalEntityScope: 'required', scope: scopeFor(person, foreignCompany) },
      { ...workloadList, legalEntityScope: 'required', scope: scopeFor(person, ours) },
    ]);
    expect(listed.map(({ decision }) => decision.outcome)).toEqual(['DENIED', 'ALLOWED']);
    expect(listed[0]?.predicate).toBeUndefined();
  }),
);

it.effect("answers UNAVAILABLE, never a decision, when a named company cannot be checked to be the tenant's", () =>
  Effect.gen(function* unreadableOwnership() {
    const company = LegalEntityIdSchema.make(uid(25));
    const machine = yield* harness({
      declaredCompanies: [company],
      engineFailure: true,
      kinds: kindSource('service'),
      ownershipFails: true,
      workloadKeys: [BOUND_WORKLOAD],
    }).gate.decide(
      gateOf({
        carrier: workloadCarrier('machine provisioning'),
        legalEntityScope: 'required',
        scope: scopeFor(person, company),
      }),
    );
    expect(machine.outcome).toBe('UNAVAILABLE');
  }),
);

it.effect('decides a company-owned capability in the selected legal-entity scope', () =>
  Effect.gen(function* legalEntityScope() {
    const legalEntityId = LegalEntityIdSchema.make(uid(21));
    const { gate, scopes } = harness();
    yield* gate.decide(gateOf({ legalEntityScope: 'required', scope: scopeFor(person, legalEntityId) }));
    expect(scopes[0]?.legalEntityId).toBe(legalEntityId);
  }),
);

it.effect('refuses a required company scope that the request did not select', () =>
  Effect.gen(function* refusesMissingCompany() {
    const decision = yield* harness().gate.decide(gateOf({ legalEntityScope: 'required' }));
    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.scope_mismatch']);
  }),
);

it.effect('passes the record target and the governed amount to the decision', () =>
  Effect.gen(function* passesTargetAndAmount() {
    const { gate } = harness({
      authority: { cells: [cell({ capability: 'finance.invoice.void', selector: { _tag: 'assigned' } })] },
    });
    const decision = yield* gate.decide(
      gateOf({
        amount: { currency: 'CZK', minor: 1000 },
        carrier: { accessDeclaration: declarationOf({ selectors: ['assigned'] }) },
        target: recordTarget(1),
      }),
    );
    // The record projection does not match the holder, so the record check refuses the cell.
    expect(decision.outcome).toBe('DENIED');
    expect(decision.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
  }),
);

it.effect('records a denial and an approval request, and writes nothing for a routine allow', () =>
  Effect.gen(function* recordsDenialsAndApprovals() {
    const routine = harness({
      authority: { cells: [cell({ capability: 'finance.invoice.comment' })] },
    });
    yield* routine.gate.decide(
      gateOf({
        carrier: {
          accessDeclaration: declarationOf({
            key: 'finance.invoice.comment',
            modes: ['run'],
            risk: 'routine',
          }),
        },
      }),
    );
    expect(routine.state.entries.length).toBe(0);

    const denied = harness({ authority: { cells: [] } });
    yield* denied.gate.decide(gateOf());
    expect(denied.state.entries[0]?.outcome).toBe('DENIED');

    const unavailable = harness({ engineFailure: true });
    yield* unavailable.gate.decide(gateOf());
    expect(unavailable.state.entries.length).toBe(0);
  }),
);

it.effect('answers UNAVAILABLE instead of an unrecorded sensitive allow when the evidence store fails', () =>
  Effect.gen(function* refusesUnrecordedSensitiveAllow() {
    const decision = yield* harness({ logFails: true }).gate.decide(gateOf());
    expect(decision.outcome).toBe('UNAVAILABLE');
    expect(decision.reasons.map(({ code }) => code)).toEqual(['unavailable.evidence']);
  }),
);

/** A navigation entry: a protected routine Action of the finance module that only runs. */
const navigationKeys = Array.from({ length: 20 }, (_unused, index) => `finance.invoice.nav-${String(index + 1)}`);
const navigationDeclaration = (key: string) => declarationOf({ key, modes: ['run'], risk: 'routine' });

it.effect('answers a 20-entry navigation from one engine snapshot, identically to 20 decisions', () =>
  Effect.gen(function* answersNavigationInOneSnapshot() {
    const spec: AuthoritySpec = { cells: navigationKeys.map((key) => cell({ capability: key })) };
    const authority = makeAuthority(spec);
    const identity = { reads: 0 };
    const countingKinds: AccessPrincipalKinds = {
      readKind: (query) => {
        identity.reads += 1;
        return kindSource('human').readKind(query);
      },
    };
    const check = makeCheck({ authority: spec });
    const { log, state } = logWriter();
    const gate = makeAccessDecisionService({
      authorityFor: () => authority.port,
      check: check.port,
      decisionLog: log,
      legalEntities: legalEntityCandidates([]),
      principalKinds: countingKinds,
      workloadBindings: {
        readWorkloadAuthority: () => Effect.succeed({ activeCompanyIds: new Set(), workloadKeys: new Set() }),
      },
    });
    const inputs = navigationKeys.map((key) => gateOf({ carrier: { accessDeclaration: navigationDeclaration(key) } }));
    const measure = () => {
      const read = {
        checkBulk: check.calls.checkBulk,
        identity: identity.reads,
        items: check.calls.items,
        scope: authority.calls.readScope,
      };
      identity.reads = 0;
      authority.calls.readScope = 0;
      authority.calls.readCells = 0;
      check.calls.checkBulk = 0;
      check.calls.items = 0;
      return read;
    };

    measure();
    // The shape `decideMany` replaced: one full decision per entry, four at a time.
    const alone: readonly AccessDecision[] = yield* Effect.all(
      inputs.map((one) => gate.decide(one)),
      { concurrency: 4 },
    );
    const before = measure();

    const batched = yield* gate.decideMany(inputs);
    const after = measure();

    // Answer for answer the same, but from ONE snapshot: 20 engine calls became 1, and the
    // identity and membership reads of 20 entries became one each.
    expect(batched).toEqual(alone);
    expect(batched.filter(({ outcome }) => outcome === 'ALLOWED').length).toBe(20);
    expect(before).toEqual({ checkBulk: 20, identity: 20, items: 80, scope: 40 });
    expect(after).toEqual({ checkBulk: 1, identity: 1, items: 80, scope: 2 });
    // A routine allow and a plain denial leave no evidence row, exactly as one `decide` does.
    expect(state.entries.length).toBe(0);
  }),
);

it.effect('carries the asker of every entry of a batch (O86)', () =>
  Effect.gen(function* carriesTheAskerInABatch() {
    const { gate, state } = harness();
    const asker = PrincipalIdSchema.make(uid(8));
    const decisions = yield* gate.decideMany([gateOf({ onBehalfOfPrincipalId: asker }), gateOf()]);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'ALLOWED']);
    expect(state.entries.map(({ onBehalfOfPrincipalId }) => onBehalfOfPrincipalId)).toEqual([asker, undefined]);
  }),
);

it.effect('refuses one entry of a batch without touching its siblings', () =>
  Effect.gen(function* refusesOneEntryOfABatch() {
    const { gate, state } = harness();
    const decisions = yield* gate.decideMany([
      gateOf(),
      gateOf({ carrier: workloadCarrier('machine provisioning') }),
      gateOf({ carrier: {} }),
      gateOf(),
    ]);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'DENIED', 'DENIED', 'ALLOWED']);
    expect(decisions[1]?.reasons.map(({ code }) => code)).toEqual(['deny.workload_only']);
    expect(decisions[2]?.reasons.map(({ code }) => code)).toEqual(['deny.declaration_missing']);
    // Two sensitive allows leave two evidence rows; the two refusals leave none.
    expect(state.entries.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'ALLOWED']);
  }),
);

it.effect('answers a batch UNAVAILABLE when the engine fails, and records no evidence of it', () =>
  Effect.gen(function* failsWholeBatchAsUnavailable() {
    const { gate, state } = harness({ engineFailure: true });
    const decisions = yield* gate.decideMany([gateOf(), gateOf()]);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['UNAVAILABLE', 'UNAVAILABLE']);
    expect(state.entries.length).toBe(0);
  }),
);

it.effect('writes the evidence rows of a batch in one batch write, with the rows the single writer gets', () =>
  Effect.gen(function* writesBatchEvidenceOnce() {
    // One request scope, as the Action authority and the caller's module authority ask in.
    const scope = scopeFor(person);
    const inputs = [
      gateOf({ scope }),
      gateOf({ carrier: workloadCarrier('machine provisioning'), scope }),
      gateOf({ scope }),
    ];
    // One authority for both runs, so both decide over the very same cells.
    const authority: AuthoritySpec = { cells: [cell({ capability: 'finance.invoice.void' })] };
    const single = harness({ authority });
    const alone = yield* single.gate.decideMany(inputs);
    const batched = harness({ authority, batchLog: 'writes' });
    const decisions = yield* batched.gate.decideMany(inputs);
    expect(decisions).toEqual(alone);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'DENIED', 'ALLOWED']);
    // No row through the single writer; one batch write holding exactly the rows it would have written.
    expect(batched.state.entries).toEqual([]);
    expect(batched.batches).toHaveLength(1);
    expect(batched.batches[0]).toEqual(single.state.entries);
  }),
);

it.effect('answers UNAVAILABLE for every decision whose evidence batch was not kept', () =>
  Effect.gen(function* unkeptBatchEvidence() {
    const { batches, gate, state } = harness({ batchLog: 'fails' });
    const decisions = yield* gate.decideMany([
      gateOf(),
      gateOf({ carrier: workloadCarrier('machine provisioning') }),
      gateOf(),
    ]);
    // The two sensitive allows needed rows; the refusal before the engine needed none and stays a denial.
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['UNAVAILABLE', 'DENIED', 'UNAVAILABLE']);
    expect(batches).toEqual([]);
    expect(state.entries).toEqual([]);
  }),
);

it.effect('answers an empty batch with no decision and no engine call', () =>
  Effect.gen(function* answersEmptyBatch() {
    const { gate } = harness();
    expect(yield* gate.decideMany([])).toEqual([]);
  }),
);

it.effect('answers a list as an owner predicate and refuses a list without authority', () =>
  Effect.gen(function* listsPages() {
    const granted = harness({ authority: { cells: [cell({ capability: 'finance.invoice.void' })] } });
    const listing = yield* granted.gate.list({
      carrier: { accessDeclaration: declarationOf() },
      legalEntityScope: 'forbidden',
      now,
      scope: scopeFor(person),
    });
    expect(listing.decision.outcome).toBe('ALLOWED');
    expect(listing.predicate).toBeDefined();

    const refused = harness({ authority: { cells: [] } });
    const deniedListing = yield* refused.gate.list({
      carrier: { accessDeclaration: declarationOf() },
      legalEntityScope: 'forbidden',
      now,
      scope: scopeFor(person),
    });
    expect(deniedListing.decision.outcome).toBe('DENIED');
    expect(deniedListing.predicate).toBeUndefined();
  }),
);

it.effect('answers the companies the actor may select, and none for an agent', () =>
  Effect.gen(function* selectableCompanies() {
    const first = LegalEntityIdSchema.make(uid(31));
    const second = LegalEntityIdSchema.make(uid(32));
    const asked: { readonly items: number }[] = [];
    const counting: DecisionCheckPort = {
      checkBulk: (items) => {
        asked.push({ items: items.length });
        expect(items[0]?.permission).toBe('select');
        expect(items[0]?.resource.type).toBe('access_legal_entity');
        // Only the first company answers `select`; the second is out of this actor's reach.
        return Effect.succeed(
          items.map((_item, index) => ({ permissionship: index === 0 ? ('has' as const) : ('none' as const) })),
        );
      },
    };
    const selected = yield* harness({
      authority: { cells: [] },
      check: counting,
      selectableLegalEntities: [first, second],
    }).gate.selectableLegalEntities({ now, scope: scopeFor(person) });
    expect(selected).toEqual([first]);
    expect(asked[0]?.items).toBe(2);

    // An agent never selects a company in this wave; the seam answers none rather than an error.
    const agentScope = scopeFor(PrincipalIdSchema.make(agent));
    expect(
      yield* harness({ kinds: kindSource('agent') }).gate.selectableLegalEntities({ now, scope: agentScope }),
    ).toEqual([]);
  }),
);

it.effect('fails the company list when the engine cannot answer for every company', () =>
  Effect.gen(function* failsUnansweredCompanies() {
    const legalEntityId = LegalEntityIdSchema.make(uid(41));
    const { gate } = harness({
      authority: { cells: [] },
      check: makeCheck({ authority: { cells: [] }, missingResults: 1 }).port,
      selectableLegalEntities: [legalEntityId],
    });
    const outcome = yield* Effect.matchEffect(gate.selectableLegalEntities({ now, scope: scopeFor(person) }), {
      onFailure: (failure) => Effect.succeed(failure._tag),
      onSuccess: () => Effect.succeed('answered'),
    });
    expect(outcome).toBe('AccessDecisionUnavailable');
  }),
);

it.effect(
  'answers an Action batch through the real gate exactly as one decision per Action, for every company rule',
  () =>
    Effect.gen(function* realGateActionBatch() {
      const company = LegalEntityIdSchema.make(uid(60));
      const authority: AuthoritySpec = {
        cells: [cell({ capability: 'finance.invoice.void' })],
        legalEntityScope: { _tag: 'LegalEntity', legalEntityId: company, tenantId: tenant },
      };
      const voiding = { accessDeclaration: declarationOf() };
      const archiving = { accessDeclaration: declarationOf({ key: 'finance.invoice.archive' }) };
      const declared = new Map<string, DeclaredActionAuthority>(
        (
          [
            ['finance.void-in-company', voiding, 'required'],
            ['finance.void-anywhere', voiding, 'optional'],
            ['finance.void-tenant', voiding, 'forbidden'],
            ['finance.archive-in-company', archiving, 'required'],
          ] as const
        ).map(([actionKey, carrier, legalEntityScope]) => [actionKey, { actionKey, carrier, legalEntityScope }]),
      );
      const actionKeys = [...declared.keys(), 'unpublished.action'];
      const outcomes: string[][] = [];
      for (const scope of [scopeFor(person, company), scopeFor(person)]) {
        const single = harness({ authority });
        const alone = yield* Effect.forEach(
          actionKeys,
          (actionKey) =>
            single.gate.decide({
              carrier: declared.get(actionKey)?.carrier ?? {},
              legalEntityScope: declared.get(actionKey)?.legalEntityScope ?? 'optional',
              now,
              scope,
            }),
          { concurrency: 1 },
        );
        const batched = harness({ authority });
        const answers = yield* makeActionAuthorityService({ declared, gate: batched.gate, now }).checkActionAuthorities(
          {
            actionKeys,
            scope,
          },
        );
        expect(answers.map(({ execute, propose }) => [execute, propose])).toEqual(
          alone.map(({ outcome }) => [
            outcome === 'ALLOWED' ? 'allowed' : 'denied',
            outcome === 'DENIED' ? 'denied' : 'allowed',
          ]),
        );
        expect(batched.state.entries).toEqual(single.state.entries);
        outcomes.push(alone.map(({ outcome }) => outcome));
      }
      // The company rules really differ: a company-required Action needs a selected company, the others run in
      // either context, and an ungranted or unpublished Action is denied in both.
      expect(outcomes).toEqual([
        ['ALLOWED', 'ALLOWED', 'ALLOWED', 'DENIED', 'DENIED'],
        ['DENIED', 'ALLOWED', 'ALLOWED', 'DENIED', 'DENIED'],
      ]);
    }),
);

/** A finite Privacy dispatch: the Symmy retention Action a human's governance company delegates to Privacy. */
const privacyDispatchGate = (governance: LegalEntityId) =>
  Effect.gen(function* privacyDispatchInput() {
    const principal = privacyDispatchPrincipal(scopeFor(person, governance), 'SymmyRetention', 'c'.repeat(64));
    const scope = preserveSystemPrincipalContextTrust(principal, {
      ...principal,
      correlationId: 'privacy-denial-evidence',
    });
    const accessActor = yield* Schema.decodeUnknownEffect(AccessActorSchema)({
      callers: ['symmy-integration'],
      reason: 'Exact native Privacy dispatch owner operation',
      subject: 'identity',
    });
    const declaration = decodeAccessDeclarationOrThrow(
      {
        key: 'integration.symmy.symmy-retention.execute',
        kind: 'action',
        modes: ['run', 'propose', 'approve'],
        placement: { group: 'symmy', level: 'extended' },
        risk: 'critical',
        selectors: [],
      },
      { access: 'write', authorization: { kind: 'protected' }, moduleKey: 'integration.symmy', role: 'action' },
    );
    const input: GateInput = {
      carrier: {
        accessActor,
        accessDeclaration: declaration,
        entrypoint: { entrypointKey: 'integration.symmy.execute-symmy-retention' },
        schemaVersion: '1',
      },
      legalEntityScope: 'optional',
      now,
      scope,
    };
    return input;
  });

it.effect('records delegated finite Privacy refusals for current source-claim and governance permission denials', () =>
  Effect.gen(function* privacyDispatchRefusalEvidence() {
    const governance = LegalEntityIdSchema.make(uid(71));
    const input = yield* privacyDispatchGate(governance);
    for (const privacyDispatchLive of [false, true]) {
      const { gate, state } = harness({ privacyDispatchLive });
      const decision = yield* gate.decide(input);
      expect(decision.outcome).toBe('DENIED');
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.delegation?.appId).toBe('symmy-integration');
      expect(state.entries[0]?.actor.principalId).toBe(person);
      expect(state.entries[0]?.scope.legalEntityId).toBe(governance);
      expect(state.entries[0]?.outcome).toBe('DENIED');
    }
  }),
);

/** A finite gateway read: Privacy reads Organization facts for the human it acts for, in the governance company. */
const organizationGovernanceGate = (governance: LegalEntityId) =>
  Effect.gen(function* organizationGovernanceInput() {
    const nativeHuman = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      ...scopeFor(person, governance),
      authenticationNamespaceId: 'core-identity',
    });
    const admitted = organizationGovernanceReadPrincipal(nativeHuman, 'e'.repeat(64));
    const scope = preserveSystemPrincipalContextTrust(admitted, { ...admitted, correlationId: 'org-human-read' });
    const accessActor = yield* Schema.decodeUnknownEffect(AccessActorSchema)({
      callers: ['privacy'],
      reason: 'Exact governed Organization source facts',
      subject: 'identity',
    });
    const declaration = decodeAccessDeclarationOrThrow(
      {
        key: 'integration.symmy.symmy-source-organization-facts.read',
        kind: 'read',
        modes: ['run'],
        placement: { group: 'symmy', level: 'extended' },
        risk: 'routine',
        selectors: [],
      },
      { access: 'read', authorization: { kind: 'protected' }, moduleKey: 'integration.symmy', role: 'api' },
    );
    const input: GateInput = {
      carrier: {
        accessActor,
        accessDeclaration: declaration,
        entrypoint: { entrypointKey: 'integration.symmy.api.symmy-source-organization-facts' },
        schemaVersion: '1',
      },
      legalEntityScope: 'required',
      now,
      scope,
    };
    return { declaration, input };
  });

it.effect('requires the original human Organization facts Read grant despite an identity-only module carrier', () =>
  Effect.gen(function* organizationGovernanceUsesHumanRights() {
    const governance = LegalEntityIdSchema.make(uid(72));
    const { declaration, input } = yield* organizationGovernanceGate(governance);
    for (const granted of [false, true]) {
      const { gate, state } = harness({
        authority: {
          cells: granted ? [cell({ capability: declaration.key })] : [],
          legalEntityScope: { _tag: 'LegalEntity', legalEntityId: governance, tenantId: tenant },
        },
      });
      expect((yield* gate.decide(input)).outcome).toBe(granted ? 'ALLOWED' : 'DENIED');
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.scope.legalEntityId).toBe(governance);
      expect(state.entries[0]?.delegation?.appId).toBe('privacy');
    }
    const machine = harness({ kinds: kindSource('integration') });
    expect((yield* machine.gate.decide(input)).outcome).toBe('DENIED');
  }),
);

it.effect(
  'requires the finite processing marker for the exact normal V4 SourceFacts target even with an active workload binding',
  () =>
    Effect.gen(function* normalV4SourceFactsRequiresRestriction() {
      const workloadKey = WorkloadKeySchema.make('integration.symmy.source-organization-facts.read');
      const declaration = decodeAccessDeclarationOrThrow(
        {
          key: 'integration.symmy.symmy-source-organization-facts.read',
          kind: 'read',
          modes: ['run'],
          placement: { group: 'symmy', level: 'extended' },
          risk: 'routine',
          selectors: [],
        },
        { access: 'read', authorization: { kind: 'protected' }, moduleKey: 'integration.symmy', role: 'api' },
      );
      for (const restricted of [false, true]) {
        const principal = organizationProcessingReadPrincipal('f'.repeat(64), restricted);
        const scope = preserveSystemPrincipalContextTrust(principal, {
          ...principal,
          correlationId: 'processing-marker-gate',
          legalEntityId: uid(2),
        });
        // The merged gate pins a standalone workload to the companies its binding declares (D6).
        const { gate } = harness({
          declaredCompanies: [LegalEntityIdSchema.make(uid(2))],
          kinds: kindSource('system'),
          workloadKeys: [workloadKey],
        });
        const decision = yield* gate.decide({
          carrier: {
            accessDeclaration: declaration,
            accessWorkload: {
              reason: 'Finite native organization processing read',
              requestPurpose: 'PROCESSING',
              workloads: [workloadKey],
            },
            entrypoint: { entrypointKey: 'integration.symmy.api.symmy-source-organization-facts' },
            schemaVersion: '1',
          },
          legalEntityScope: 'required',
          now,
          scope,
        });
        expect(decision.outcome).toBe(restricted ? 'ALLOWED' : 'DENIED');
      }
    }),
);

/*
 * A page of LISTs answered together: every LIST exactly as `list` answers it alone (decision, predicate, evidence
 * row), its seam answers untouched, and every LIST that reaches the engine in one cell read and one snapshot.
 */
const listPage: readonly ListGateInput[] = [
  { carrier: { accessDeclaration: declarationOf() }, legalEntityScope: 'forbidden', now, scope: scopeFor(person) },
  {
    carrier: {
      accessDeclaration: decodeAccessDeclarationOrThrow(
        {
          key: 'finance.invoice.read',
          kind: 'read',
          modes: ['run'],
          placement: { group: 'finance', level: 'extended' },
          risk: 'routine',
          selectors: ['assigned'],
        },
        { access: 'read', authorization: { kind: 'protected' }, moduleKey: 'finance', role: 'api' },
      ),
    },
    legalEntityScope: 'forbidden',
    now,
    scope: scopeFor(person),
  },
  {
    carrier: { accessDeclaration: declarationOf({ key: 'finance.invoice.archive' }) },
    legalEntityScope: 'forbidden',
    now,
    scope: scopeFor(person),
  },
  workloadList,
  { carrier: {}, legalEntityScope: 'forbidden', now, scope: scopeFor(person) },
  { carrier: { accessDeclaration: declarationOf() }, legalEntityScope: 'required', now, scope: scopeFor(person) },
];

for (const options of [
  {},
  { batchLog: 'writes' },
  { batchLog: 'fails' },
  { logFails: true },
  { engineFailure: true },
  { kinds: kindSource('integration'), workloadKeys: [BOUND_WORKLOAD] },
  {
    authority: {
      cells: [
        cell({ capability: 'finance.invoice.void' }),
        cell({ capability: 'finance.invoice.read', selector: { _tag: 'assigned' } }),
      ],
    },
  },
] as const satisfies readonly RunOptions[]) {
  it.effect(`answers a page of LISTs exactly as one list at a time (${JSON.stringify(options)})`, () =>
    Effect.gen(function* listPageTogether() {
      // One authority for both runs (each `cell()` is a new grant), so their answers are comparable.
      const shared = {
        ...options,
        authority: options.authority ?? { cells: [cell({ capability: 'finance.invoice.void' })] },
      };
      // A single list never writes through the batch writer: its failing counterpart is the failing single writer.
      const alone = harness(
        'batchLog' in shared && shared.batchLog === 'fails' ? { authority: shared.authority, logFails: true } : shared,
      );
      const one = yield* Effect.forEach(listPage, (input) => alone.gate.list(input), { concurrency: 1 });
      const together = harness(shared);
      const many = yield* together.gate.listMany(listPage);
      expect(many).toEqual(one);
      // The same evidence rows, row for row (the batch writer keeps them per scope, the single writer one by one).
      const rowsOf = (run: ReturnType<typeof harness>) => [...run.state.entries, ...run.batches.flat()];
      expect(rowsOf(together)).toEqual(rowsOf(alone));
      // One engine snapshot for the whole page, however many LISTs reach the engine.
      expect(together.check.calls.checkBulk).toBeLessThanOrEqual(1);
      expect(together.check.calls.checkBulk).toBeLessThanOrEqual(alone.check.calls.checkBulk);
    }),
  );
}

it.effect("reads one subject's kind and scope once for a page of LISTs, never once per LIST", () =>
  Effect.gen(function* sharedPreamble() {
    const kindReads = { count: 0 };
    const human = kindSource('human');
    const counting: AccessPrincipalKinds = {
      ...human,
      readKind: (query, transaction) =>
        Effect.suspend(() => {
          kindReads.count += 1;
          return human.readKind(query, transaction);
        }),
    };
    const page = Array.from({ length: 5 }, () => listPage[0]).filter((one) => one !== undefined);
    const shared = { authority: { cells: [cell({ capability: 'finance.invoice.void' })] }, kinds: counting };
    const alone = harness(shared);
    const one = yield* Effect.forEach(page, (input) => alone.gate.list(input), { concurrency: 1 });
    const aloneKinds = kindReads.count;
    kindReads.count = 0;
    const together = harness(shared);
    expect(yield* together.gate.listMany(page)).toEqual(one);
    expect({ kinds: aloneKinds, scopes: alone.scopes.length }).toEqual({ kinds: 5, scopes: 10 });
    expect({ kinds: kindReads.count, scopes: together.scopes.length }).toEqual({ kinds: 1, scopes: 1 });
  }),
);

it.effect('a page of LISTs with a company selected reads its scope once: the engine takes the checked read', () =>
  Effect.gen(function* checkedScopeShared() {
    const company = LegalEntityIdSchema.make(uid(26));
    // Tenant-context declarations asked with a company selected: the gate checks the company in its scope read.
    const page = listPage.map((input) => ({ ...input, scope: scopeFor(person, company) }));
    const shared = { authority: { cells: [cell({ capability: 'finance.invoice.void' })] } };
    const alone = harness(shared);
    const one = yield* Effect.forEach(page, (input) => alone.gate.list(input), { concurrency: 1 });
    const together = harness(shared);
    expect(yield* together.gate.listMany(page)).toEqual(one);
    // The tenant-context LISTs: one checked read, the engine's company-less read of the same holders answered by it.
    // The one `required` LIST reads its company. Two reads, as on trunk; before this, the engine's read was a third.
    expect(together.scopes.map((query) => [query.legalEntityId, query.checkedCompany])).toEqual([
      [undefined, company],
      [company, undefined],
    ]);
  }),
);

it.effect('answers a page holding a finite gateway read or Privacy dispatch LIST by LIST, exactly as list alone', () =>
  Effect.gen(function* finiteReadsListedAlone() {
    const governance = LegalEntityIdSchema.make(uid(73));
    const { declaration, input: organizationRead } = yield* organizationGovernanceGate(governance);
    const privacyDispatch = yield* privacyDispatchGate(governance);
    const [ordinary] = listPage;
    const allowed: string[] = [];
    for (const granted of [false, true]) {
      for (const privacyDispatchLive of [false, true]) {
        const options: RunOptions = {
          authority: {
            cells: [cell({ capability: 'finance.invoice.void' }), cell({ capability: declaration.key })].slice(
              0,
              granted ? 2 : 1,
            ),
            legalEntityScope: { _tag: 'LegalEntity', legalEntityId: governance, tenantId: tenant },
          },
          privacyDispatchLive,
        };
        for (const page of [
          [organizationRead],
          [privacyDispatch],
          [ordinary, organizationRead, privacyDispatch, organizationRead].filter((one) => one !== undefined),
        ]) {
          const alone = harness(options);
          const one = yield* Effect.forEach(page, (input) => alone.gate.list(input), { concurrency: 1 });
          const together = harness(options);
          expect(yield* together.gate.listMany(page)).toEqual(one);
          expect(together.state.entries).toEqual(alone.state.entries);
          allowed.push(...one.flatMap(({ decision }) => (decision.outcome === 'ALLOWED' ? [decision.outcome] : [])));
        }
      }
    }
    // The comparison is not vacuous: a granted human's governance read is allowed, the rest refused.
    expect(allowed.length).toBeGreaterThan(0);
  }),
);

it.effect("never shares a scope read through a caller's transaction across a page of LISTs", () =>
  Effect.gen(function* joinedScopeNotShared() {
    const spec = { cells: [cell({ capability: 'finance.invoice.void' })] };
    const authority = makeAuthority(spec);
    const scopeReads = { count: 0 };
    // A port that reads through a caller's transaction: every read is that caller's own.
    const joined: DecisionAuthorityPort = {
      ...authority.port,
      readScope: (query) =>
        Effect.suspend(() => {
          scopeReads.count += 1;
          return authority.port.readScope(query);
        }),
      readsThroughCallerTransaction: true,
    };
    const { log } = logWriter();
    const gate = makeAccessDecisionService({
      authorityFor: () => joined,
      check: makeCheck({ authority: spec }).port,
      decisionLog: log,
      legalEntities: legalEntityCandidates([]),
      principalKinds: kindSource('human'),
    });
    const page = Array.from({ length: 3 }, () => listPage[0]).filter((one) => one !== undefined);
    yield* gate.listMany(page);
    // Each LIST reads its scope itself (the gate's check and the engine's resolution), as `list` would.
    expect(scopeReads.count).toBe(6);
  }),
);
