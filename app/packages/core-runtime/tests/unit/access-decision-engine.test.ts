import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  ActorContextInput,
  HolderMembershipDeadlines,
  ResolvedAccessScope,
  ScopeQuery,
} from '../../src/access/decision/authority.ts';
import { assignmentObjectId, grantObjectId } from '../../src/access/compiler/object-id.ts';
import { AccessScopeIdSchema, AgentIdSchema, ModuleKeySchema } from '../../src/access/ids.ts';
import type { PrincipalId } from '../../src/access/ids.ts';
import { decisionHttpStatus } from '../../src/access/decision/contract.ts';
import type { DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import { decideAccess } from '../../src/access/decision/engine.ts';
import type { DecisionInput } from '../../src/access/decision/engine.ts';
import { explainAccess } from '../../src/access/decision/explain.ts';
import {
  agent,
  agentHolder,
  amount,
  at,
  capability,
  cell,
  connect,
  connectionId,
  makeAuthority,
  makeCheck,
  otherPerson,
  person,
  principalHolder,
  record,
  scopeId,
  recordTarget,
  tenant,
} from './access-decision-support.ts';
import type { AuthoritySpec, CellSpec, CheckSpec } from './access-decision-support.ts';

const now = at('2026-11-03T12:00:00Z');
const capabilityKey = 'finance.invoice.void';
const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const policy = (overrides: Partial<DecisionCapabilityPolicy> = {}): DecisionCapabilityPolicy => ({
  capabilityKey: capability(capabilityKey),
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  risk: 'routine',
  selectors: [],
  ...overrides,
});

const human: ActorContextInput = { actor: { _tag: 'Principal', principalId: person }, tenantId: tenant };
const agentActor = (consentRevision = 1): ActorContextInput => ({
  actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision, principalId: person },
  tenantId: tenant,
});

const run = (input: {
  readonly actor?: ActorContextInput;
  readonly authority: AuthoritySpec;
  readonly check?: Omit<CheckSpec, 'authority'>;
  readonly request: DecisionInput['request'];
}) => {
  const authority = makeAuthority(input.authority);
  const check = makeCheck({ authority: input.authority, ...input.check });
  return Effect.map(
    decideAccess(authority.port, check.port, {
      actor: input.actor ?? human,
      now,
      request: input.request,
    }),
    (decision) => ({ authority, check, decision }),
  );
};

const cellOf = (spec: CellSpec = {}) => cell({ capability: capabilityKey, ...spec });

/** The membership end date of one member of the scope, as the port reports it (D6, M2). */
const membershipEnd = (principalId: PrincipalId, until: Date): HolderMembershipDeadlines => ({
  deadlines: [{ source: 'membership', until }],
  holder: principalHolder(principalId),
});

/** A read scope that carries exactly these per-holder end dates. */
const scopeWithHolderDeadlines = (
  scope: ResolvedAccessScope,
  holderDeadlines: readonly HolderMembershipDeadlines[],
): ResolvedAccessScope => ({
  ...scope,
  deadlines: holderDeadlines.flatMap(({ deadlines }) => deadlines),
  holderDeadlines,
});

/** The same port, answering the scope read with the given holders' end dates. */
const authorityWithHolderDeadlines = (
  authority: ReturnType<typeof makeAuthority>,
  holderDeadlines: readonly HolderMembershipDeadlines[],
) => ({
  ...authority.port,
  readScope: (query: ScopeQuery) =>
    Effect.gen(function* scopeReadWithHolderDeadlines() {
      const read = yield* authority.port.readScope(query);
      return Option.isNone(read) ? read : Option.some(scopeWithHolderDeadlines(read.value, holderDeadlines));
    }),
});

it.effect('allows a routine action through one bulk snapshot and names the exact witness', () =>
  Effect.gen(function* allowsRoutineActionThroughOneBulkSnapshot() {
    const grantedCell = cellOf({ deadline: at('2026-12-01T00:00:00Z') });
    const { check, decision } = yield* run({
      authority: {
        cells: [grantedCell],
        membershipDeadlines: [{ source: 'membership', until: at('2027-01-01T00:00:00Z') }],
      },
      request: { capability: policy(), mode: 'run' },
    });
    expect(decision.outcome).toBe('ALLOWED');
    expect(check.calls.checkBulk).toBe(1);
    expect(decision.evidence.length).toBe(1);
    expect(decision.evidence[0]?.witness.purpose).toBe('requester');
    expect(decision.evidence[0]?.witness.assignmentIncarnationId).toBe(grantedCell.assignmentIncarnationId);
    expect(decision.admissionDeadline).toEqual(at('2026-12-01T00:00:00Z'));
    expect(decisionHttpStatus(decision.outcome)).toBe(200);
    expect(decision.reasons.map(({ code }) => code)).toContain('allow.granted');
  }),
);

