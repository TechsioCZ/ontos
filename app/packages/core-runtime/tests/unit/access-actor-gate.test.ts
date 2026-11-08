import { Effect, Match, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  preserveSystemPrincipalContextTrust,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import type { VerifiedGatewayActor } from '../../src/auth/system-principal-context-provenance.ts';
import { decodeAccessActor, decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type {
  AccessActorInput,
  AccessDeclaration,
  AccessDeclarationInput,
} from '../../src/authorization/access-declaration.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { makeOwnerApplicationCompositionFixture } from '../../src/testing/module-contract.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import type { AccessPrincipalKinds, AccessPrincipalKind } from '../../src/access/enforcement/actor.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { DecisionAuthorityPort } from '../../src/access/decision/authority.ts';
import type { GateCarrier, GateInput, ListGateInput } from '../../src/access/enforcement/contract.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import type { AccessDecisionLogEntry, AccessDecisionLogWriter } from '../../src/access/enforcement/decision-log.ts';
import type { AccessLegalEntityCandidates } from '../../src/access/enforcement/legal-entities.ts';
import type { AccessWorkloadBindings } from '../../src/access/enforcement/workload-port.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { LegalEntityIdSchema } from '../../src/access/ids.ts';
import { at, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const now = at('2026-11-04T12:00:00Z');
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const REVISION = 'c'.repeat(64);

/** A protected Action entrypoint: the declaration reads its role, so the fixture needs one (D5). */
const ACTION_OWNER = {
  access: 'write',
  authorization: { kind: 'protected' },
  moduleKey: 'finance',
  role: 'action',
} as const;

const declarationOf = (): AccessDeclaration =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'finance.invoice.void',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'finance', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    } satisfies AccessDeclarationInput,
    ACTION_OWNER,
  );

const actorDeclaration = (overrides: Partial<AccessActorInput> = {}) =>
  Result.getOrThrow(
    decodeAccessActor(
      {
        callers: ['commerce-order'],
        reason: 'The order approval consumer acts for the buyer',
        subject: 'identity',
        ...overrides,
      },
      ACTION_OWNER,
    ),
  );

/** The verified calling module of a delegated call, as the Shell signs it (D4). */
const callerOf = (appId: string): VerifiedGatewayActor => ({
  appId,
  buildMarker: 'commerce-order-build',
  principalId: uid(90),
});

/** The integration principal of the storefront workload: a workload subject, never a person (workload subject). */
const workloadPrincipal = uid(80);
const storefront = 'commerce.storefront-client';

const workloadActorDeclaration = (overrides: Partial<AccessActorInput> = {}) =>
  actorDeclaration({ subjectWorkloads: [storefront], ...overrides });

/** A registry that binds `keys` to one principal; any other principal holds no binding. */
const workloadRegistry = (keys: readonly string[], principal: string = workloadPrincipal): AccessWorkloadBindings => ({
  readActiveWorkloadKeys: (query) =>
    Effect.succeed(new Set(query.principalId === principal && query.tenantId === tenant ? keys : [])),
});

const unreadableRegistry: AccessWorkloadBindings = {
  readActiveWorkloadKeys: () => Effect.fail(accessDecisionUnavailable('the workload registry is unreadable')),
};

/**
 * The trusted scope of a delegated call: the subject's context, with the calling module sealed beside it
 * the same way the gateway verifier and the scope resolver seal it (D4).
 */
const delegatedScopeOf = (
  actor: VerifiedGatewayActor,
  subject: string = person,
  legalEntityId?: string,
): OperationalScope => {
  const session = {
    authBindingId: uid(70),
    authContextRef: 'gateway-delegated-session',
    authMethod: 'session' as const,
    principalId: subject,
    tenantId: tenant,
  };
  const context = Schema.decodeSync(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  );
  const trusted = trustVerifiedGatewayPrincipalContext(context, REVISION, undefined, actor);
  return preserveSystemPrincipalContextTrust(
    trusted,
    Object.freeze({ ...trusted, correlationId: 'access-actor-gate' }),
  );
};

const kindSource = (kind: AccessPrincipalKind): AccessPrincipalKinds => ({
  readKind: () => Effect.succeed(Option.some(kind)),
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

const noLegalEntities: AccessLegalEntityCandidates = { listCandidateIds: () => Effect.succeed([]) };

/**
 * The scope read of a real intent loader: a holder with no live membership resolves no scope (R5a-1). `members`
 * names the principals that hold one; an absent list keeps every holder a member.
 */
const membersOnly = (port: DecisionAuthorityPort, members: readonly string[] | undefined): DecisionAuthorityPort =>
  members === undefined
    ? port
    : {
        ...port,
        readScope: (query) =>
          query.holders.every((holder) =>
            Match.value(holder).pipe(
              Match.tag('Principal', ({ principalId }) => members.includes(principalId)),
              Match.orElse(() => false),
            ),
          )
            ? port.readScope(query)
            : Effect.succeed(Option.none()),
      };

const harness = (
  options: {
    readonly authority?: AuthoritySpec;
    readonly kinds?: AccessPrincipalKinds;
    readonly legalEntities?: AccessLegalEntityCandidates;
    readonly logFails?: boolean;
    readonly members?: readonly string[];
    readonly workloads?: AccessWorkloadBindings;
  } = {},
) => {
  const authoritySpec: AuthoritySpec = options.authority ?? {
    cells: [cell({ capability: 'finance.invoice.void' })],
  };
  const authority = makeAuthority(authoritySpec);
  const check = makeCheck({ authority: authoritySpec });
  const port: DecisionAuthorityPort = membersOnly(authority.port, options.members);
  const { log, state } = logWriter(options.logFails === true);
  const gate = makeAccessDecisionService({
    authorityFor: () => port,
    check: check.port,
    decisionLog: log,
    legalEntities: options.legalEntities ?? noLegalEntities,
    principalKinds: options.kinds ?? kindSource('human'),
    workloadBindings: options.workloads ?? workloadRegistry([]),
  });
  return { authority, check, gate, state };
};

const gateOf = (carrier: GateCarrier, scope: OperationalScope): GateInput => ({
  carrier,
  legalEntityScope: 'forbidden',
  now,
  scope,
});

const codesOf = (decision: { readonly reasons: readonly { readonly code: string }[] }) =>
  decision.reasons.map(({ code }) => code);

it.effect(
  'refuses a module call on a carrier that declares no accessActor, and records both identities (D6 step 1)',
  () =>
    Effect.gen(function* refusesCarrierWithoutActor() {
      const caller = callerOf('commerce-order');
      const { gate, state } = harness();
      const decision = yield* gate.decide(gateOf({ accessDeclaration: declarationOf() }, delegatedScopeOf(caller)));
      expect(decision.outcome).toBe('DENIED');
      expect(codesOf(decision)).toEqual(['deny.actor_forbidden']);
      expect(state.entries.length).toBe(1);
      expect(state.entries[0]?.actor.principalId).toBe(person);
      expect(state.entries[0]?.delegation).toEqual({ appId: 'commerce-order', principalId: caller.principalId });
    }),
);

it.effect(
  'refuses a calling module that is not one of the declared callers, and records both identities (D6 step 2)',
  () =>
    Effect.gen(function* refusesUnboundCaller() {
      const caller = callerOf('party-registry');
      const { gate, state } = harness();
      const decision = yield* gate.decide(
        gateOf({ accessActor: actorDeclaration(), accessDeclaration: declarationOf() }, delegatedScopeOf(caller)),
      );
      expect(decision.outcome).toBe('DENIED');
      expect(codesOf(decision)).toEqual(['deny.actor_unbound']);
      expect(state.entries.length).toBe(1);
      expect(state.entries[0]?.actor.principalId).toBe(person);
      expect(state.entries[0]?.delegation).toEqual({ appId: 'party-registry', principalId: caller.principalId });
    }),
);

it.effect('refuses an unbound caller on a declarationless identity carrier with the same evidence row', () =>
  Effect.gen(function* refusesUnboundCallerWithoutDeclaration() {
    const { gate, state } = harness({ authority: { cells: [] } });
    const decision = yield* gate.decide(
      gateOf({ accessActor: actorDeclaration({ subject: 'identity' }) }, delegatedScopeOf(callerOf('party-registry'))),
    );
    expect(codesOf(decision)).toEqual(['deny.actor_unbound']);
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.capability.capabilityKey).toBe('core.access.actor-identity');
    expect(state.entries[0]?.delegation?.appId).toBe('party-registry');
  }),
);

it.effect('refuses a legal-entity carrier without a company on the delegated path, with its delegated row', () =>
  Effect.gen(function* refusesMissingCompanyWithoutDeclaration() {
    const caller = callerOf('commerce-order');
    const { gate, state } = harness({ authority: { cells: [] } });
    const decision = yield* gate.decide({
      carrier: { accessActor: actorDeclaration({ subject: 'identity' }) },
      legalEntityScope: 'required',
      now,
      scope: delegatedScopeOf(caller),
    });
    expect(decision.outcome).toBe('DENIED');
    expect(codesOf(decision)).toEqual(['deny.scope_mismatch']);
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.actor.principalId).toBe(person);
    expect(state.entries[0]?.delegation).toEqual({ appId: 'commerce-order', principalId: caller.principalId });
  }),
);

it.effect('decides a delegated batch in rights mode: allowed with a row, and denied with a delegated row', () =>
  Effect.gen(function* batchesRights() {
    const caller = callerOf('commerce-order');
    const carrier: GateCarrier = {
      accessActor: actorDeclaration({ subject: 'rights' }),
      accessDeclaration: declarationOf(),
    };
    const allowed = harness();
    const decisions = yield* allowed.gate.decideMany([gateOf(carrier, delegatedScopeOf(caller))]);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['ALLOWED']);
    expect(allowed.state.entries.length).toBe(1);
    expect(allowed.state.entries[0]?.delegation?.appId).toBe('commerce-order');

    const denied = harness({ authority: { cells: [] } });
    const refused = yield* denied.gate.decideMany([gateOf(carrier, delegatedScopeOf(caller))]);
    expect(refused.map(({ outcome }) => outcome)).toEqual(['DENIED']);
    expect(denied.state.entries.length).toBe(1);
    expect(denied.state.entries[0]?.delegation).toEqual({ appId: 'commerce-order', principalId: caller.principalId });
  }),
);

