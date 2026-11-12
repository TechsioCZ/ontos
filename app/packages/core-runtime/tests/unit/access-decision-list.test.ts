import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ActorContextInput } from '../../src/access/decision/authority.ts';
import type { AccessDecisionRequest, DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import { decideAccess, resolveListAccess, resolveListAccessMany } from '../../src/access/decision/engine.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import { evaluateListAccessPredicate } from '../../src/access/decision/list-access.ts';
import type {
  ListAccessCondition,
  ListAccessPredicate,
  ListRowProjection,
} from '../../src/access/decision/list-access.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { AmountCeilingSchema } from '../../src/access/model.ts';
import {
  agent,
  agentHolder,
  amount,
  at,
  capability,
  cell,
  connect,
  connectionId,
  holderId,
  makeAuthority,
  makeCheck,
  otherPerson,
  person,
  principalHolder,
  record,
  recordTargetOf,
  row,
  team,
  tenant,
} from './access-decision-support.ts';
import type { AuthoritySpec, CheckSpec, RecordRow } from './access-decision-support.ts';

const now = at('2026-11-03T12:00:00Z');
const capabilityKey = 'finance.invoice.void';

const policy = (overrides: Partial<DecisionCapabilityPolicy> = {}): DecisionCapabilityPolicy => ({
  capabilityKey: capability(capabilityKey),
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  risk: 'routine',
  selectors: ['assigned'],
  ...overrides,
});

const human: ActorContextInput = { actor: { _tag: 'Principal', principalId: person }, tenantId: tenant };
const teamOne = team(1);
const teamTwo = team(2);
const teamThree = team(3);

const resolve = (input: {
  readonly actor?: ActorContextInput;
  readonly authority: AuthoritySpec;
  readonly check?: Omit<CheckSpec, 'authority'>;
  readonly records?: readonly RecordRow[];
  readonly request: AccessDecisionRequest;
}) => {
  const authority = makeAuthority(input.authority);
  const check = makeCheck({ authority: input.authority, ...input.check, records: input.records ?? [] });
  return Effect.map(
    resolveListAccess(authority.port, check.port, {
      actor: input.actor ?? human,
      capability: input.request.capability,
      mode: input.request.mode,
      now,
    }),
    (resolution) => ({ authority, check, resolution }),
  );
};

const recordDecision = (input: {
  readonly actor?: ActorContextInput;
  readonly authority: AuthoritySpec;
  readonly check?: Omit<CheckSpec, 'authority'>;
  readonly listRow: ListRowProjection;
  readonly records?: readonly RecordRow[];
  readonly request: AccessDecisionRequest;
}) => {
  const authority = makeAuthority(input.authority);
  const check = makeCheck({ authority: input.authority, ...input.check, records: input.records ?? [] });
  return decideAccess(authority.port, check.port, {
    actor: input.actor ?? human,
    now,
    request: withOptional(
      withOptional(
        {
          capability: input.request.capability,
          mode: input.request.mode,
          target: recordTargetOf(input.listRow.recordKey),
        },
        'amount',
        input.listRow.amount,
      ),
      'parentRead',
      input.request.parentRead,
    ),
  });
};

const conditionKind = (condition: ListAccessCondition): string =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => 'all',
      AmountWithinCeiling: () => 'amount',
      AssignedTo: () => 'assigned',
      EntrustedTo: () => 'entrusted',
      RecordKeyIn: () => 'targets',
      TeamMemberOf: () => 'team',
    }),
    Match.exhaustive,
  );

const conditionKinds = (predicate: ListAccessPredicate | undefined): readonly string[] =>
  (predicate?.groups ?? []).flatMap((group) => group.clauses.flatMap((clause) => clause.conditions.map(conditionKind)));

const predicateOf = (
  firstCondition: ListAccessCondition,
  ...restConditions: readonly ListAccessCondition[]
): ListAccessPredicate => ({
  groups: [{ clauses: [{ conditions: [firstCondition, ...restConditions] }] }],
});