it.effect('requires a record match for assigned scope and never matches a NULL owner', () =>
  Effect.gen(function* requiresRecordMatchForAssignedScope() {
    const assignedPolicy = policy({ selectors: ['assigned'] });
    const authority: AuthoritySpec = {
      cells: [cellOf({ selector: { _tag: 'assigned' } })],
    };
    const mine = yield* run({
      authority,
      check: { records: [{ assigned: principalHolder(), recordKey: 'record-1' }] },
      request: { capability: assignedPolicy, mode: 'run', target: recordTarget(1) },
    });
    expect(mine.decision.outcome).toBe('ALLOWED');
    expect(mine.decision.selectors).toEqual([{ selector: 'assigned', side: 'principal' }]);

    const theirs = yield* run({
      authority,
      check: { records: [{ assigned: principalHolder(otherPerson), recordKey: 'record-2' }] },
      request: { capability: assignedPolicy, mode: 'run', target: recordTarget(2) },
    });
    expect(theirs.decision.outcome).toBe('DENIED');

    const unassigned = yield* run({
      authority,
      check: { records: [{ recordKey: 'record-3' }] },
      request: { capability: assignedPolicy, mode: 'run', target: recordTarget(3) },
    });
    expect(unassigned.decision.outcome).toBe('DENIED');
    expect(decisionHttpStatus(unassigned.decision.outcome)).toBe(403);

    const missingTarget = yield* run({
      authority,
      request: { capability: assignedPolicy, mode: 'run' },
    });
    expect(missingTarget.decision.reasons.map(({ code }) => code)).toContain('deny.target_required');
  }),
);

it.effect('applies one grant amount ceiling and never combines limits across grants', () =>
  Effect.gen(function* appliesSingleGrantAmountCeiling() {
    const authority: AuthoritySpec = {
      cells: [
        cellOf({ amountCeiling: { currency: 'CZK', limitMinor: 10_000_000 } }),
        cellOf({ amountCeiling: { currency: 'CZK', limitMinor: 50_000_000 } }),
      ],
    };
    const within = yield* run({
      authority,
      request: { amount: amount(10_000_000), capability: policy(), mode: 'run' },
    });
    expect(within.decision.outcome).toBe('ALLOWED');

    const over = yield* run({
      authority,
      request: { amount: amount(60_000_000), capability: policy(), mode: 'run' },
    });
    expect(over.decision.outcome).toBe('DENIED');
    expect(over.decision.reasons.map(({ code }) => code)).toContain('deny.amount_exceeds_ceiling');

    const missing = yield* run({ authority, request: { capability: policy(), mode: 'run' } });
    expect(missing.decision.reasons.map(({ code }) => code)).toContain('deny.amount_required');
  }),
);

it.effect('names a record inside its own module, never by its raw key alone', () =>
  Effect.gen(function* namesRecordInsideItsModule() {
    const assignedPolicy = policy({ selectors: ['assigned'] });
    const authority: AuthoritySpec = { cells: [cellOf({ selector: { _tag: 'assigned' } })] };
    const records = [{ assigned: principalHolder(), recordKey: 'record-1' }];
    const sameModule = yield* run({
      authority,
      check: { records },
      request: { capability: assignedPolicy, mode: 'run', target: recordTarget(1) },
    });
    expect(sameModule.decision.outcome).toBe('ALLOWED');

    // The same raw key in another owning module is another record object, so no record is proven.
    const otherModule = yield* run({
      authority,
      check: { records },
      request: {
        capability: assignedPolicy,
        mode: 'run',
        target: { moduleKey: ModuleKeySchema.make('commerce.catalog'), recordKey: record(1) },
      },
    });
    expect(otherModule.decision.outcome).toBe('DENIED');
  }),
);

it.effect('matches explicit target sets only for the listed records', () =>
  Effect.gen(function* matchesExplicitTargetSets() {
    const authority: AuthoritySpec = {
      cells: [cellOf({ selector: { _tag: 'targets', recordKeys: [record(1), record(2)] } })],
    };
    const included = yield* run({
      authority,
      request: { capability: policy({ selectors: ['all'] }), mode: 'run', target: recordTarget(1) },
    });
    expect(included.decision.outcome).toBe('ALLOWED');
    const excluded = yield* run({
      authority,
      request: { capability: policy({ selectors: ['all'] }), mode: 'run', target: recordTarget(9) },
    });
    expect(excluded.decision.outcome).toBe('DENIED');
  }),
);