it.effect('refuses a batch entry from an unbound caller, with its delegated row', () =>
  Effect.gen(function* batchesUnbound() {
    const { gate, state } = harness({ authority: { cells: [] } });
    const carrier: GateCarrier = { accessActor: actorDeclaration({ subject: 'identity' }) };
    const decisions = yield* gate.decideMany([gateOf(carrier, delegatedScopeOf(callerOf('party-registry')))]);
    expect(codesOf(decisions[0] ?? { reasons: [] })).toEqual(['deny.actor_unbound']);
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.delegation?.appId).toBe('party-registry');
  }),
);

it.effect('refuses a batch workload subject without subjectWorkloads, and leaves no v2 evidence row', () =>
  Effect.gen(function* batchesNonHumanSubject() {
    const { gate, state } = harness({ kinds: kindSource('service') });
    const decisions = yield* gate.decideMany([
      gateOf(
        { accessActor: actorDeclaration({ subject: 'identity' }) },
        delegatedScopeOf(callerOf('commerce-order'), workloadPrincipal),
      ),
    ]);
    expect(codesOf(decisions[0] ?? { reasons: [] })).toEqual(['deny.actor_subject_invalid']);
    // A workload is never a v2 subject, so its refusal is decided exactly as a direct workload's is: without a row.
    expect(state.entries.length).toBe(0);
  }),
);

