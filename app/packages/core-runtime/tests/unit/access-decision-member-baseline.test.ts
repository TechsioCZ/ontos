import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ActorContextInput } from '../../src/access/decision/authority.ts';
import type {
  AccessCheckItem,
  AccessCheckPermissionship,
  DecisionCheckPort,
} from '../../src/access/decision/engine.ts';
import { decideAccess, decideAccessMany, resolveListAccess } from '../../src/access/decision/engine.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import { shouldRecordDecision } from '../../src/access/enforcement/decision-log.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  agent,
  at,
  capability as capabilityKeyOf,
  connectionId,
  makeAuthority,
  person,
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