it.effect('requires the parent record read for a sensitive field class', () =>
  Effect.gen(function* requiresParentRecordReadForFieldClass() {
    const fieldPolicy = policy({ fieldClass: 'margins', kind: 'field_read', modes: ['run'], risk: 'sensitive' });
    const parent = policy({
      capabilityKey: capability('finance.invoice.read'),
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
    });
    const request = {
      capability: fieldPolicy,
      mode: 'run' as const,
      parentRead: { capability: parent, target: recordTarget(1) },
      target: recordTarget(1),
    };
    const allowed = yield* run({
      authority: {
        cells: [cellOf({}), cell({ capability: 'finance.invoice.read', selector: { _tag: 'all' } })],
      },
      check: { records: [{ assigned: principalHolder(), recordKey: 'record-1' }] },
      request,
    });
    expect(allowed.decision.outcome).toBe('ALLOWED');
    expect(allowed.decision.evidence.some(({ witness }) => witness.purpose === 'parent_record_read')).toBe(true);
    expect(allowed.check.calls.checkBulk).toBe(1);

    const missing = yield* run({ authority: { cells: [cellOf({})] }, request });
    expect(missing.decision.outcome).toBe('DENIED');
    expect(missing.decision.reasons.map(({ code }) => code)).toContain('deny.parent_read_required');
  }),
);

it.effect('refuses a field read that does not prove the parent record read of its own record', () =>
  Effect.gen(function* refusesFieldReadWithoutParent() {
    const fieldPolicy = policy({ fieldClass: 'margins', kind: 'field_read', modes: ['run'], risk: 'sensitive' });
    const parentPolicy = policy({
      capabilityKey: capability('finance.invoice.read'),
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
      selectors: ['assigned'],
    });
    const withoutParent = yield* run({
      authority: { cells: [cellOf({})] },
      request: { capability: fieldPolicy, mode: 'run', target: recordTarget(1) },
    });
    expect(withoutParent.decision.outcome).toBe('DENIED');
    expect(withoutParent.decision.reasons.map(({ code }) => code)).toContain('deny.parent_read_required');
    // Nothing is asked of the engine: an unproven parent read is refused before the snapshot.
    expect(withoutParent.check.calls.checkBulk).toBe(0);

    const otherRecord = yield* run({
      authority: { cells: [cellOf({}), cell({ capability: 'finance.invoice.read', selector: { _tag: 'assigned' } })] },
      check: { records: [{ assigned: principalHolder(), recordKey: 'record-2' }] },
      request: {
        capability: fieldPolicy,
        mode: 'run',
        parentRead: { capability: parentPolicy, target: recordTarget(2) },
        target: recordTarget(1),
      },
    });
    // The parent read of record-2 says nothing about record-1.
    expect(otherRecord.decision.outcome).toBe('DENIED');
    expect(otherRecord.decision.reasons.map(({ code }) => code)).toContain('deny.parent_read_required');

    const noRecord = yield* run({
      authority: { cells: [cellOf({}), cell({ capability: 'finance.invoice.read', selector: { _tag: 'assigned' } })] },
      request: {
        capability: fieldPolicy,
        mode: 'run',
        parentRead: { capability: parentPolicy, target: recordTarget(1) },
      },
    });
    expect(noRecord.decision.reasons.map(({ code }) => code)).toContain('deny.parent_read_required');
  }),
);

it.effect('holds an agent parent record read to the connection ceiling too', () =>
  Effect.gen(function* holdsAgentParentReadToCeiling() {
    const parentKey = 'finance.invoice.read';
    const fieldPolicy = policy({ fieldClass: 'margins', kind: 'field_read', modes: ['run'], risk: 'routine' });
    const parentPolicy = policy({
      capabilityKey: capability(parentKey),
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
    });
    const cells: AuthoritySpec['cells'] = [
      cellOf({ holder: principalHolder() }),
      cellOf({ holder: agentHolder() }),
      cell({ capability: parentKey, holder: principalHolder() }),
      cell({ capability: parentKey, holder: agentHolder() }),
    ];
    const request = {
      capability: fieldPolicy,
      mode: 'run' as const,
      parentRead: { capability: parentPolicy, target: recordTarget(1) },
      target: recordTarget(1),
    };
    const uncovered = yield* run({
      actor: agentActor(),
      authority: {
        cells,
        connection: connect({
          ceiling: { cells: [{ capabilityKey: capability(capabilityKey), mode: 'run', selector: { _tag: 'all' } }] },
        }),
      },
      request,
    });
    expect(uncovered.decision.outcome).toBe('DENIED');
    expect(uncovered.decision.reasons.map(({ code }) => code)).toContain('deny.connection_ceiling');

    const covered = yield* run({
      actor: agentActor(),
      authority: {
        cells,
        connection: connect({
          ceiling: {
            cells: [
              { capabilityKey: capability(capabilityKey), mode: 'run', selector: { _tag: 'all' } },
              { capabilityKey: capability(parentKey), mode: 'run', selector: { _tag: 'all' } },
            ],
          },
        }),
      },
      request,
    });
    expect(covered.decision.outcome).toBe('ALLOWED');
    expect(covered.check.calls.checkBulk).toBe(1);
  }),
);

