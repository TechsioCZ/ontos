import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ActorContextInput } from '../../src/access/decision/authority.ts';
import type {
  AccessCheckItem,
  AccessCheckPermissionship,
  DecisionCheckPort,
} from '../../src/access/decision/engine.ts';
import {
  decideAccess,
  decideAccessMany,
  resolveListAccess,
  resolveListAccessMany,
} from '../../src/access/decision/engine.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import { AccessScopeIdSchema } from '../../src/access/ids.ts';
import { scopeObjectId } from '../../src/access/compiler/object-id.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import { shouldRecordDecision } from '../../src/access/enforcement/decision-log.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  agent,
  at,
  capability as capabilityKeyOf,
  cell,
  connectionId,
  makeAuthority,
  otherPerson,
  person,
  principalHolder,
  scopeId,
  tenant,
} from './access-decision-support.ts';

/*
 * Baseline access (the Shell frame): a person whose Roles do not grant a baseline capability is admitted as a member
 * of the scope they ask in, which the engine proves with one `access_scope#access` check. Only a person refused for
 * want of a grant, only a baseline capability, never an agent; an engine failure is UNAVAILABLE, and a non-member keeps
 * the Roles' refusal.
 */

const now = at('2026-11-13T12:00:00Z');
const FRAME_OWNER = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'core.shell.composition',
  moduleKey: 'core.shell',
  role: 'api',
});
const frame = (overrides: Partial<AccessDeclarationInput> = {}) =>
  capabilityPolicyOf(
    decodeAccessDeclarationOrThrow(
      {
        baseline: true,
        key: 'core.shell.composition.read',
        kind: 'read',
        modes: ['run'],
        placement: { group: 'shell', level: 'basic' },
        risk: 'routine',
        selectors: [],
        ...overrides,
      },
      FRAME_OWNER,
    ),
  );
const { baseline: _baseline, ...notBaseline } = frame();
const personActor: ActorContextInput = { actor: { _tag: 'Principal', principalId: person }, tenantId: tenant };

/** The engine with no cell for the person; the membership check answers `member`, or fails as a whole. */
const engineOf = (member: AccessCheckPermissionship | 'failure') => {
  const sent: AccessCheckItem[] = [];
  const port: DecisionCheckPort = {
    checkBulk: (items) => {
      sent.push(...items);
      return member === 'failure'
        ? Effect.fail(accessDecisionUnavailable('test engine failure'))
        : Effect.succeed(
            items.map((item) => ({ permissionship: item.resource.type === 'access_scope' ? member : 'none' })),
          );
    },
  };
  return { port, sent };
};

const decideFor = (
  member: AccessCheckPermissionship | 'failure',
  capability = frame(),
  actor: ActorContextInput = personActor,
) => {
  const engine = engineOf(member);
  return decideAccess(makeAuthority({ cells: [] }).port, engine.port, {
    actor,
    now,
    request: { capability, mode: 'run' },
  }).pipe(Effect.map((decision) => ({ decision, sent: engine.sent })));
};

it.effect('admits a member to a baseline capability no Role grants, proven by one scope membership check', () =>
  Effect.gen(function* admitsMember() {
    const { decision, sent } = yield* decideFor('has');
    expect({ codes: decision.reasons.map(({ code }) => code), outcome: decision.outcome }).toEqual({
      codes: ['structural.member_baseline'],
      outcome: 'ALLOWED',
    });
    expect(decision.structuralEvidence?.basis).toBe('member_baseline');
    expect(sent.map(({ permission, resource }) => `${resource.type}#${permission}`)).toEqual(['access_scope#access']);
  }),
);

it.effect('keeps the Roles refusal for a non-member, and is UNAVAILABLE when the engine cannot prove it', () =>
  Effect.gen(function* nonMemberAndFailure() {
    const outsider = yield* decideFor('none');
    expect(outsider.decision.outcome).toBe('DENIED');
    expect(outsider.decision.reasons.map(({ code }) => code)).toEqual(['deny.insufficient_grant']);
    expect((yield* decideFor('error')).decision.outcome).toBe('UNAVAILABLE');
    expect((yield* decideFor('failure')).decision.outcome).toBe('UNAVAILABLE');
  }),
);

