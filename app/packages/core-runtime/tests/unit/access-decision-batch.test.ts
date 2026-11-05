import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ActorContextInput, DecisionAuthorityPort } from '../../src/access/decision/authority.ts';
import type { AccessDecision, DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import { decideAccess, decideAccessMany } from '../../src/access/decision/engine.ts';
import type { DecisionInput } from '../../src/access/decision/engine.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { ModuleKeySchema } from '../../src/access/ids.ts';
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
  recordTarget,
  team,
  tenant,
} from './access-decision-support.ts';
import type { AuthoritySpec, CheckSpec } from './access-decision-support.ts';

/*
 * The batch path exists for one reason: a navigation page asks the gate about dozens of
 * declarations at once, and one engine call per declaration is a latency bug (CUTOVER-PLAN §5.3
 * risk 6). This suite is the proof that sharing the intent reads and the snapshot changed nothing:
 * every request is answered exactly as `decideAccess` answers it alone, over a table that covers
 * people, agents, selectors, amounts, deadlines, parent reads and unavailable engine items, and
 * over a deterministic pseudo-random sample of the same space.
 */

const now = at('2026-11-03T12:00:00Z');
const VOID = 'finance.invoice.void';
const EXPORT = 'finance.invoice.export';
const PAY = 'finance.invoice.pay';
const READ = 'finance.invoice.read';
const TEAM_SCOPED = 'party.registry.contact.read';
const EXPIRED = 'finance.invoice.archive';
const APPROVE_ONLY = 'finance.invoice.reimburse';
const OTHER_MODULE = ModuleKeySchema.make('commerce.catalog');

const policy = (key: string, overrides: Partial<DecisionCapabilityPolicy> = {}): DecisionCapabilityPolicy => ({
  capabilityKey: capability(key),
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  risk: 'routine',
  selectors: [],
  ...overrides,
});

const human: ActorContextInput = { actor: { _tag: 'Principal', principalId: person }, tenantId: tenant };
const bot: ActorContextInput = {
  actor: { _tag: 'Agent', agentId: agent, connectionId, consentRevision: 1, principalId: person },
  tenantId: tenant,
};

const voidCell = cell({ capability: VOID });
const readCell = cell({ capability: READ });

/** Every kind of authority one tenant scope can hold for these capabilities. */
const cells: AuthoritySpec['cells'] = [
  voidCell,
  cell({ capability: VOID, selector: { _tag: 'assigned' } }),
  cell({ capability: VOID, mode: 'propose' }),
  cell({ capability: VOID, holder: agentHolder(), mode: 'propose' }),
  cell({ capability: EXPORT, selector: { _tag: 'targets', recordKeys: [record(1), record(2)] } }),
  cell({ amountCeiling: { currency: 'CZK', limitMinor: 1000 }, capability: PAY }),
  readCell,
  cell({ capability: READ, holder: agentHolder() }),
  cell({ capability: TEAM_SCOPED, selector: { _tag: 'team' } }),
  cell({ capability: EXPIRED, deadline: at('2026-10-01T00:00:00Z') }),
  // Only a proposal path exists: a human running it gets an approval request, never a run.
  cell({ capability: APPROVE_ONLY, mode: 'propose' }),
];

const records = [
  { assigned: principalHolder(), recordKey: 'record-1' },
  { assigned: principalHolder(otherPerson), recordKey: 'record-2' },
  { recordKey: 'record-3' },
  { assigned: principalHolder(), recordKey: 'record-4', teamIds: [team(1)] },
  { recordKey: 'record-5', teamIds: [team(2)] },
];

const authoritySpec: AuthoritySpec = {
  cells,
  connection: connect({
    ceiling: { cells: [{ capabilityKey: capability(READ), mode: 'run', selector: { _tag: 'all' } }] },
  }),
  teamMembers: new Map([[holderId(principalHolder()), [team(1)]]]),
};

const checkOverrides: Omit<CheckSpec, 'authority'> = { records };

interface RequestCase {
  readonly actor?: ActorContextInput;
  readonly request: DecisionInput['request'];
}