it.effect('intersects the person, the agent and the connection ceiling', () =>
  Effect.gen(function* intersectsPersonAgentAndConnection() {
    const agentInput = agentActor();
    const routineRead = policy({
      capabilityKey: capability('finance.invoice.read'),
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
    });
    const authority: AuthoritySpec = {
      cells: [
        cell({ capability: 'finance.invoice.read', holder: principalHolder() }),
        cell({ capability: 'finance.invoice.read', holder: agentHolder() }),
      ],
      connection: connect({
        ceiling: {
          cells: [{ capabilityKey: capability('finance.invoice.read'), mode: 'run', selector: { _tag: 'all' } }],
        },
      }),
    };
    const allowed = yield* run({ actor: agentInput, authority, request: { capability: routineRead, mode: 'run' } });
    expect(allowed.decision.outcome).toBe('ALLOWED');
    expect(allowed.decision.evidence.map(({ side }) => side).toSorted()).toEqual(['agent', 'principal']);

    const withoutAgentCell = yield* run({
      actor: agentInput,
      authority: { ...authority, cells: [cell({ capability: 'finance.invoice.read', holder: principalHolder() })] },
      request: { capability: routineRead, mode: 'run' },
    });
    expect(withoutAgentCell.decision.outcome).toBe('DENIED');

    const narrowCeiling = yield* run({
      actor: agentInput,
      authority: {
        ...authority,
        connection: connect({
          ceiling: {
            cells: [{ capabilityKey: capability('finance.invoice.read'), mode: 'run', selector: { _tag: 'assigned' } }],
          },
        }),
      },
      request: {
        capability: policy({ kind: 'read', modes: ['run'], risk: 'routine', selectors: ['assigned'] }),
        mode: 'run',
        target: recordTarget(1),
      },
    });
    // The record is not assigned to the agent, so the narrowed ceiling cannot open it.
    expect(narrowCeiling.decision.outcome).toBe('DENIED');
  }),
);

it.effect('applies agent tiers: routine read runs, sensitive read never, sensitive action proposes', () =>
  Effect.gen(function* appliesAgentTiers() {
    const agentInput = agentActor();
    const sensitiveRead = policy({ kind: 'read', modes: ['run'], risk: 'sensitive' });
    const sensitiveReadDecision = yield* run({
      actor: agentInput,
      authority: { cells: [], connection: connect() },
      request: { capability: sensitiveRead, mode: 'run' },
    });
    expect(sensitiveReadDecision.decision.outcome).toBe('DENIED');
    expect(sensitiveReadDecision.decision.reasons.map(({ code }) => code)).toContain('deny.agent_sensitive_read');

    const adminDecision = yield* run({
      actor: agentInput,
      authority: { cells: [], connection: connect() },
      request: { capability: policy({ kind: 'admin', risk: 'critical' }), mode: 'run' },
    });
    expect(adminDecision.decision.reasons.map(({ code }) => code)).toContain('deny.agent_forbidden');

    const sensitiveAction = policy({ risk: 'sensitive' });
    const proposeAuthority: AuthoritySpec = {
      cells: [
        cellOf({ holder: principalHolder(), mode: 'propose' }),
        cellOf({ holder: agentHolder(), mode: 'propose' }),
      ],
      connection: connect({
        ceiling: { cells: [{ capabilityKey: capability(capabilityKey), mode: 'propose', selector: { _tag: 'all' } }] },
      }),
    };
    const approval = yield* run({
      actor: agentInput,
      authority: proposeAuthority,
      request: { capability: sensitiveAction, mode: 'run' },
    });
    expect(approval.decision.outcome).toBe('NEEDS_APPROVAL');
    expect(approval.decision.reasons.map(({ code }) => code)).toContain('approval.required');

    const noProposeCell = yield* run({
      actor: agentInput,
      authority: { cells: [], connection: connect() },
      request: { capability: sensitiveAction, mode: 'run' },
    });
    expect(noProposeCell.decision.outcome).toBe('DENIED');
  }),
);

it.effect('offers a human proposal when only propose cells exist', () =>
  Effect.gen(function* offersHumanProposal() {
    const sensitiveAction = policy({ risk: 'sensitive' });
    const { decision } = yield* run({
      authority: { cells: [cellOf({ mode: 'propose' })] },
      request: { capability: sensitiveAction, mode: 'run' },
    });
    expect(decision.outcome).toBe('NEEDS_APPROVAL');
  }),
);