it.effect('never applies to a capability that is not baseline, nor to an agent', () =>
  Effect.gen(function* onlyBaselineAndPeople() {
    const plain = yield* decideFor('has', notBaseline);
    expect(plain.decision.outcome).toBe('DENIED');
    expect(plain.sent).toEqual([]);
    const asAgent = yield* decideFor('has', frame(), {
      actor: { _tag: 'Agent' as const, agentId: agent, connectionId, consentRevision: 1, principalId: person },
      tenantId: tenant,
    });
    expect(asAgent.decision.outcome).not.toBe('ALLOWED');
  }),
);

it.effect('answers a batch and a LIST exactly as one decision, the LIST over the whole scope', () =>
  Effect.gen(function* batchAndList() {
    const batch = engineOf('has');
    const [answers] = yield* decideAccessMany(batch.port, [
      {
        authority: makeAuthority({ cells: [] }).port,
        inputs: [
          { actor: personActor, now, request: { capability: frame(), mode: 'run' } },
          { actor: personActor, now, request: { capability: notBaseline, mode: 'run' } },
        ],
      },
    ]);
    expect(answers?.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'DENIED']);
    const list = engineOf('has');
    const listed = yield* resolveListAccess(makeAuthority({ cells: [] }).port, list.port, {
      actor: personActor,
      capability: frame(),
      mode: 'run',
      now,
    });
    expect({ outcome: listed.decision.outcome, predicate: listed.predicate }).toEqual({
      outcome: 'ALLOWED',
      predicate: { groups: [] },
    });
  }),
);

it.effect('refuses the flag at decision time on anything but the Shell frame read, whatever a release row says', () =>
  Effect.gen(function* decisionTimeGuard() {
    // Policies a decoded declaration can never produce, as a tampered release row could carry them.
    for (const forged of [
      { ...frame(), capabilityKey: capabilityKeyOf('billing.invoices.invoice.read') },
      { ...frame(), kind: 'action' as const },
      { ...frame(), risk: 'sensitive' as const },
      { ...frame(), selectors: ['assigned' as const] },
    ]) {
      const { decision, sent } = yield* decideFor('has', forged);
      expect({ outcome: decision.outcome, sent: sent.length }).toEqual({ outcome: 'DENIED', sent: 0 });
    }
  }),
);

it.effect('records every fallback admission as evidence, though the read is routine', () =>
  Effect.gen(function* recordedAdmission() {
    const { decision } = yield* decideFor('has');
    expect(shouldRecordDecision(decision, frame())).toBe(true);
  }),
);

/** An engine where only `person` is a member, and only of `memberScope`; it records what it was asked. */
const membershipEngine = (memberScope: string) => {
  const sent: AccessCheckItem[] = [];
  const port: DecisionCheckPort = {
    checkBulk: (items) => {
      sent.push(...items);
      return Effect.succeed(
        items.map((item) => ({
          permissionship:
            item.resource.type === 'access_scope' &&
            item.resource.id === scopeObjectId(tenant, memberScope) &&
            JSON.stringify(item.subject).includes(person)
              ? ('has' as const)
              : ('none' as const),
        })),
      );
    },
  };
  return { port, sent };
};

/** One decision input of a batch: this actor asks this capability to run. */
const ask = (actor: ActorContextInput, capability = frame()) => ({
  actor,
  now,
  request: { capability, mode: 'run' as const },
});

/** One LIST input: this person lists this capability. */
const list = (principalId: typeof person, capability = frame()) => ({
  actor: { actor: { _tag: 'Principal' as const, principalId }, tenantId: tenant },
  capability,
  mode: 'run' as const,
  now,
});