/** D16: a row is listed exactly when the per-record decision allows it. */
const expectListEqualsPerRecord = (
  rows: readonly ListRowProjection[],
  input: {
    readonly actor?: ActorContextInput;
    readonly authority: AuthoritySpec;
    readonly check?: Omit<CheckSpec, 'authority'>;
    readonly predicate: ListAccessPredicate | undefined;
    readonly records?: readonly RecordRow[];
    readonly request: AccessDecisionRequest;
  },
) =>
  Effect.gen(function* expectListEqualsPerRecordEffect() {
    for (const listRow of rows) {
      const current = withOptional(
        withOptional(
          withOptional({ authority: input.authority, listRow, request: input.request }, 'actor', input.actor),
          'records',
          input.records,
        ),
        'check',
        input.check,
      );
      const decision = yield* recordDecision(current);
      const listed = input.predicate !== undefined && evaluateListAccessPredicate(input.predicate, listRow);
      expect(listed).toBe(decision.outcome === 'ALLOWED');
    }
  });

const records: readonly RecordRow[] = [
  { assigned: principalHolder(), recordKey: 'record-1' },
  { assigned: principalHolder(otherPerson), recordKey: 'record-2' },
  { recordKey: 'record-3' },
];

it.effect('turns assigned scope into a positive owner predicate that equals per-row decisions', () =>
  Effect.gen(function* turnsAssignedScopeIntoOwnerPredicate() {
    const authority: AuthoritySpec = { cells: [cell({ capability: capabilityKey, selector: { _tag: 'assigned' } })] };
    const { resolution } = yield* resolve({ authority, records, request: { capability: policy(), mode: 'run' } });
    expect(resolution.decision.outcome).toBe('ALLOWED');
    expect(conditionKinds(resolution.predicate)).toEqual(['assigned']);
    yield* expectListEqualsPerRecord(
      [
        row({ assigned: principalHolder(), recordKey: 'record-1' }),
        row({ assigned: principalHolder(otherPerson), recordKey: 'record-2' }),
        row({ recordKey: 'record-3' }),
      ],
      { authority, predicate: resolution.predicate, records, request: { capability: policy(), mode: 'run' } },
    );
  }),
);

it('never matches a NULL owner, team or amount column', () => {
  const nullOwner = row({ recordKey: 'record-1' });
  expect(evaluateListAccessPredicate(predicateOf({ _tag: 'AssignedTo', holder: principalHolder() }), nullOwner)).toBe(
    false,
  );
  expect(evaluateListAccessPredicate(predicateOf({ _tag: 'EntrustedTo', holder: principalHolder() }), nullOwner)).toBe(
    false,
  );
  expect(
    evaluateListAccessPredicate(
      predicateOf({ _tag: 'TeamMemberOf', teamIds: [teamOne] }),
      row({ recordKey: 'record-1' }),
    ),
  ).toBe(false);
  expect(
    evaluateListAccessPredicate(
      predicateOf({
        _tag: 'AmountWithinCeiling',
        ceiling: Schema.decodeSync(AmountCeilingSchema)({ currency: 'CZK', limitMinor: 100 }),
      }),
      row({ recordKey: 'record-1' }),
    ),
  ).toBe(false);
  expect(
    evaluateListAccessPredicate(
      predicateOf({ _tag: 'RecordKeyIn', recordKeys: [record(1)] }),
      row({ recordKey: 'record-1' }),
    ),
  ).toBe(true);
});

it.effect('keeps team scope as explicit team ids', () =>
  Effect.gen(function* keepsTeamScopeAsExplicitTeamIds() {
    const authority: AuthoritySpec = {
      cells: [cell({ capability: capabilityKey, selector: { _tag: 'team' } })],
      teamMembers: new Map([[holderId(principalHolder()), [teamOne]]]),
    };
    const teamRecords: readonly RecordRow[] = [
      { recordKey: 'record-1', teamIds: [teamOne] },
      { recordKey: 'record-2', teamIds: [teamTwo] },
      { recordKey: 'record-3' },
    ];
    const { resolution } = yield* resolve({
      authority,
      records: teamRecords,
      request: { capability: policy({ selectors: ['team'] }), mode: 'run' },
    });
    expect(conditionKinds(resolution.predicate)).toEqual(['team']);
    yield* expectListEqualsPerRecord(
      [row({ recordKey: 'record-1', teamIds: [teamOne] }), row({ recordKey: 'record-2', teamIds: [teamTwo] })],
      {
        authority,
        predicate: resolution.predicate,
        records: teamRecords,
        request: { capability: policy({ selectors: ['team'] }), mode: 'run' },
      },
    );
  }),
);