/** A table of one scope's real questions: every selector, amount, deadline and tier. */
const table: readonly RequestCase[] = [
  { request: { capability: policy(VOID), mode: 'run' } },
  { request: { capability: policy(VOID, { selectors: ['assigned'] }), mode: 'run', target: recordTarget(1) } },
  { request: { capability: policy(VOID, { selectors: ['assigned'] }), mode: 'run', target: recordTarget(2) } },
  { request: { capability: policy(VOID, { selectors: ['assigned'] }), mode: 'run', target: recordTarget(3) } },
  { request: { capability: policy(VOID, { selectors: ['assigned'] }), mode: 'run' } },
  {
    request: {
      capability: policy(VOID, { selectors: ['assigned'] }),
      mode: 'run',
      target: { moduleKey: OTHER_MODULE, recordKey: record(1) },
    },
  },
  { request: { capability: policy(EXPORT, { selectors: ['all'] }), mode: 'run', target: recordTarget(1) } },
  { request: { capability: policy(EXPORT, { selectors: ['all'] }), mode: 'run', target: recordTarget(9) } },
  { request: { amount: amount(1000), capability: policy(PAY), mode: 'run' } },
  { request: { amount: amount(1001), capability: policy(PAY), mode: 'run' } },
  { request: { capability: policy(PAY), mode: 'run' } },
  { request: { capability: policy(EXPIRED), mode: 'run' } },
  {
    request: {
      capability: policy(TEAM_SCOPED, { kind: 'read', modes: ['run'], selectors: ['team'] }),
      mode: 'run',
      target: recordTarget(4),
    },
  },
  {
    request: {
      capability: policy(TEAM_SCOPED, { kind: 'read', modes: ['run'], selectors: ['team'] }),
      mode: 'run',
      target: recordTarget(5),
    },
  },
  { request: { capability: policy(VOID, { risk: 'sensitive' }), mode: 'run' } },
  { request: { capability: policy(APPROVE_ONLY, { risk: 'sensitive' }), mode: 'run' } },
  { request: { capability: policy(VOID, { modes: ['propose'] }), mode: 'run' } },
  { request: { capability: policy(VOID, { modes: ['approve'] }), mode: 'run' } },
  { request: { capability: policy('finance.invoice.unknown'), mode: 'run' } },
  {
    request: {
      capability: policy(VOID, { fieldClass: 'margins', kind: 'field_read', risk: 'sensitive' }),
      mode: 'run',
      parentRead: { capability: policy(READ, { kind: 'read', modes: ['run'] }), target: recordTarget(1) },
      target: recordTarget(1),
    },
  },
  {
    request: {
      capability: policy(VOID, { fieldClass: 'margins', kind: 'field_read', risk: 'sensitive' }),
      mode: 'run',
      target: recordTarget(1),
    },
  },
  { request: { capability: policy(VOID, { kind: 'admin', risk: 'critical' }), mode: 'run' } },
];

/** The same scope asked by an agent: both sides' cells, the connection ceiling and the tiers. */
const agentTable: readonly RequestCase[] = [
  { actor: bot, request: { capability: policy(READ, { kind: 'read', modes: ['run'] }), mode: 'run' } },
  {
    actor: bot,
    request: { capability: policy(READ, { kind: 'read', modes: ['run'], risk: 'sensitive' }), mode: 'run' },
  },
  { actor: bot, request: { capability: policy(VOID, { risk: 'sensitive' }), mode: 'run' } },
  { actor: bot, request: { capability: policy(VOID, { kind: 'admin', risk: 'critical' }), mode: 'run' } },
  { actor: bot, request: { capability: policy(READ, { kind: 'read', modes: ['run'] }), mode: 'approve' } },
  { actor: bot, request: { capability: policy(EXPORT, { selectors: ['all'] }), mode: 'run', target: recordTarget(1) } },
  {
    actor: bot,
    request: { capability: policy(VOID, { selectors: ['assigned'] }), mode: 'run', target: recordTarget(1) },
  },
];

const inputsOf = (cases: readonly RequestCase[]): readonly DecisionInput[] =>
  cases.map((one) => ({ actor: one.actor ?? human, now, request: one.request }));

/**
 * One request at a time through `decideAccess`, then the whole table through one batch. The batch
 * must answer each request identically, from exactly one snapshot over the sum of their items.
 */
const compareTable = (cases: readonly RequestCase[], spec: AuthoritySpec = authoritySpec) =>
  Effect.gen(function* comparesTableWithOneSnapshot() {
    const authority = makeAuthority(spec);
    const alone: AccessDecision[] = [];
    let items = 0;
    for (const input of inputsOf(cases)) {
      const single = makeCheck({ authority: spec, ...checkOverrides });
      alone.push(yield* decideAccess(authority.port, single.port, input));
      items += single.calls.items;
    }
    const batched = makeCheck({ authority: spec, ...checkOverrides });
    const answers = yield* decideAccessMany(batched.port, [{ authority: authority.port, inputs: inputsOf(cases) }]);
    // One snapshot for the whole table, and none at all when no request reached the engine.
    expect(batched.calls.checkBulk).toBe(items === 0 ? 0 : 1);
    expect(batched.calls.items).toBe(items);
    expect(answers.length).toBe(1);
    expect(answers[0]).toEqual(alone);
    return { alone, batched };
  });