it.effect('leaves a batch with an agent subject without any row, because no tenant person is named', () =>
  Effect.gen(function* batchesAgentSubject() {
    const { gate, state } = harness({ kinds: kindSource('agent') });
    const decisions = yield* gate.decideMany([
      gateOf({ accessActor: actorDeclaration({ subject: 'identity' }) }, delegatedScopeOf(callerOf('commerce-order'))),
    ]);
    expect(codesOf(decisions[0] ?? { reasons: [] })).toEqual(['deny.actor_subject_invalid']);
    expect(state.entries.length).toBe(0);
  }),
);

it.effect('refuses an agent subject with its delegated row at tenant scope, and a workload subject without one', () =>
  Effect.gen(function* refusesNonHumanSubject() {
    const caller = callerOf('commerce-order');
    const agent = harness({ kinds: kindSource('agent') });
    const refusedAgent = yield* agent.gate.decide(
      gateOf({ accessActor: actorDeclaration(), accessDeclaration: declarationOf() }, delegatedScopeOf(caller)),
    );
    expect(refusedAgent.outcome).toBe('DENIED');
    expect(codesOf(refusedAgent)).toEqual(['deny.actor_subject_invalid']);
    expect(agent.state.entries.length).toBe(1);
    expect(agent.state.entries[0]?.actor.principalId).toBe(person);
    expect(agent.state.entries[0]?.delegation).toEqual({ appId: 'commerce-order', principalId: caller.principalId });

    for (const kind of ['service', 'integration', 'system'] as const) {
      const { gate, state } = harness({ kinds: kindSource(kind) });
      const decision = yield* gate.decide(
        gateOf(
          { accessActor: actorDeclaration(), accessDeclaration: declarationOf() },
          delegatedScopeOf(callerOf('commerce-order'), workloadPrincipal),
        ),
      );
      expect(decision.outcome).toBe('DENIED');
      expect(codesOf(decision)).toEqual(['deny.actor_subject_invalid']);
      expect(state.entries.length).toBe(0);
    }
  }),
);

it.effect('refuses a subject with no principal kind on the delegated path, with its delegated row', () =>
  Effect.gen(function* refusesUnknownKindSubject() {
    const caller = callerOf('commerce-order');
    const { gate, state } = harness({ kinds: { readKind: () => Effect.succeed(Option.none()) } });
    const decision = yield* gate.decide(
      gateOf({ accessActor: actorDeclaration(), accessDeclaration: declarationOf() }, delegatedScopeOf(caller)),
    );
    expect(decision.outcome).toBe('DENIED');
    expect(codesOf(decision)).toEqual(['deny.actor_subject_invalid']);
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.actor.principalId).toBe(person);
    expect(state.entries[0]?.delegation).toEqual({ appId: 'commerce-order', principalId: caller.principalId });
  }),
);

it.effect('admits an identity call on the verified subject and records both identities (D6 step 4 identity)', () =>
  Effect.gen(function* admitsIdentityCall() {
    const caller = callerOf('commerce-order');
    // The subject holds no grant at all: identity mode does not ask the engine for one.
    const { gate, state } = harness({ authority: { cells: [] } });
    const decision = yield* gate.decide(
      gateOf({ accessActor: actorDeclaration({ subject: 'identity' }) }, delegatedScopeOf(caller)),
    );
    expect(decision.outcome).toBe('ALLOWED');
    expect(codesOf(decision)).toEqual(['allow.actor_identity']);
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.actor.principalId).toBe(person);
    expect(state.entries[0]?.delegation).toEqual({ appId: 'commerce-order', principalId: caller.principalId });
  }),
);

it.effect('records an identity admission even without an accessDeclaration, under the identity capability', () =>
  Effect.gen(function* recordsDeclarationlessIdentity() {
    const { gate, state } = harness({ authority: { cells: [] } });
    const decision = yield* gate.decide(
      gateOf({ accessActor: actorDeclaration({ subject: 'identity' }) }, delegatedScopeOf(callerOf('commerce-order'))),
    );
    expect(decision.outcome).toBe('ALLOWED');
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.capability.capabilityKey).toBe('core.access.actor-identity');
  }),
);