it.effect('bounds an agent decision by the agent own membership end and refuses it once passed', () =>
  Effect.gen(function* perHolderMembershipDeadlines() {
    const routineRead = policy({
      capabilityKey: capability('finance.invoice.read'),
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
    });
    const authority: AuthoritySpec = {
      agentMembershipDeadlines: [{ source: 'membership', until: at('2027-01-15T00:00:00Z') }],
      cells: [
        cell({ capability: 'finance.invoice.read', holder: principalHolder() }),
        cell({ capability: 'finance.invoice.read', holder: agentHolder() }),
      ],
      connection: connect({
        ceiling: {
          cells: [{ capabilityKey: capability('finance.invoice.read'), mode: 'run', selector: { _tag: 'all' } }],
        },
        deadline: at('2027-06-01T00:00:00Z'),
      }),
      membershipDeadlines: [{ source: 'membership', until: at('2027-03-01T00:00:00Z') }],
    };
    const allowed = yield* run({ actor: agentActor(), authority, request: { capability: routineRead, mode: 'run' } });
    expect(allowed.decision.outcome).toBe('ALLOWED');
    // The earlier of the person's and the agent's own membership end bounds the admission (D6).
    expect(allowed.decision.admissionDeadline).toEqual(at('2027-01-15T00:00:00Z'));

    const ended = yield* run({
      actor: agentActor(),
      authority: {
        ...authority,
        agentMembershipDeadlines: [{ source: 'membership', until: at('2026-10-01T00:00:00Z') }],
      },
      request: { capability: routineRead, mode: 'run' },
    });
    expect(ended.decision.outcome).toBe('DENIED');
    expect(ended.decision.reasons.map(({ code }) => code)).toContain('deny.deadline_passed');
  }),
);

it.effect('matches a membership end by holder identity, never by side of the scope', () =>
  Effect.gen(function* deadlinesBelongToTheirHolder() {
    const liveUntil = at('2027-01-01T00:00:00Z');
    const endedAt = at('2026-10-01T00:00:00Z');
    const authority: AuthoritySpec = { cells: [cellOf()] };
    const check = makeCheck({ authority });
    // Two members of one side: somebody else's live membership is read first. Matching by side would
    // hand the actor that entry and allow a decision its own membership end refuses.
    const foreignFirst = [membershipEnd(otherPerson, liveUntil), membershipEnd(person, endedAt)];
    const foreign = yield* decideAccess(
      authorityWithHolderDeadlines(makeAuthority(authority), foreignFirst),
      check.port,
      {
        actor: human,
        now,
        request: { capability: policy(), mode: 'run' },
      },
    );
    expect(foreign.outcome).toBe('DENIED');
    expect(foreign.reasons.map(({ code }) => code)).toContain('deny.deadline_passed');

    // The other direction: somebody else's end never closes a membership that is still live.
    const ownFirst = [membershipEnd(otherPerson, endedAt), membershipEnd(person, liveUntil)];
    const own = yield* decideAccess(authorityWithHolderDeadlines(makeAuthority(authority), ownFirst), check.port, {
      actor: human,
      now,
      request: { capability: policy(), mode: 'run' },
    });
    expect(own.outcome).toBe('ALLOWED');
    expect(own.admissionDeadline).toEqual(liveUntil);
  }),
);

it.effect('binds the agent connection to its own agent, person and scope', () =>
  Effect.gen(function* bindsConnectionToItsAgentAndScope() {
    const routineRead = policy({
      capabilityKey: capability('finance.invoice.read'),
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
    });
    const cells = [
      cell({ capability: 'finance.invoice.read', holder: principalHolder() }),
      cell({ capability: 'finance.invoice.read', holder: agentHolder() }),
    ];
    const ceiling = {
      cells: [
        { capabilityKey: capability('finance.invoice.read'), mode: 'run' as const, selector: { _tag: 'all' as const } },
      ],
    };
    const allowed = yield* run({
      actor: agentActor(),
      authority: { cells, connection: connect({ ceiling }) },
      request: { capability: routineRead, mode: 'run' },
    });
    expect(allowed.decision.outcome).toBe('ALLOWED');

    // A consent granted to another agent (or another scope) never authorizes this one.
    const otherAgent = yield* run({
      actor: agentActor(),
      authority: { cells, connection: connect({ agentId: AgentIdSchema.make(uuid(77)), ceiling }) },
      request: { capability: routineRead, mode: 'run' },
    });
    expect(otherAgent.decision.outcome).toBe('DENIED');
    expect(otherAgent.decision.reasons.map(({ code }) => code)).toContain('deny.connection_inactive');

    const otherScope = yield* run({
      actor: agentActor(),
      authority: { cells, connection: connect({ ceiling, scopeId: AccessScopeIdSchema.make(uuid(78)) }) },
      request: { capability: routineRead, mode: 'run' },
    });
    expect(otherScope.decision.outcome).toBe('DENIED');
    expect(otherScope.decision.reasons.map(({ code }) => code)).toContain('deny.connection_inactive');
  }),
);