it.effect('answers a whole table of human requests exactly as one decision at a time, from one snapshot', () =>
  Effect.gen(function* answersHumanTable() {
    const { alone } = yield* compareTable(table);
    // The table is not vacuous: it contains allows, denials and an approval request.
    expect(new Set(alone.map(({ outcome }) => outcome))).toEqual(new Set(['ALLOWED', 'DENIED', 'NEEDS_APPROVAL']));
  }),
);

it.effect('answers agent requests, both sides and the connection ceiling, exactly as one decision at a time', () =>
  Effect.gen(function* answersAgentTable() {
    const { alone } = yield* compareTable(agentTable);
    expect(alone.some(({ evidence }) => evidence.some(({ side }) => side === 'agent'))).toBe(true);
    expect(alone.map(({ outcome }) => outcome)).toContain('DENIED');
  }),
);

it.effect('answers an ended agent membership exactly as one decision at a time', () =>
  compareTable(agentTable, {
    ...authoritySpec,
    agentMembershipDeadlines: [{ source: 'membership', until: at('2026-10-01T00:00:00Z') }],
  }),
);

it.effect('answers an ended connection exactly as one decision at a time', () =>
  compareTable(agentTable, {
    ...authoritySpec,
    connection: connect({
      ceiling: { cells: [{ capabilityKey: capability(READ), mode: 'run', selector: { _tag: 'all' } }] },
      deadline: at('2026-10-15T00:00:00Z'),
    }),
  }),
);

it.effect('answers an unevaluable caveat exactly as one decision at a time', () =>
  Effect.gen(function* answersIndeterminateCaveat() {
    const authority = makeAuthority(authoritySpec);
    const caveatCheck: Omit<CheckSpec, 'authority'> = {
      ...checkOverrides,
      indeterminateGrants: [readCell.grantIncarnationId],
    };
    const readPolicy = policy(READ, { kind: 'read', modes: ['run'] });
    const alone = yield* decideAccess(authority.port, makeCheck({ authority: authoritySpec, ...caveatCheck }).port, {
      actor: human,
      now,
      request: { capability: readPolicy, mode: 'run' },
    });
    expect(alone.outcome).toBe('DENIED');
    expect(alone.reasons.map(({ code }) => code)).toContain('deny.caveat_indeterminate');

    const batched = makeCheck({ authority: authoritySpec, ...caveatCheck });
    const answers = yield* decideAccessMany(batched.port, [
      {
        authority: authority.port,
        inputs: inputsOf([
          { request: { capability: policy(VOID), mode: 'run' } },
          { request: { capability: readPolicy, mode: 'run' } },
        ]),
      },
    ]);
    expect(batched.calls.checkBulk).toBe(1);
    expect(answers[0]?.[1]).toEqual(alone);
    // The unevaluable sibling never turns the readable request's answer into a denial.
    expect(answers[0]?.[0]?.outcome).toBe('ALLOWED');
  }),
);

it.effect('answers a deterministic random sample of requests exactly as one decision at a time', () =>
  Effect.gen(function* answersRandomSample() {
    let state = 20_261_103;
    const pick = (bound: number): number => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return Math.floor((state / 4_294_967_296) * bound);
    };
    const keys = [VOID, EXPORT, PAY, READ, TEAM_SCOPED, EXPIRED, 'finance.invoice.unknown'] as const;
    const modes = ['run', 'propose', 'approve'] as const;
    const selectors = [[], ['all'], ['assigned'], ['team']] as const;
    const amounts = [undefined, amount(0), amount(1000), amount(1001)] as const;
    const targets = [undefined, recordTarget(1), recordTarget(2), recordTarget(3), recordTarget(4), recordTarget(5)];
    const sample: RequestCase[] = [];
    for (let index = 0; index < 48; index += 1) {
      const key = keys[pick(keys.length)] ?? VOID;
      const requestPolicy = policy(key, {
        kind: pick(3) === 0 ? 'read' : 'action',
        modes: pick(4) === 0 ? ['propose'] : ['run', 'propose', 'approve'],
        risk: pick(3) === 0 ? 'sensitive' : 'routine',
        selectors: selectors[pick(selectors.length)] ?? [],
      });
      const mode = modes[pick(modes.length)] ?? 'run';
      const request = withOptional(
        withOptional({ capability: requestPolicy, mode }, 'amount', amounts[pick(amounts.length)]),
        'target',
        targets[pick(targets.length)],
      );
      sample.push({ actor: pick(2) === 0 ? bot : human, request });
    }
    const { alone } = yield* compareTable(sample);
    expect(alone.length).toBe(sample.length);
    expect(new Set(alone.map(({ outcome }) => outcome)).size).toBeGreaterThan(1);
  }),
);