it.effect('leaves no evidence row when an identity admission cannot be recorded', () =>
  Effect.gen(function* failsClosedWithoutEvidence() {
    const { gate } = harness({ logFails: true });
    const decision = yield* gate.decide(
      gateOf({ accessActor: actorDeclaration({ subject: 'identity' }) }, delegatedScopeOf(callerOf('commerce-order'))),
    );
    expect(decision.outcome).toBe('UNAVAILABLE');
  }),
);

it.effect('denies a rights call when the subject lacks the capability, and still records it', () =>
  Effect.gen(function* deniesRightsWithoutGrant() {
    const { gate, state } = harness({ authority: { cells: [] } });
    const decision = yield* gate.decide(
      gateOf(
        { accessActor: actorDeclaration({ subject: 'rights' }), accessDeclaration: declarationOf() },
        delegatedScopeOf(callerOf('commerce-order')),
      ),
    );
    expect(decision.outcome).toBe('DENIED');
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.delegation?.appId).toBe('commerce-order');
  }),
);

it.effect('allows a rights call when the subject holds the capability, with the actor recorded beside it', () =>
  Effect.gen(function* allowsRightsWithGrant() {
    const { gate, state } = harness();
    const decision = yield* gate.decide(
      gateOf(
        { accessActor: actorDeclaration({ subject: 'rights' }), accessDeclaration: declarationOf() },
        delegatedScopeOf(callerOf('commerce-order')),
      ),
    );
    expect(decision.outcome).toBe('ALLOWED');
    expect(state.entries.length).toBe(1);
    expect(state.entries[0]?.actor.principalId).toBe(person);
    expect(state.entries[0]?.delegation?.appId).toBe('commerce-order');
  }),
);

it.effect('lists an identity call as the whole scope, because the owner filters by the subject', () =>
  Effect.gen(function* listsIdentityAsScope() {
    const { gate, state } = harness({ authority: { cells: [] } });
    const input: ListGateInput = {
      carrier: { accessActor: actorDeclaration({ subject: 'identity' }) },
      legalEntityScope: 'forbidden',
      now,
      scope: delegatedScopeOf(callerOf('commerce-order')),
    };
    const listing = yield* gate.list(input);
    expect(listing.decision.outcome).toBe('ALLOWED');
    expect(listing.predicate).toEqual({ groups: [] });
    expect(state.entries[0]?.delegation?.appId).toBe('commerce-order');
  }),
);

it.effect('decides each entry of one batch by its own calling module, never sharing an actor', () =>
  Effect.gen(function* batchesByActor() {
    const { gate, state } = harness({ authority: { cells: [] } });
    const carrier: GateCarrier = { accessActor: actorDeclaration({ subject: 'identity' }) };
    const decisions = yield* gate.decideMany([
      gateOf(carrier, delegatedScopeOf(callerOf('commerce-order'))),
      gateOf(carrier, delegatedScopeOf(callerOf('party-registry'))),
    ]);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'DENIED']);
    expect(codesOf(decisions[1] ?? { reasons: [] })).toEqual(['deny.actor_unbound']);
    expect(state.entries.map(({ delegation }) => delegation?.appId)).toEqual(['commerce-order', 'party-registry']);
  }),
);

it.effect('leaves a call without any calling module on its declaration alone (unchanged path)', () =>
  Effect.gen(function* keepsHumanPath() {
    const { gate, state } = harness();
    const context = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: uid(70),
      authContextRef: 'session-plain',
      authMethod: 'session',
      principalId: person,
      tenantId: tenant,
    });
    const scope: OperationalScope = { ...context, correlationId: 'plain-human' };
    const decision = yield* gate.decide(gateOf({ accessDeclaration: declarationOf() }, scope));
    expect(decision.outcome).toBe('ALLOWED');
    expect(state.entries[0]?.delegation).toBeUndefined();
  }),
);

it.effect(
  'answers a batch entry with only an accessActor carrier as the single decide does, before any identity read',
  () =>
    Effect.gen(function* batchMatchesSingleOnCarrierlessEntry() {
      const unreadable: AccessPrincipalKinds = {
        readKind: () => Effect.fail(accessDecisionUnavailable('the identity row is unreadable')),
      };
      const { gate } = harness({ kinds: unreadable });
      const scope: OperationalScope = { ...delegatedScopeOf(callerOf('commerce-order')) };
      const carrier: GateCarrier = { accessActor: actorDeclaration() };
      const single = yield* gate.decide(gateOf(carrier, scope));
      const [batched] = yield* gate.decideMany([gateOf(carrier, scope)]);
      expect(codesOf(single)).toEqual(['deny.declaration_missing']);
      expect(codesOf(batched ?? { reasons: [] })).toEqual(['deny.declaration_missing']);
    }),
);

it.effect('admits a workload subject on an identity carrier that names its key and holds an active binding', () =>
  Effect.gen(function* admitsWorkloadSubject() {
    const caller = callerOf('commerce-order');
    const { authority, gate, state } = harness({
      authority: { cells: [] },
      kinds: kindSource('integration'),
      workloads: workloadRegistry([storefront]),
    });
    const decision = yield* gate.decide(
      gateOf({ accessActor: workloadActorDeclaration() }, delegatedScopeOf(caller, workloadPrincipal)),
    );
    expect(decision.outcome).toBe('ALLOWED');
    expect(codesOf(decision)).toEqual(['allow.actor_identity']);
    // A workload is admitted by its binding exactly as a direct workload call is: no membership is read and no v2
    // evidence row names it, because a workload is never a v2 subject.
    expect(authority.calls.readScope).toBe(0);
    expect(state.entries.length).toBe(0);
  }),
);