it.effect('keeps every answer on its own request when one batch mixes members, non-members and two companies', () =>
  Effect.gen(function* alignedBatch() {
    const companyB = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000015');
    const engine = membershipEngine(scopeId);
    const outsiderActor: ActorContextInput = {
      actor: { _tag: 'Principal', principalId: otherPerson },
      tenantId: tenant,
    };
    const answers = yield* decideAccessMany(engine.port, [
      {
        authority: makeAuthority({ cells: [] }).port,
        inputs: [ask(outsiderActor), ask(personActor), ask(personActor, notBaseline), ask(personActor)],
      },
      { authority: makeAuthority({ cells: [], resolvedScopeId: companyB }).port, inputs: [ask(personActor)] },
    ]);
    expect(answers.map((group) => group.map(({ outcome }) => outcome))).toEqual([
      ['DENIED', 'ALLOWED', 'DENIED', 'ALLOWED'],
      ['DENIED'],
    ]);
    // One membership item per fallback (the non-baseline request asks none), the company-B one in company B.
    expect(
      engine.sent.filter(({ resource }) => resource.type === 'access_scope').map(({ resource }) => resource.id),
    ).toEqual([
      scopeObjectId(tenant, scopeId),
      scopeObjectId(tenant, scopeId),
      scopeObjectId(tenant, scopeId),
      scopeObjectId(tenant, companyB),
    ]);
  }),
);

it.effect('answers several LISTs in one call, each on its own person', () =>
  Effect.gen(function* alignedLists() {
    const engine = membershipEngine(scopeId);
    const resolutions = yield* resolveListAccessMany(makeAuthority({ cells: [] }).port, engine.port, [
      list(otherPerson),
      list(person),
      list(person, notBaseline),
      list(person),
    ]);
    expect(
      resolutions.map(({ decision, predicate }) => ({ outcome: decision.outcome, predicate: predicate ?? 'none' })),
    ).toEqual([
      { outcome: 'DENIED', predicate: 'none' },
      { outcome: 'ALLOWED', predicate: { groups: [] } },
      { outcome: 'DENIED', predicate: 'none' },
      { outcome: 'ALLOWED', predicate: { groups: [] } },
    ]);
  }),
);

it.effect('falls back only on a pure refusal for want of a grant: any other reason keeps its answer', () =>
  Effect.gen(function* onlyPureInsufficientGrant() {
    // A mode the frame does not declare is refused before any grant is read.
    const wrongMode = engineOf('has');
    const proposed = yield* decideAccess(makeAuthority({ cells: [] }).port, wrongMode.port, {
      actor: personActor,
      now,
      request: { capability: frame(), mode: 'propose' },
    });
    expect({ outcome: proposed.outcome, sent: wrongMode.sent.length }).toEqual({ outcome: 'DENIED', sent: 0 });
    expect(proposed.reasons.map(({ code }) => code)).not.toContain('structural.member_baseline');
    // A person who is no member of the scope is refused while the scope resolves, never by the fallback.
    const outsider = engineOf('has');
    const unresolved = yield* decideAccess(
      makeAuthority({ cells: [], nonMembers: [principalHolder()] }).port,
      outsider.port,
      { actor: personActor, now, request: { capability: frame(), mode: 'run' } },
    );
    expect({ outcome: unresolved.outcome, sent: outsider.sent.length }).toEqual({ outcome: 'DENIED', sent: 0 });
    // A holder of the frame cell whose grant cannot be decided (a caveat without context) stays refused for that
    // reason; the membership is never asked.
    const held = makeAuthority({ cells: [cell({ capability: 'core.shell.composition.read' })] });
    const asked: AccessCheckItem[] = [];
    const conditional: DecisionCheckPort = {
      checkBulk: (items) => {
        asked.push(...items);
        return Effect.succeed(
          items.map((item) => ({
            permissionship: item.resource.type === 'access_scope' ? ('has' as const) : ('conditional' as const),
          })),
        );
      },
    };
    const indeterminate = yield* decideAccess(held.port, conditional, {
      actor: personActor,
      now,
      request: { capability: frame(), mode: 'run' },
    });
    expect(indeterminate.outcome).toBe('DENIED');
    expect(indeterminate.reasons.map(({ code }) => code)).toEqual(['deny.caveat_indeterminate']);
    expect(asked.filter(({ resource }) => resource.type === 'access_scope')).toEqual([]);
  }),
);