it.effect('keeps explicit target sets inside the owner predicate', () =>
  Effect.gen(function* keepsExplicitTargetSets() {
    const authority: AuthoritySpec = {
      cells: [cell({ capability: capabilityKey, selector: { _tag: 'targets', recordKeys: [record(1), record(2)] } })],
    };
    const { resolution } = yield* resolve({
      authority,
      request: { capability: policy({ selectors: ['all'] }), mode: 'run' },
    });
    expect(conditionKinds(resolution.predicate)).toEqual(['targets']);
    yield* expectListEqualsPerRecord([row({ recordKey: 'record-1' }), row({ recordKey: 'record-9' })], {
      authority,
      predicate: resolution.predicate,
      request: { capability: policy({ selectors: ['all'] }), mode: 'run' },
    });
  }),
);

it.effect('carries the grant amount ceiling into the owner predicate', () =>
  Effect.gen(function* carriesAmountCeiling() {
    const authority: AuthoritySpec = {
      cells: [cell({ amountCeiling: { currency: 'CZK', limitMinor: 1000 }, capability: capabilityKey })],
    };
    const amountPolicy = policy({ selectors: [] });
    const { resolution } = yield* resolve({ authority, request: { capability: amountPolicy, mode: 'run' } });
    expect(conditionKinds(resolution.predicate)).toEqual(['amount']);
    yield* expectListEqualsPerRecord(
      [
        row({ amount: amount(500), recordKey: 'record-1' }),
        row({ amount: amount(1000), recordKey: 'record-2' }),
        row({ amount: amount(1001), recordKey: 'record-3' }),
        row({ recordKey: 'record-4' }),
      ],
      { authority, predicate: resolution.predicate, request: { capability: amountPolicy, mode: 'run' } },
    );
  }),
);

it.effect('intersects the person and the agent for the same list', () =>
  Effect.gen(function* intersectsPersonAndAgentForList() {
    const agentInput: ActorContextInput = {
      actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision: 1, principalId: person },
      tenantId: tenant,
    };
    const authority: AuthoritySpec = {
      cells: [
        cell({ capability: capabilityKey, holder: principalHolder() }),
        cell({ capability: capabilityKey, holder: agentHolder(), selector: { _tag: 'assigned' } }),
      ],
      connection: connect({
        ceiling: { cells: [{ capabilityKey: capability(capabilityKey), mode: 'run', selector: { _tag: 'all' } }] },
      }),
    };
    const agentRecords: readonly RecordRow[] = [
      { assigned: agentHolder(), recordKey: 'record-1' },
      { assigned: principalHolder(), recordKey: 'record-2' },
      { recordKey: 'record-3' },
    ];
    const { resolution } = yield* resolve({
      actor: agentInput,
      authority,
      records: agentRecords,
      request: { capability: policy({ selectors: ['assigned'] }), mode: 'run' },
    });
    expect(resolution.decision.outcome).toBe('ALLOWED');
    expect(conditionKinds(resolution.predicate)).toEqual(['assigned']);
    yield* expectListEqualsPerRecord(
      [
        row({ assigned: agentHolder(), recordKey: 'record-1' }),
        row({ assigned: principalHolder(), recordKey: 'record-2' }),
        row({ recordKey: 'record-3' }),
      ],
      {
        actor: agentInput,
        authority,
        predicate: resolution.predicate,
        records: agentRecords,
        request: { capability: policy({ selectors: ['assigned'] }), mode: 'run' },
      },
    );
  }),
);