it.effect('denies a stale consent revision and an expired assignment without guessing', () =>
  Effect.gen(function* deniesStaleConsentAndExpiredAssignment() {
    const stale = yield* run({
      actor: agentActor(7),
      authority: {
        cells: [cellOf({ holder: principalHolder() }), cellOf({ holder: agentHolder() })],
        connection: connect({
          ceiling: {
            cells: [
              {
                capabilityKey: capability(capabilityKey),
                mode: 'run',
                selector: { _tag: 'all' },
              },
            ],
          },
          consentRevision: 3,
        }),
      },
      request: { capability: policy(), mode: 'run' },
    });
    expect(stale.decision.outcome).toBe('DENIED');
    expect(stale.decision.reasons.map(({ code }) => code)).toContain('deny.consent_stale');

    const expired = yield* run({
      authority: { cells: [cellOf({ deadline: at('2026-10-01T00:00:00Z') })] },
      request: { capability: policy(), mode: 'run' },
    });
    expect(expired.decision.outcome).toBe('DENIED');
    expect(expired.decision.reasons.map(({ code }) => code)).toContain('deny.deadline_passed');
    expect(expired.check.calls.checkBulk).toBe(0);
  }),
);

it.effect('never lets a sibling caveated grant of the same slot decide this cell', () =>
  Effect.gen(function* siblingCaveatDoesNotDecide() {
    // Two roles fill the same capability slot; only one of their grants has an evaluable caveat.
    const usable = cellOf({ role: 1 });
    const sibling = cellOf({ role: 2 });
    const { decision } = yield* run({
      authority: { cells: [usable, sibling] },
      check: { indeterminateGrants: [sibling.grantIncarnationId] },
      request: { capability: policy(), mode: 'run' },
    });
    expect(decision.outcome).toBe('ALLOWED');
    expect(decision.evidence.map(({ witness }) => witness.grantIncarnationId)).toEqual([usable.grantIncarnationId]);
  }),
);

it.effect('returns UNAVAILABLE for a per-item engine error and for a truncated answer', () =>
  Effect.gen(function* unavailableForEngineFaults() {
    // A per-item error is an unavailable engine, never a denial (O48b, L1).
    const failed = yield* run({
      authority: { cells: [cellOf({})] },
      check: { engineError: true },
      request: { capability: policy(), mode: 'run' },
    });
    expect(failed.decision.outcome).toBe('UNAVAILABLE');
    expect(decisionHttpStatus(failed.decision.outcome)).toBe(503);

    const truncated = yield* run({
      authority: { cells: [cellOf({})] },
      check: { missingResults: 1 },
      request: { capability: policy(), mode: 'run' },
    });
    expect(truncated.decision.outcome).toBe('UNAVAILABLE');
    expect(decisionHttpStatus(truncated.decision.outcome)).toBe(503);
  }),
);

it.effect('returns UNAVAILABLE, never DENIED, when the engine cannot answer', () =>
  Effect.gen(function* returnsUnavailableWhenEngineCannotAnswer() {
    const failed = yield* run({
      authority: { cells: [cellOf()] },
      check: { failure: true },
      request: { capability: policy(), mode: 'run' },
    });
    expect(failed.decision.outcome).toBe('UNAVAILABLE');
    expect(decisionHttpStatus(failed.decision.outcome)).toBe(503);

    const indeterminate = yield* run({
      authority: { cells: [cellOf()] },
      check: { indeterminate: true },
      request: { capability: policy(), mode: 'run' },
    });
    // A conditional permissionship is a fail-closed denial, not a 503 (O46).
    expect(indeterminate.decision.outcome).toBe('DENIED');
    expect(indeterminate.decision.reasons.map(({ code }) => code)).toContain('deny.caveat_indeterminate');
    expect(decisionHttpStatus(indeterminate.decision.outcome)).toBe(403);
  }),
);

it.effect('never lets an agent run a sensitive cell even when the run tuple exists', () =>
  Effect.gen(function* neverLetsAgentRunSensitiveCell() {
    const agentInput = agentActor();
    const sensitiveAction = policy({ risk: 'sensitive' });
    const authority: AuthoritySpec = {
      cells: [cellOf({ holder: principalHolder(), mode: 'run' }), cellOf({ holder: agentHolder(), mode: 'run' })],
      connection: connect({
        ceiling: { cells: [{ capabilityKey: capability(capabilityKey), mode: 'run', selector: { _tag: 'all' } }] },
      }),
    };
    const directRun = yield* run({
      actor: agentInput,
      authority,
      request: { capability: sensitiveAction, mode: 'run' },
    });
    expect(directRun.decision.outcome).not.toBe('ALLOWED');
    expect(directRun.decision.outcome).toBe('DENIED');

    const withPropose: AuthoritySpec = {
      cells: [
        ...authority.cells,
        cellOf({ holder: principalHolder(), mode: 'propose' }),
        cellOf({ holder: agentHolder(), mode: 'propose' }),
      ],
      connection: connect({
        ceiling: {
          cells: [{ capabilityKey: capability(capabilityKey), mode: 'propose', selector: { _tag: 'all' } }],
        },
      }),
    };
    const proposed = yield* run({
      actor: agentInput,
      authority: withPropose,
      request: { capability: sensitiveAction, mode: 'run' },
    });
    expect(proposed.decision.outcome).toBe('NEEDS_APPROVAL');
  }),
);