it.effect('answers an unreadable intent of one capability as UNAVAILABLE without touching its siblings', () =>
  Effect.gen(function* answersUnreadableIntentPerRequest() {
    const authority = makeAuthority(authoritySpec);
    const failing: DecisionAuthorityPort = {
      ...authority.port,
      readCells: (query) =>
        query.capabilityKey === PAY
          ? Effect.fail(accessDecisionUnavailable('the intent of this capability is unreadable'))
          : authority.port.readCells(query),
    };
    const cases: readonly RequestCase[] = [
      { request: { capability: policy(VOID), mode: 'run' } },
      { request: { amount: amount(10), capability: policy(PAY), mode: 'run' } },
      { request: { capability: policy(VOID), mode: 'run' } },
    ];
    const alone: AccessDecision[] = [];
    for (const input of inputsOf(cases)) {
      alone.push(yield* decideAccess(failing, makeCheck({ authority: authoritySpec, ...checkOverrides }).port, input));
    }
    expect(alone.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'UNAVAILABLE', 'ALLOWED']);

    const batched = makeCheck({ authority: authoritySpec, ...checkOverrides });
    const answers = yield* decideAccessMany(batched.port, [{ authority: failing, inputs: inputsOf(cases) }]);
    // The snapshot still carries the two readable requests: an unreadable sibling never poisons it.
    expect(batched.calls.checkBulk).toBe(1);
    expect(answers[0]).toEqual(alone);
  }),
);

it.effect('answers UNAVAILABLE for the whole batch when the engine fails, never a partial allow', () =>
  Effect.gen(function* failsWholeBatchOnEngineFailure() {
    const authority = makeAuthority(authoritySpec);
    for (const failure of [{ failure: true }, { engineError: true }, { missingResults: 1 }] as const) {
      const batched = makeCheck({ authority: authoritySpec, ...checkOverrides, ...failure });
      const answers = yield* decideAccessMany(batched.port, [
        { authority: authority.port, inputs: inputsOf(table.slice(0, 3)) },
      ]);
      expect(batched.calls.checkBulk).toBe(1);
      expect(answers[0]?.map(({ outcome }) => outcome)).toEqual(['UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE']);
    }
  }),
);

it.effect('keeps the requests of two scopes in their own order and answers each from the one snapshot', () =>
  Effect.gen(function* answersTwoScopesInOrder() {
    const first = makeAuthority(authoritySpec);
    const secondSpec: AuthoritySpec = {
      ...authoritySpec,
      cells: cells.filter(({ capabilityKey }) => capabilityKey === READ),
    };
    const second = makeAuthority(secondSpec);
    const batched = makeCheck({ authority: authoritySpec, ...checkOverrides });
    const answers = yield* decideAccessMany(batched.port, [
      {
        authority: first.port,
        inputs: [
          { actor: human, now, request: { capability: policy(VOID), mode: 'run' } },
          { actor: human, now, request: { capability: policy(READ, { kind: 'read', modes: ['run'] }), mode: 'run' } },
        ],
      },
      {
        authority: second.port,
        inputs: [{ actor: human, now, request: { capability: policy(VOID), mode: 'run' } }],
      },
    ]);
    expect(batched.calls.checkBulk).toBe(1);
    expect(answers.map((group) => group.map(({ outcome }) => outcome))).toEqual([['ALLOWED', 'ALLOWED'], ['DENIED']]);
  }),
);

it.effect('asks the engine nothing for an empty batch and answers nothing', () =>
  Effect.gen(function* answersEmptyBatch() {
    const authority = makeAuthority(authoritySpec);
    const batched = makeCheck({ authority: authoritySpec });
    const answers = yield* decideAccessMany(batched.port, [{ authority: authority.port, inputs: [] }]);
    expect(answers).toEqual([[]]);
    expect(batched.calls.checkBulk).toBe(0);
    expect(yield* decideAccessMany(batched.port, [])).toEqual([]);
  }),
);

it.effect('resolves the actor and reads each cell set once for a page of requests', () =>
  Effect.gen(function* readsIntentOncePerDistinctQuestion() {
    const authority = makeAuthority(authoritySpec);
    const cases: readonly RequestCase[] = [
      { request: { capability: policy(VOID), mode: 'run' } },
      { request: { capability: policy(VOID, { risk: 'sensitive' }), mode: 'run' } },
      { request: { capability: policy(READ, { kind: 'read', modes: ['run'] }), mode: 'run' } },
    ];
    const batched = makeCheck({ authority: authoritySpec, ...checkOverrides });
    yield* decideAccessMany(batched.port, [{ authority: authority.port, inputs: inputsOf(cases) }]);
    // One membership resolution for the one actor, and one cell set per capability and mode: the
    // second request for the same capability asks nothing again.
    expect(authority.calls.readScope).toBe(1);
    expect(authority.calls.readCells).toBe(3);
    expect(authority.calls.readConnection).toBe(0);
  }),
);