it.effect('narrows an assigned list by the connection target set and amount ceiling', () =>
  Effect.gen(function* narrowsAssignedListByConnection() {
    const agentInput: ActorContextInput = {
      actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision: 1, principalId: person },
      tenantId: tenant,
    };
    const authority: AuthoritySpec = {
      cells: [
        cell({ amountCeiling: { currency: 'CZK', limitMinor: 1000 }, capability: capabilityKey }),
        cell({
          amountCeiling: { currency: 'CZK', limitMinor: 1000 },
          capability: capabilityKey,
          holder: agentHolder(),
        }),
      ],
      connection: connect({
        ceiling: {
          cells: [
            {
              amountCeiling: yield* Schema.decodeEffect(AmountCeilingSchema)({ currency: 'CZK', limitMinor: 400 }),
              capabilityKey: capability(capabilityKey),
              mode: 'run',
              selector: { _tag: 'targets', recordKeys: [record(1)] },
            },
          ],
        },
      }),
    };
    const listPolicy = policy({ selectors: [] });
    const { resolution } = yield* resolve({
      actor: agentInput,
      authority,
      request: { capability: listPolicy, mode: 'run' },
    });
    expect(resolution.decision.outcome).toBe('ALLOWED');
    expect(resolution.predicate).toBeDefined();
    yield* expectListEqualsPerRecord(
      [
        row({ amount: amount(300), recordKey: 'record-1' }),
        row({ amount: amount(500), recordKey: 'record-1' }),
        row({ amount: amount(300), recordKey: 'record-2' }),
        row({ recordKey: 'record-1' }),
      ],
      {
        actor: agentInput,
        authority,
        predicate: resolution.predicate,
        request: { capability: listPolicy, mode: 'run' },
      },
    );
  }),
);

it.effect('keeps each consent cell paired with its own amount ceiling', () =>
  Effect.gen(function* keepsConsentCellsApart() {
    const agentInput: ActorContextInput = {
      actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision: 1, principalId: person },
      tenantId: tenant,
    };
    const decodeCeiling = Schema.decodeEffect(AmountCeilingSchema);
    const authority: AuthoritySpec = {
      cells: [
        cell({ capability: capabilityKey, holder: principalHolder() }),
        cell({ capability: capabilityKey, holder: agentHolder(), selector: { _tag: 'assigned' } }),
      ],
      connection: connect({
        ceiling: {
          cells: [
            {
              amountCeiling: yield* decodeCeiling({ currency: 'CZK', limitMinor: 100 }),
              capabilityKey: capability(capabilityKey),
              mode: 'run',
              selector: { _tag: 'assigned' },
            },
            {
              amountCeiling: yield* decodeCeiling({ currency: 'CZK', limitMinor: 1000 }),
              capabilityKey: capability(capabilityKey),
              mode: 'run',
              selector: { _tag: 'targets', recordKeys: [record(2)] },
            },
          ],
        },
      }),
    };
    const agentRecords: readonly RecordRow[] = [
      { assigned: agentHolder(), recordKey: 'record-1' },
      { assigned: agentHolder(), recordKey: 'record-2' },
    ];
    const listPolicy = policy({ selectors: ['all', 'assigned'] });
    const { resolution } = yield* resolve({
      actor: agentInput,
      authority,
      records: agentRecords,
      request: { capability: listPolicy, mode: 'run' },
    });
    expect(resolution.decision.outcome).toBe('ALLOWED');
    expect(resolution.decision.evidence).toHaveLength(2);
    const rows = [
      // Neither consent cell admits it: `assigned` stops at 100 and `targets` names only record-2.
      row({ amount: amount(500), assigned: agentHolder(), recordKey: 'record-1' }),
      row({ amount: amount(500), assigned: agentHolder(), recordKey: 'record-2' }),
      row({ amount: amount(50), assigned: agentHolder(), recordKey: 'record-1' }),
    ];
    expect(
      rows.map(
        (listRow) => resolution.predicate !== undefined && evaluateListAccessPredicate(resolution.predicate, listRow),
      ),
    ).toEqual([false, true, true]);
    yield* expectListEqualsPerRecord(rows, {
      actor: agentInput,
      authority,
      predicate: resolution.predicate,
      records: agentRecords,
      request: { capability: listPolicy, mode: 'run' },
    });
  }),
);