it.effect('keeps approval impossible when the declaration has no approve mode', () =>
  Effect.gen(function* keepsApprovalImpossibleWithoutApprove() {
    const proposeOnly: DecisionCapabilityPolicy = {
      capabilityKey: capability(capabilityKey),
      kind: 'action',
      modes: ['run', 'propose'],
      risk: 'sensitive',
      selectors: [],
    };
    const proposeCells = [
      cellOf({ holder: principalHolder(), mode: 'propose' }),
      cellOf({ holder: agentHolder(), mode: 'propose' }),
    ];
    const agentAttempt = yield* run({
      actor: agentActor(),
      authority: {
        cells: proposeCells,
        connection: connect({
          ceiling: {
            cells: [{ capabilityKey: capability(capabilityKey), mode: 'propose', selector: { _tag: 'all' } }],
          },
        }),
      },
      request: { capability: proposeOnly, mode: 'run' },
    });
    expect(agentAttempt.decision.outcome).toBe('DENIED');
    const humanAttempt = yield* run({
      authority: { cells: proposeCells },
      request: { capability: proposeOnly, mode: 'run' },
    });
    expect(humanAttempt.decision.outcome).toBe('DENIED');
  }),
);

it.effect('runs a human admin action that declares only run and still refuses agents', () =>
  Effect.gen(function* runsHumanAdminAction() {
    const adminPolicy: DecisionCapabilityPolicy = {
      capabilityKey: capability(capabilityKey),
      kind: 'admin',
      modes: ['run'],
      risk: 'sensitive',
      selectors: [],
    };
    const humanDecision = yield* run({
      authority: { cells: [cellOf()] },
      request: { capability: adminPolicy, mode: 'run' },
    });
    expect(humanDecision.decision.outcome).toBe('ALLOWED');
    const agentAttempt = yield* run({
      actor: agentActor(),
      authority: { cells: [cellOf({ holder: agentHolder() })], connection: connect() },
      request: { capability: adminPolicy, mode: 'run' },
    });
    expect(agentAttempt.decision.outcome).toBe('DENIED');
    expect(agentAttempt.decision.reasons.map(({ code }) => code)).toContain('deny.agent_forbidden');
  }),
);

it.effect('keeps the selectors of both sides apart so an agent never widens the person', () =>
  Effect.gen(function* keepsSelectorSidesApart() {
    const mixedPolicy = policy({ selectors: ['all', 'assigned'] });
    const authority: AuthoritySpec = {
      cells: [
        cellOf({ holder: principalHolder(), selector: { _tag: 'assigned' } }),
        cellOf({ holder: agentHolder(), selector: { _tag: 'all' } }),
      ],
      connection: connect({
        ceiling: { cells: [{ capabilityKey: capability(capabilityKey), mode: 'run', selector: { _tag: 'all' } }] },
      }),
    };
    const { decision } = yield* run({
      actor: agentActor(),
      authority,
      check: { records: [{ assigned: principalHolder(), recordKey: 'record-1' }] },
      request: { capability: mixedPolicy, mode: 'run', target: recordTarget(1) },
    });
    expect(decision.outcome).toBe('ALLOWED');
    // `assigned` from the person and `all` from the agent intersect to `assigned`; the caller must
    // apply both, so the two selectors never merge into one wider filter (L3, D22).
    expect(decision.selectors).toEqual([
      { selector: 'assigned', side: 'principal' },
      { selector: 'all', side: 'agent' },
    ]);
  }),
);

it.effect('asks the engine only about human principals and agents', () =>
  Effect.gen(function* asksOnlyAboutPrincipalsAndAgents() {
    const agentInput = agentActor();
    const routineRead = policy({
      capabilityKey: capability('finance.invoice.read'),
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
    });
    const { check } = yield* run({
      actor: agentInput,
      authority: {
        cells: [
          cell({ capability: 'finance.invoice.read', holder: principalHolder() }),
          cell({ capability: 'finance.invoice.read', holder: agentHolder() }),
        ],
        connection: connect({
          ceiling: {
            cells: [{ capabilityKey: capability('finance.invoice.read'), mode: 'run', selector: { _tag: 'all' } }],
          },
        }),
      },
      request: { capability: routineRead, mode: 'run' },
    });
    expect(check.subjects.length).toBeGreaterThan(0);
    // Holders are a human principal and an agent only; the other subjects are the exact projection
    // objects a witness-chain relation check correlates with, and never a legacy principal kind.
    expect([...new Set(check.subjects)].toSorted()).toEqual([
      'access_assignment',
      'access_grant',
      'agent',
      'principal',
    ]);
  }),
);