it.effect('admits a bound workload subject on a company carrier although it holds no membership there', () =>
  Effect.gen(function* admitsWorkloadSubjectWithoutMembership() {
    const caller = callerOf('commerce-customer-context');
    const { authority, gate } = harness({
      authority: { cells: [] },
      kinds: kindSource('service'),
      members: [person],
      workloads: workloadRegistry([storefront]),
    });
    const carrier: GateCarrier = {
      accessActor: workloadActorDeclaration({ callers: ['commerce-customer-context'] }),
      accessDeclaration: declarationOf(),
    };
    const decision = yield* gate.decide({
      carrier,
      legalEntityScope: 'required',
      now,
      scope: delegatedScopeOf(caller, workloadPrincipal, uid(60)),
    });
    expect(decision.outcome).toBe('ALLOWED');
    expect(codesOf(decision)).toEqual(['allow.actor_identity']);
    expect(authority.calls.readScope).toBe(0);
    const listed = yield* gate.list({
      carrier,
      legalEntityScope: 'required',
      now,
      scope: delegatedScopeOf(caller, workloadPrincipal, uid(60)),
    });
    expect(listed.decision.outcome).toBe('ALLOWED');
    expect(listed.predicate).toEqual({ groups: [] });
  }),
);

it.effect('admits a bound workload subject on a rights carrier by its binding, and decides a person by rights', () =>
  Effect.gen(function* admitsWorkloadSubjectOnRightsCarrier() {
    const caller = callerOf('commerce-order');
    const carrier: GateCarrier = {
      accessActor: workloadActorDeclaration({ subject: 'rights' }),
      accessDeclaration: declarationOf(),
    };
    const workload = harness({
      authority: { cells: [] },
      kinds: kindSource('integration'),
      workloads: workloadRegistry([storefront]),
    });
    const admitted = yield* workload.gate.decide(gateOf(carrier, delegatedScopeOf(caller, workloadPrincipal)));
    expect(admitted.outcome).toBe('ALLOWED');
    expect(codesOf(admitted)).toEqual(['allow.actor_identity']);
    expect(workload.check.calls.checkBulk).toBe(0);
    // The same carrier still decides a person on its declaration: a person with no grant is denied.
    const personal = harness({ authority: { cells: [] }, workloads: workloadRegistry([storefront]) });
    const denied = yield* personal.gate.decide(gateOf(carrier, delegatedScopeOf(caller)));
    expect(denied.outcome).toBe('DENIED');
    expect(codesOf(denied)).toContain('deny.insufficient_grant');
  }),
);

it.effect('keeps a person subject on the membership rule: a delegated call for a non-member is refused', () =>
  Effect.gen(function* refusesNonMemberPersonSubject() {
    const caller = callerOf('commerce-order');
    const { gate } = harness({
      authority: { cells: [] },
      members: [uid(41)],
      workloads: workloadRegistry([storefront], person),
    });
    for (const carrier of [
      { accessActor: workloadActorDeclaration() },
      { accessActor: actorDeclaration({ subject: 'identity' }) },
      { accessActor: actorDeclaration(), accessDeclaration: declarationOf() },
    ] satisfies readonly GateCarrier[]) {
      const decision = yield* gate.decide(gateOf(carrier, delegatedScopeOf(caller)));
      expect(decision.outcome).toBe('DENIED');
      expect(codesOf(decision)).toEqual(['deny.scope_mismatch']);
    }
  }),
);

it.effect('refuses a workload subject whose carrier names no workload keys, and leaves no v2 evidence row', () =>
  Effect.gen(function* refusesWorkloadWithoutSubjectWorkloads() {
    const { gate, state } = harness({ kinds: kindSource('integration'), workloads: workloadRegistry([storefront]) });
    const decision = yield* gate.decide(
      gateOf(
        { accessActor: actorDeclaration({ subject: 'identity' }) },
        delegatedScopeOf(callerOf('commerce-order'), workloadPrincipal),
      ),
    );
    expect(decision.outcome).toBe('DENIED');
    expect(codesOf(decision)).toEqual(['deny.actor_subject_invalid']);
    expect(state.entries.length).toBe(0);
  }),
);

it.effect(
  'refuses a workload subject with no active binding for its named keys, or a binding of another principal',
  () =>
    Effect.gen(function* refusesUnboundWorkload() {
      const registries = [
        workloadRegistry([]),
        workloadRegistry(['commerce.other-client']),
        workloadRegistry([storefront], uid(81)),
      ];
      for (const workloads of registries) {
        const { gate, state } = harness({ kinds: kindSource('integration'), workloads });
        const decision = yield* gate.decide(
          gateOf(
            { accessActor: workloadActorDeclaration() },
            delegatedScopeOf(callerOf('commerce-order'), workloadPrincipal),
          ),
        );
        expect(decision.outcome).toBe('DENIED');
        expect(codesOf(decision)).toEqual(['deny.actor_subject_invalid']);
        expect(state.entries.length).toBe(0);
      }
    }),
);