it.effect('keeps every team the holder is in and matches no row outside them', () =>
  Effect.gen(function* keepsSeveralTeams() {
    const authority: AuthoritySpec = {
      cells: [cell({ capability: capabilityKey, selector: { _tag: 'team' } })],
      teamMembers: new Map([[holderId(principalHolder()), [teamOne, teamTwo]]]),
    };
    const teamPolicy = policy({ selectors: ['team'] });
    const teamRecords: readonly RecordRow[] = [
      { recordKey: 'record-1', teamIds: [teamOne] },
      { recordKey: 'record-2', teamIds: [teamTwo] },
      { recordKey: 'record-3', teamIds: [teamThree] },
      { recordKey: 'record-4' },
    ];
    const { resolution } = yield* resolve({
      authority,
      records: teamRecords,
      request: { capability: teamPolicy, mode: 'run' },
    });
    expect(resolution.decision.outcome).toBe('ALLOWED');
    expect(resolution.predicate).toEqual(predicateOf({ _tag: 'TeamMemberOf', teamIds: [teamOne, teamTwo] }));
    yield* expectListEqualsPerRecord(
      [
        row({ recordKey: 'record-1', teamIds: [teamOne] }),
        row({ recordKey: 'record-2', teamIds: [teamTwo] }),
        row({ recordKey: 'record-3', teamIds: [teamThree] }),
        row({ recordKey: 'record-4' }),
      ],
      {
        authority,
        predicate: resolution.predicate,
        records: teamRecords,
        request: { capability: teamPolicy, mode: 'run' },
      },
    );
  }),
);

it.effect('never widens a team cell with no team to the whole scope of a person', () =>
  Effect.gen(function* emptyTeamIsNoMatchForPerson() {
    const authority: AuthoritySpec = {
      cells: [cell({ capability: capabilityKey, selector: { _tag: 'team' } })],
      teamMembers: new Map([[holderId(principalHolder()), []]]),
    };
    const teamPolicy = policy({ selectors: ['team'] });
    const teamRecords: readonly RecordRow[] = [
      { recordKey: 'record-1', teamIds: [teamOne] },
      { recordKey: 'record-2' },
      { recordKey: 'record-3', teamIds: [teamTwo] },
    ];
    const { resolution } = yield* resolve({
      authority,
      records: teamRecords,
      request: { capability: teamPolicy, mode: 'run' },
    });
    // No predicate at all: the caller returns no rows (guarantee 10).
    expect(resolution.decision.outcome).toBe('DENIED');
    expect(resolution.predicate).toBeUndefined();
    yield* expectListEqualsPerRecord(
      [
        row({ recordKey: 'record-1', teamIds: [teamOne] }),
        row({ recordKey: 'record-2' }),
        row({ recordKey: 'record-3', teamIds: [teamTwo] }),
      ],
      {
        authority,
        predicate: resolution.predicate,
        records: teamRecords,
        request: { capability: teamPolicy, mode: 'run' },
      },
    );
  }),
);

it.effect('keeps the person-and-agent intersection when the agent is in no team', () =>
  Effect.gen(function* emptyAgentTeamKeepsIntersection() {
    const agentInput: ActorContextInput = {
      actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision: 1, principalId: person },
      tenantId: tenant,
    };
    const authority: AuthoritySpec = {
      cells: [
        cell({ capability: capabilityKey, holder: principalHolder() }),
        cell({ capability: capabilityKey, holder: agentHolder(), selector: { _tag: 'team' } }),
      ],
      connection: connect({
        ceiling: { cells: [{ capabilityKey: capability(capabilityKey), mode: 'run', selector: { _tag: 'all' } }] },
      }),
      teamMembers: new Map([
        [holderId(principalHolder()), [teamOne]],
        [holderId(agentHolder()), []],
      ]),
    };
    const teamPolicy = policy({ selectors: ['team'] });
    const teamRecords: readonly RecordRow[] = [
      { recordKey: 'record-1', teamIds: [teamOne] },
      { recordKey: 'record-2' },
    ];
    const { resolution } = yield* resolve({
      actor: agentInput,
      authority,
      records: teamRecords,
      request: { capability: teamPolicy, mode: 'run' },
    });
    expect(resolution.decision.outcome).toBe('DENIED');
    expect(resolution.predicate).toBeUndefined();
    yield* expectListEqualsPerRecord(
      [row({ recordKey: 'record-1', teamIds: [teamOne] }), row({ recordKey: 'record-2' })],
      {
        actor: agentInput,
        authority,
        predicate: resolution.predicate,
        records: teamRecords,
        request: { capability: teamPolicy, mode: 'run' },
      },
    );
  }),
);