it.effect('proves the whole witness chain of the cell it grants', () =>
  Effect.gen(function* provesWitnessChain() {
    const granted = cellOf({});
    const { check, decision } = yield* run({
      authority: { cells: [granted] },
      request: { capability: policy(), mode: 'run' },
    });
    expect(decision.outcome).toBe('ALLOWED');
    const grantId = grantObjectId(tenant, scopeId, granted.roleId, granted);
    const assignmentId = assignmentObjectId(tenant, scopeId, granted.assignmentIncarnationId);
    const item = (resourceType: string, permission: string) =>
      check.sent.find((candidate) => candidate.resource.type === resourceType && candidate.permission === permission);
    // The grant cell itself, under the request context.
    expect(item('access_grant', 'use')?.resource.id).toBe(grantId);
    // The exact capability slot names that exact grant (a relation, never the slot permission).
    const slot = item('access_capability', 'run_all_grant');
    expect(slot?.subject).toEqual({ id: grantId, type: 'access_grant' });
    // The immutable assignment incarnation the evidence names is live ...
    expect(item('access_assignment', 'eligible')?.resource.id).toBe(assignmentId);
    // ... and it is the member userset of the binding the grant hangs from.
    expect(item('access_role_binding', 'member')?.subject).toEqual({
      id: assignmentId,
      relation: 'holder',
      type: 'access_assignment',
    });
    // One snapshot proves all of them, and every subject is a v2 subject type.
    expect(check.calls.checkBulk).toBe(1);
    expect([...new Set(check.sent.map(({ subject }) => subject.type))].toSorted()).toEqual([
      'access_assignment',
      'access_grant',
      'principal',
    ]);
  }),
);

it.effect('sends only the request-side caveat values and never the stored limits', () =>
  Effect.gen(function* sendsOnlyRequestSideContext() {
    const bounded = cellOf({ amountCeiling: { currency: 'CZK', limitMinor: 1000 } });
    const amountRun = yield* run({
      authority: { cells: [bounded] },
      request: { amount: amount(500), capability: policy(), mode: 'run' },
    });
    expect(amountRun.decision.outcome).toBe('ALLOWED');
    // The grant's own limit stays in the relationship; the request carries the amount only (L5).
    expect(amountRun.check.sent[0]?.context).toEqual({ amount_minor: 500, currency: 'CZK' });

    const targeted = cellOf({ selector: { _tag: 'targets', recordKeys: [record(1), record(2)] } });
    const targetRun = yield* run({
      authority: { cells: [targeted] },
      request: { capability: policy({ selectors: ['all'] }), mode: 'run', target: recordTarget(1) },
    });
    expect(targetRun.decision.outcome).toBe('ALLOWED');
    expect(targetRun.check.sent[0]?.context).toEqual({ resource_key: record(1) });
  }),
);

it.effect('denies a projection mismatch instead of trusting only the capability slot', () =>
  Effect.gen(function* deniesProjectionMismatch() {
    const authorityCell = cellOf();
    const { decision } = yield* run({
      authority: { cells: [authorityCell] },
      // The capability slot still answers (it is not scripted here), but the exact grant is gone.
      check: { liveGrants: [] },
      request: { capability: policy(), mode: 'run' },
    });
    expect(decision.outcome).toBe('DENIED');
  }),
);

it.effect('explains granted authority and denied requests without product prose', () =>
  Effect.gen(function* explainsGrantedAuthority() {
    const { decision } = yield* run({
      authority: { cells: [cellOf()] },
      request: { capability: policy(), mode: 'run' },
    });
    const [evidence] = decision.evidence;
    const roleLabels = new Map(evidence === undefined ? [] : [[evidence.roleId, 'Účetní']]);
    const explanation = explainAccess({ decision, grantableBy: [otherPerson], policy: policy(), roleLabels });
    expect(explanation.outcome).toBe('ALLOWED');
    expect(explanation.requestable).toBe(false);
    expect(explanation.reasonCodes).toContain('allow.granted');
    expect(explanation.authority[0]?.roleLabel).toBe('Účetní');
    expect(explanation.grantableBy.length).toBe(1);
    expect(explanation.authority[0]?.capabilityKey).toBe(capabilityKey);

    const denied = yield* run({ authority: { cells: [] }, request: { capability: policy(), mode: 'run' } });
    const deniedExplanation = explainAccess({ decision: denied.decision, policy: policy() });
    expect(deniedExplanation.requestable).toBe(true);
    expect(deniedExplanation.grantableBy).toEqual([]);
  }),
);