it.effect('answers UNAVAILABLE, never allow, when the workload registry cannot be read', () =>
  Effect.gen(function* unavailableWorkloadRegistry() {
    const { gate, state } = harness({
      authority: { cells: [] },
      kinds: kindSource('integration'),
      workloads: unreadableRegistry,
    });
    const decision = yield* gate.decide(
      gateOf(
        { accessActor: workloadActorDeclaration() },
        delegatedScopeOf(callerOf('commerce-order'), workloadPrincipal),
      ),
    );
    expect(decision.outcome).toBe('UNAVAILABLE');
    expect(codesOf(decision)).toEqual(['unavailable.intent']);
    expect(state.entries.length).toBe(0);
  }),
);

/** A structural administration declaration: people only, decided by their configure basis (O81). */
const adminDeclarationOf = (): AccessDeclaration =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'finance.invoice.administer',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'finance', level: 'manage' },
      risk: 'critical',
      selectors: [],
    } satisfies AccessDeclarationInput,
    ACTION_OWNER,
  );

it.effect('refuses a bound workload subject on an admin declaration even when the carrier names its key (O81)', () =>
  Effect.gen(function* refusesWorkloadSubjectOnAdmin() {
    const caller = callerOf('commerce-order');
    const carrier: GateCarrier = { accessActor: workloadActorDeclaration(), accessDeclaration: adminDeclarationOf() };
    const scope = delegatedScopeOf(caller, workloadPrincipal);
    const { authority, gate, state } = harness({
      authority: { cells: [] },
      kinds: kindSource('integration'),
      workloads: workloadRegistry([storefront]),
    });
    const decision = yield* gate.decide(gateOf(carrier, scope));
    expect(decision.outcome).toBe('DENIED');
    // Refused exactly as the direct path refuses a machine on an admin declaration, with no membership read.
    expect(codesOf(decision)).toEqual(['deny.agent_forbidden']);
    expect(authority.calls.readScope).toBe(0);
    expect(state.entries).toEqual([]);
    // The batch decides the entry the same way, beside an admitted one of the same subject.
    const batch = yield* gate.decideMany([
      gateOf(carrier, scope),
      gateOf({ accessActor: workloadActorDeclaration() }, scope),
    ]);
    expect(batch.map(codesOf)).toEqual([['deny.agent_forbidden'], ['allow.actor_identity']]);
    // A person the call is done for keeps the identity admission the carrier declares.
    const personal = harness({ authority: { cells: [] }, workloads: workloadRegistry([storefront]) });
    const forPerson = yield* personal.gate.decide(gateOf(carrier, delegatedScopeOf(caller)));
    expect(codesOf(forPerson)).toEqual(['allow.actor_identity']);
  }),
);

it.effect('decides a workload subject batch exactly as the single call does, entry by entry', () =>
  Effect.gen(function* batchesWorkloadSubject() {
    const caller = callerOf('commerce-order');
    const scope = delegatedScopeOf(caller, workloadPrincipal);
    const admitted = gateOf({ accessActor: workloadActorDeclaration() }, scope);
    const unnamed = gateOf({ accessActor: actorDeclaration({ subject: 'identity' }) }, scope);
    const otherKey = gateOf(
      { accessActor: workloadActorDeclaration({ subjectWorkloads: ['commerce.other-client'] }) },
      scope,
    );
    const inputs = [admitted, unnamed, otherKey];
    const { gate, state } = harness({ kinds: kindSource('integration'), workloads: workloadRegistry([storefront]) });
    const batch = yield* gate.decideMany(inputs);
    const single = yield* Effect.all(
      inputs.map((input) =>
        harness({ kinds: kindSource('integration'), workloads: workloadRegistry([storefront]) }).gate.decide(input),
      ),
    );
    expect(batch.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'DENIED', 'DENIED']);
    expect(batch.map(codesOf)).toEqual(single.map(codesOf));
    expect(batch.map(({ outcome }) => outcome)).toEqual(single.map(({ outcome }) => outcome));
    expect(state.entries).toEqual([]);
  }),
);

it.effect('answers a batch UNAVAILABLE for the named entries only when the workload registry is unreadable', () =>
  Effect.gen(function* batchesUnreadableRegistry() {
    const scope = delegatedScopeOf(callerOf('commerce-order'), workloadPrincipal);
    const named = gateOf({ accessActor: workloadActorDeclaration() }, scope);
    const unnamed = gateOf({ accessActor: actorDeclaration({ subject: 'identity' }) }, scope);
    const { gate, state } = harness({
      authority: { cells: [] },
      kinds: kindSource('integration'),
      workloads: unreadableRegistry,
    });
    const decisions = yield* gate.decideMany([named, unnamed]);
    expect(decisions.map(({ outcome }) => outcome)).toEqual(['UNAVAILABLE', 'DENIED']);
    expect(codesOf(decisions[0] ?? { reasons: [] })).toEqual(['unavailable.intent']);
    expect(codesOf(decisions[1] ?? { reasons: [] })).toEqual(['deny.actor_subject_invalid']);
    expect(state.entries.length).toBe(0);
  }),
);