it.effect('lists with a resolved cell even when a sibling cell cannot be evaluated', () =>
  Effect.gen(function* conditionalSiblingDoesNotDenyList() {
    const usable = cell({ capability: capabilityKey, role: 1, selector: { _tag: 'assigned' } });
    const sibling = cell({ capability: capabilityKey, role: 2, selector: { _tag: 'assigned' } });
    const authority: AuthoritySpec = { cells: [usable, sibling] };
    const check = { indeterminateGrants: [sibling.grantIncarnationId] };
    const assignedPolicy = policy({ selectors: ['assigned'] });
    const siblingRecords: readonly RecordRow[] = [
      { assigned: principalHolder(), recordKey: 'record-1' },
      { assigned: principalHolder(otherPerson), recordKey: 'record-2' },
    ];
    const { resolution } = yield* resolve({
      authority,
      check,
      records: siblingRecords,
      request: { capability: assignedPolicy, mode: 'run' },
    });
    // One side resolved through the cell whose caveat could be evaluated, so the list is decided.
    expect(resolution.decision.outcome).toBe('ALLOWED');
    expect(conditionKinds(resolution.predicate)).toEqual(['assigned']);
    yield* expectListEqualsPerRecord(
      [
        row({ assigned: principalHolder(), recordKey: 'record-1' }),
        row({ assigned: principalHolder(otherPerson), recordKey: 'record-2' }),
      ],
      {
        authority,
        check,
        predicate: resolution.predicate,
        records: siblingRecords,
        request: { capability: assignedPolicy, mode: 'run' },
      },
    );
  }),
);

it.effect('fails closed and returns no rows when a side cannot be evaluated at all', () =>
  Effect.gen(function* conditionalOnlySideFailsClosed() {
    const authority: AuthoritySpec = {
      cells: [cell({ capability: capabilityKey, selector: { _tag: 'assigned' } })],
    };
    const { resolution } = yield* resolve({
      authority,
      check: { indeterminate: true },
      request: { capability: policy({ selectors: ['assigned'] }), mode: 'run' },
    });
    expect(resolution.decision.outcome).toBe('DENIED');
    expect(resolution.decision.reasons.map(({ code }) => code)).toContain('deny.caveat_indeterminate');
    expect(resolution.predicate).toBeUndefined();
  }),
);

it.effect('drops an empty team cell beside a scope-wide cell instead of narrowing to it', () =>
  Effect.gen(function* emptyTeamBesideScopeWideCell() {
    const authority: AuthoritySpec = {
      cells: [
        cell({ capability: capabilityKey, selector: { _tag: 'all' } }),
        cell({ capability: capabilityKey, selector: { _tag: 'team' } }),
      ],
      teamMembers: new Map([[holderId(principalHolder()), []]]),
    };
    const scopeWidePolicy = policy({ selectors: ['team', 'all'] });
    const { resolution } = yield* resolve({ authority, request: { capability: scopeWidePolicy, mode: 'run' } });
    // The `all` cell reaches the whole scope, so the empty team cell adds nothing and removes nothing.
    expect(resolution.decision.outcome).toBe('ALLOWED');
    expect(resolution.predicate).toEqual({ groups: [] });
    expect(resolution.decision.evidence.map(({ selector }) => selector)).toEqual(['all']);
  }),
);

it.effect('returns UNAVAILABLE and no predicate when the engine is down', () =>
  Effect.gen(function* returnsUnavailableForList() {
    const authoritySpec: AuthoritySpec = { cells: [cell({ capability: capabilityKey })] };
    const authority = makeAuthority(authoritySpec);
    const check = makeCheck({ authority: authoritySpec, failure: true });
    const resolution = yield* resolveListAccess(authority.port, check.port, {
      actor: human,
      capability: policy({ selectors: [] }),
      mode: 'run',
      now,
    });
    expect(resolution.decision.outcome).toBe('UNAVAILABLE');
    expect(resolution.predicate).toBeUndefined();
  }),
);

/*
 * A subject inspection asks many LISTs at once. Answered together they read every cell set once and ask the engine
 * once, and each LIST's answer is exactly the one it gets alone: its decision, evidence and predicate.
 */
const READ_KEY = 'finance.invoice.read';
const EXPORT_KEY = 'finance.invoice.export';
const NOTHING_KEY = 'finance.invoice.archive';
const bot: ActorContextInput = {
  actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision: 1, principalId: person },
  tenantId: tenant,
};
const manyAuthority: AuthoritySpec = {
  cells: [
    cell({ capability: capabilityKey, selector: { _tag: 'assigned' } }),
    cell({ capability: READ_KEY, selector: { _tag: 'team' } }),
    cell({ capability: READ_KEY, holder: agentHolder(), selector: { _tag: 'all' } }),
    cell({ capability: EXPORT_KEY, selector: { _tag: 'targets', recordKeys: [record(1), record(2)] } }),
    cell({ capability: capabilityKey, mode: 'propose', selector: { _tag: 'all' } }),
  ],
  connection: connect({
    ceiling: { cells: [{ capabilityKey: capability(READ_KEY), mode: 'run', selector: { _tag: 'all' } }] },
  }),
  teamMembers: new Map([[holderId(principalHolder()), [teamOne]]]),
};
const manyInputs = [
  { actor: human, capability: policy({ selectors: ['assigned'] }), mode: 'run' as const },
  {
    actor: human,
    capability: policy({ capabilityKey: capability(READ_KEY), selectors: ['team'] }),
    mode: 'run' as const,
  },
  {
    actor: bot,
    capability: policy({ capabilityKey: capability(READ_KEY), selectors: ['team'] }),
    mode: 'run' as const,
  },
  { actor: human, capability: policy({ capabilityKey: capability(EXPORT_KEY), selectors: [] }), mode: 'run' as const },
  { actor: human, capability: policy({ capabilityKey: capability(NOTHING_KEY), selectors: [] }), mode: 'run' as const },
  { actor: human, capability: policy({ selectors: ['assigned'] }), mode: 'propose' as const },
  { actor: human, capability: policy({ modes: ['run'], selectors: ['assigned'] }), mode: 'approve' as const },
].map((input) => ({ ...input, now }));

for (const variant of [
  { batchReads: false, check: {} },
  { batchReads: true, check: {} },
  { batchReads: true, check: { failure: true } },
  { batchReads: true, check: { indeterminate: true } },
  { batchReads: true, check: { missingResults: 1 } },
] as const) {
  it.effect(
    `answers many LISTs together exactly as each alone, from one read and one snapshot (${JSON.stringify(variant)})`,
    () =>
      Effect.gen(function* listMany() {
        const spec = { ...manyAuthority, batchReads: variant.batchReads };
        const alone = yield* Effect.forEach(
          manyInputs,
          (input) =>
            resolveListAccess(makeAuthority(spec).port, makeCheck({ authority: spec, ...variant.check }).port, input),
          { concurrency: 1 },
        );
        const authority = makeAuthority(spec);
        const check = makeCheck({ authority: spec, ...variant.check });
        const together = yield* resolveListAccessMany(authority.port, check.port, manyInputs);
        expect(together).toEqual(alone);
        // The plain variants mix allowed, approval and denied LISTs; the engine variants fail or narrow every one.
        expect(new Set(alone.map(({ decision }) => decision.outcome)).size).toBeGreaterThan(
          Object.keys(variant.check).length === 0 ? 1 : 0,
        );
        expect(check.calls.checkBulk).toBe(1);
        expect(variant.batchReads ? authority.calls.readCellsMany : 0).toBe(variant.batchReads ? 1 : 0);
      }),
  );
}

/** The port, except that the export capability's cells cannot be read. */
const failing = (port: ReturnType<typeof makeAuthority>['port']) => ({
  ...port,
  readCells: (query: Parameters<typeof port.readCells>[0]) =>
    query.capabilityKey === capability(EXPORT_KEY)
      ? Effect.fail(accessDecisionUnavailable('export cells unreadable'))
      : port.readCells(query),
});

it.effect('leaves only the LIST whose cell set cannot be read UNAVAILABLE among many', () =>
  Effect.gen(function* listManyUnreadable() {
    const alone = yield* Effect.forEach(
      manyInputs,
      (input) =>
        resolveListAccess(
          failing(makeAuthority(manyAuthority).port),
          makeCheck({ authority: manyAuthority }).port,
          input,
        ),
      { concurrency: 1 },
    );
    const together = yield* resolveListAccessMany(
      failing(makeAuthority(manyAuthority).port),
      makeCheck({ authority: manyAuthority }).port,
      manyInputs,
    );
    expect(together).toEqual(alone);
    expect(together[3]?.decision.outcome).toBe('UNAVAILABLE');
    expect(together[0]?.decision.outcome).not.toBe('UNAVAILABLE');
  }),
);