/** A workload on its own request: an API-key context with no calling module beside it. */
const directWorkloadScope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: uid(70),
    authContextRef: 'better-auth-api-key:storefront',
    authMethod: 'api_key',
    principalId: workloadPrincipal,
    tenantId: tenant,
  }),
  correlationId: 'direct-workload',
};

const workloadOnlyCarrier = {
  accessActor: workloadActorDeclaration({ subject: 'workload' }),
} satisfies GateCarrier;

it.effect('admits an exclusive module workload by its active binding, with no human grant or identity admission', () =>
  Effect.gen(function* exclusiveWorkload() {
    for (const kind of ['integration', 'service', 'system'] as const) {
      const h = harness({
        authority: { cells: [] },
        kinds: kindSource(kind),
        workloads: workloadRegistry([storefront]),
      });
      const scope = trustVerifiedGatewayPrincipalContext(
        directWorkloadScope,
        REVISION,
        undefined,
        callerOf('commerce-order'),
      );
      const question = gateOf(workloadOnlyCarrier, scope);
      expect(codesOf(yield* h.gate.decide(question))).toEqual(['allow.workload']);
      expect((yield* h.gate.list(question)).predicate).toEqual({ groups: [] });
      expect((yield* h.gate.decideMany([question]))[0]?.outcome).toBe('ALLOWED');
      expect(h.check.calls.checkBulk).toBe(0);
      expect(h.state.entries).toEqual([]);
    }
  }),
);

it.effect('never grants a workload-only module purpose to a human owner, an agent or a direct workload', () =>
  Effect.gen(function* exclusiveNegatives() {
    // The person holds the ordinary full capability and even the matching binding. Neither changes kind.
    for (const kind of ['human', 'agent'] as const) {
      const h = harness({ kinds: kindSource(kind), workloads: workloadRegistry([storefront], person) });
      const question = gateOf(workloadOnlyCarrier, delegatedScopeOf(callerOf('commerce-order')));
      expect((yield* h.gate.decide(question)).outcome).toBe('DENIED');
      expect((yield* h.gate.list(question)).predicate).toBeUndefined();
      expect((yield* h.gate.decideMany([question]))[0]?.outcome).toBe('DENIED');
      expect(h.check.calls.checkBulk).toBe(0);
    }
    const direct = harness({ kinds: kindSource('integration'), workloads: workloadRegistry([storefront]) });
    const question = gateOf(workloadOnlyCarrier, directWorkloadScope);
    expect((yield* direct.gate.decide(question)).outcome).toBe('DENIED');
    expect((yield* direct.gate.decideMany([question]))[0]?.outcome).toBe('DENIED');
    expect((yield* direct.gate.list(question)).predicate).toBeUndefined();
    const unverifiedAct = { ...directWorkloadScope, act: callerOf('commerce-order') };
    expect((yield* direct.gate.decide(gateOf(workloadOnlyCarrier, unverifiedAct))).outcome).toBe('DENIED');
  }),
);

it.effect(
  'refuses unbound, wrong-caller and approval use of the exclusive module workload in single and batch calls',
  () =>
    Effect.gen(function* exclusiveBoundaries() {
      for (const control of [
        'unbound',
        'wrong-key',
        'wrong-principal',
        'wrong-tenant',
        'wrong-caller',
        'approve',
        'unavailable',
      ] as const) {
        let keys = [storefront];
        if (control === 'unbound') {
          keys = [];
        }
        if (control === 'wrong-key') {
          keys = ['commerce.other-client'];
        }
        const registry = workloadRegistry(keys, control === 'wrong-principal' ? uid(81) : workloadPrincipal);
        const h = harness({
          kinds: kindSource('integration'),
          workloads: control === 'unavailable' ? unreadableRegistry : registry,
        });
        const scope = trustVerifiedGatewayPrincipalContext(
          control === 'wrong-tenant' ? { ...directWorkloadScope, tenantId: uid(99) } : directWorkloadScope,
          REVISION,
          undefined,
          callerOf(control === 'wrong-caller' ? 'another-module' : 'commerce-order'),
        );
        const base = gateOf(workloadOnlyCarrier, scope);
        const question: GateInput = control === 'approve' ? { ...base, mode: 'approve' } : base;
        const single = yield* h.gate.decide(question);
        const batch = yield* h.gate.decideMany([question]);
        expect(single.outcome).toBe(control === 'unavailable' ? 'UNAVAILABLE' : 'DENIED');
        expect(batch[0]?.outcome).toBe(single.outcome);
        expect(codesOf(batch[0] ?? single)).toEqual(codesOf(single));
        expect(h.check.calls.checkBulk).toBe(0);
      }
    }),
);

it.effect('runs the real workload-only Action lifecycle but rejects propose before owner execution', () =>
  Effect.gen(function* exclusiveActionLifecycle() {
    let handlers = 0;
    const action = defineAction(
      {
        accessActor: workloadOnlyCarrier.accessActor,
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'finance.invoice.import.access' },
        actionKey: 'finance.invoice.import',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'protected' },
          entrypointKey: 'finance.invoice.import',
          moduleKey: 'finance.invoice',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'forbidden',
        owningModuleKey: 'finance.invoice',
        payloadSchema: Schema.Struct({}),
        policies: [],
        resultSchema: Schema.Struct({}),
        schemaVersion: '1',
      },
      (_payload, context) =>
        Effect.sync(() => {
          handlers += 1;
          expect(context.scope.principalId).toBe(workloadPrincipal);
          expect(context.scope.authMethod).toBe('api_key');
          return {};
        }),
    );
    const h = harness({
      authority: { cells: [] },
      kinds: kindSource('integration'),
      workloads: workloadRegistry([storefront]),
    });
    const owner = makeTestOperationOwner({ actions: [action], moduleId: 'finance.invoice' }).ownerRegistration;
    const composition = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: owner });
    const runtime = yield* makeActionTestHarness({
      ...composition,
      accessDecision: h.gate,
    });
    const principal = trustVerifiedGatewayPrincipalContext(
      directWorkloadScope,
      composition.snapshot.composition.revision,
      undefined,
      callerOf('commerce-order'),
    );
    const request = {
      payload: {},
      principal,
      registration: action,
      transport: { correlationId: 'workload-action', idempotencyKey: 'workload-run' },
    };
    expect(yield* runtime.runtime.runAction(request)).toEqual({});
    const refused = yield* runtime.runtime
      .runAction({
        ...request,
        successContract: 'result-or-proposal',
        transport: { ...request.transport, idempotencyKey: 'workload-propose', intent: 'propose' },
      })
      .pipe(Effect.flip);
    expect(refused).toMatchObject({
      _tag: 'ActionPermissionDenied',
      reason: 'This Action does not need an approval; execute it directly',
    });
    expect(refused.reason).toBe('This Action does not need an approval; execute it directly');
    expect(handlers).toBe(1);
    expect(runtime.snapshot().committed).toHaveLength(1);
    expect(runtime.snapshot().invocations.map(({ status }) => status)).toEqual(['succeeded', 'rejected']);
    const stalePrincipal = trustVerifiedGatewayPrincipalContext(
      directWorkloadScope,
      REVISION,
      undefined,
      callerOf('commerce-order'),
    );
    const stale = yield* runtime.runtime
      .runAction({
        ...request,
        principal: stalePrincipal,
        transport: { ...request.transport, idempotencyKey: 'stale-workload-run' },
      })
      .pipe(Effect.flip);
    expect(stale._tag).toBe('ActionTransactionError');
    expect(handlers).toBe(1);
    expect(runtime.snapshot().committed).toHaveLength(1);
  }),
);

/** The company list of the tenant: two companies, before any selection narrows them. */
const twoCompanies: AccessLegalEntityCandidates = {
  listCandidateIds: () => Effect.succeed([uid(60), uid(61)].map((id) => LegalEntityIdSchema.make(id))),
};

it.effect('lets a bound workload subject of a module call select every company of its tenant', () =>
  Effect.gen(function* selectsCompaniesForWorkloadSubject() {
    const { check, gate } = harness({
      kinds: kindSource('service'),
      legalEntities: twoCompanies,
      workloads: workloadRegistry([storefront]),
    });
    const selectable = yield* gate.selectableLegalEntities({
      now,
      scope: delegatedScopeOf(callerOf('commerce-customer-context'), workloadPrincipal),
    });
    expect(selectable).toEqual([uid(60), uid(61)]);
    // The tenant-wide binding is the workload's company authority: the engine holds no tuple for it.
    expect(check.calls.checkBulk).toBe(0);
  }),
);

it.effect('selects no company for an unbound workload subject, nor for a workload on its own request', () =>
  Effect.gen(function* selectsNoCompanyForUnboundOrDirectWorkload() {
    const unbound = harness({
      kinds: kindSource('service'),
      legalEntities: twoCompanies,
      workloads: workloadRegistry([]),
    });
    expect(
      yield* unbound.gate.selectableLegalEntities({
        now,
        scope: delegatedScopeOf(callerOf('commerce-customer-context'), workloadPrincipal),
      }),
    ).toEqual([]);
    const direct = harness({
      kinds: kindSource('service'),
      legalEntities: twoCompanies,
      workloads: workloadRegistry([storefront]),
    });
    expect(yield* direct.gate.selectableLegalEntities({ now, scope: directWorkloadScope })).toEqual([]);
  }),
);

it.effect('answers UNAVAILABLE for a workload subject company selection when the registry cannot be read', () =>
  Effect.gen(function* unreadableWorkloadSelection() {
    const { gate } = harness({
      kinds: kindSource('service'),
      legalEntities: twoCompanies,
      workloads: unreadableRegistry,
    });
    const selection = yield* Effect.result(
      gate.selectableLegalEntities({
        now,
        scope: delegatedScopeOf(callerOf('commerce-customer-context'), workloadPrincipal),
      }),
    );
    expect(Result.isFailure(selection)).toBe(true);
  }),
);

it.effect('keeps a person subject on the engine: a module call selects only the companies the person may select', () =>
  Effect.gen(function* selectsCompaniesForPersonSubject() {
    const { check, gate } = harness({ legalEntities: twoCompanies, workloads: workloadRegistry([storefront], person) });
    const selectable = yield* gate.selectableLegalEntities({
      now,
      scope: delegatedScopeOf(callerOf('commerce-customer-context')),
    });
    expect(check.calls.checkBulk).toBe(1);
    expect(selectable.every((legalEntityId) => [uid(60), uid(61)].includes(legalEntityId))).toBe(true);
    expect(check.subjects.every((subject) => subject === 'principal')).toBe(true);
  }),
);
