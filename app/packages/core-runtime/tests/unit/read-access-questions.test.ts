import { DateTime, Effect, Option, Predicate, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { AccessDecision } from '../../src/access/decision/contract.ts';
import type { ListAccessResolution } from '../../src/access/decision/engine.ts';
import type { ListAccessPredicate } from '../../src/access/decision/list-access.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import type { GateCarrier, GateInput, ListGateInput } from '../../src/access/enforcement/contract.ts';
import type { DecisionOutcome } from '../../src/access/model.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  AccessDeclarationSchema,
  AccessFieldGroupSchema,
  AccessWorkloadSchema,
} from '../../src/authorization/access-declaration.ts';
import type { AccessDeclarationInput, AccessFieldGroupInput } from '../../src/authorization/access-declaration.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import {
  answerAccessQuestions,
  MAX_ACCESS_QUESTIONS,
  materializeAccessQuestions,
} from '../../src/reads/access-questions.ts';
import { canList, canRun, canSeeFields } from '../../src/sdk/read.ts';
import type { AccessQuestions, AccessQuestionTarget } from '../../src/sdk/read.ts';

/**
 * The access lane of the execution kernel: extra access questions are descriptor data, refused at
 * definition when they cannot be asked, and answered by Core with the gate after the read's own
 * decision allowed it, in the same scope, at the same `now` and in the same transaction.
 */

const MODULE = 'facility.operations';
const OWN_READ_KEY = `${MODULE}.overview.read`;
const RECORDS_READ_KEY = `${MODULE}.records.read`;
const APPLY_KEY = `${MODULE}.command.apply`;
const ASSIGN_KEY = `${MODULE}.owner.assign`;
const RESTRICTED_KEY = `${MODULE}.records.restricted`;

const scope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000007',
    authContextRef: 'better-auth-session:read-access-questions',
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-000000000002',
  }),
  correlationId: 'correlation-access-questions',
});
const now = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-11-18T09:00:00.000Z')));
/** The read's own owned transaction; the gate double only compares its identity. */
const ownedTransaction: CoreTransaction = Object.create(null);

const declaration = (key: string, overrides: Partial<AccessDeclarationInput> = {}) =>
  Schema.decodeSync(AccessDeclarationSchema)({
    key,
    kind: 'read',
    modes: ['run'],
    placement: { group: 'facility', level: 'basic' },
    risk: 'routine',
    selectors: [],
    ...overrides,
  });

const restrictedGroup = (overrides: Partial<AccessFieldGroupInput> = {}) =>
  Schema.decodeSync(AccessFieldGroupSchema)({
    fieldClass: 'restricted_notes',
    fields: ['restrictedNote'],
    key: RESTRICTED_KEY,
    kind: 'field_read',
    modes: ['run'],
    placement: { group: 'facility', level: 'extended' },
    risk: 'sensitive',
    ...overrides,
    selectors: [],
  });

const target = (
  entrypointKey: string,
  fields: Partial<Omit<AccessQuestionTarget['descriptor'], 'entrypoint' | 'legalEntityScope' | 'schemaVersion'>>,
  moduleKey: string = MODULE,
): AccessQuestionTarget => {
  // A registration's entrypoint descriptor, which names the module that owns it.
  const entrypoint = { entrypointKey, moduleKey };
  return {
    descriptor: {
      ...fields,
      entrypoint,
      legalEntityScope: 'required',
      schemaVersion: '1',
    },
  };
};

const recordsRead = target(`${MODULE}.api.records`, {
  accessDeclaration: declaration(RECORDS_READ_KEY),
  accessFieldGroups: [restrictedGroup()],
});
const applyAction = target(`${MODULE}.action.apply`, {
  accessDeclaration: declaration(APPLY_KEY, { kind: 'action', modes: ['run'] }),
});
const assignAction = target(`${MODULE}.action.assign`, {
  accessDeclaration: declaration(ASSIGN_KEY, { kind: 'action', modes: ['run'] }),
});
const ownReadTarget = target(`${MODULE}.api.overview`, { accessDeclaration: declaration(OWN_READ_KEY) });

const ownCarrierOf = (questionTarget: AccessQuestionTarget): GateCarrier =>
  withOptional(
    {
      entrypoint: questionTarget.descriptor.entrypoint,
      schemaVersion: questionTarget.descriptor.schemaVersion,
    },
    'accessDeclaration',
    questionTarget.descriptor.accessDeclaration,
  );
const ownRead = {
  accessKind: 'detail',
  carrier: ownCarrierOf(ownReadTarget),
  legalEntityScope: 'required',
  moduleKey: MODULE,
} as const;

const decisionOf = (outcome: DecisionOutcome): AccessDecision => ({
  evidence: [],
  outcome,
  reasons: [{ code: outcome === 'ALLOWED' ? 'allow.granted' : 'deny.insufficient_grant' }],
  selectors: [],
});
const ALLOWED = decisionOf('ALLOWED');
const allRows: ListAccessPredicate = { groups: [] };

/** The key a gate input is about: the field group or declaration of its carrier, or its workload. */
const keyOf = (carrier: GateCarrier): string =>
  carrier.accessDeclaration?.key ?? carrier.entrypoint?.entrypointKey ?? 'unknown';

interface GateCall {
  readonly input: GateInput | ListGateInput | readonly GateInput[];
  readonly method: 'decide' | 'decideMany' | 'list';
  readonly transaction: CoreTransaction | undefined;
}

/** A recording gate double: scripted outcomes by key, every call and its transaction kept. */
const recordingGate = (script: {
  readonly batch?: boolean;
  readonly decisions?: Readonly<Record<string, DecisionOutcome>>;
  readonly lists?: Readonly<Record<string, ListAccessResolution>>;
}) => {
  const calls: GateCall[] = [];
  const decideOne = (input: GateInput) => decisionOf(script.decisions?.[keyOf(input.carrier)] ?? 'DENIED');
  const base = {
    decide: (input: GateInput, transaction?: CoreTransaction) =>
      Effect.sync(() => {
        calls.push({ input, method: 'decide', transaction });
        return decideOne(input);
      }),
    list: (input: ListGateInput, transaction?: CoreTransaction) =>
      Effect.sync(() => {
        calls.push({ input, method: 'list', transaction });
        return script.lists?.[keyOf(input.carrier)] ?? { decision: decisionOf('DENIED') };
      }),
    selectableLegalEntities: () => Effect.succeed([]),
  };
  const gate: BoundAccessGate =
    script.batch === false
      ? base
      : {
          ...base,
          decideMany: (inputs: readonly GateInput[], transaction?: CoreTransaction) =>
            Effect.sync(() => {
              calls.push({ input: inputs, method: 'decideMany', transaction });
              return inputs.map(decideOne);
            }),
        };
  return { calls, gate };
};

const answer = <Questions extends AccessQuestions>(input: {
  /** Absent: a composition without the access gate. */
  readonly gate?: BoundAccessGate;
  readonly own?: AccessDecision;
  readonly ownListAccess?: ListAccessPredicate;
  readonly questions: Questions;
  readonly read?: Parameters<typeof materializeAccessQuestions>[0];
  readonly transaction?: CoreTransaction;
}) =>
  answerAccessQuestions<Questions>(
    withOptional(
      {
        gate: input.gate,
        now,
        own: withOptional({ decision: input.own ?? ALLOWED }, 'listAccess', input.ownListAccess),
        questions: materializeAccessQuestions(input.read ?? ownRead, input.questions),
        scope,
      },
      'transaction',
      input.transaction,
    ),
  );

const refusal = (questions: AccessQuestions, read = ownRead): string => {
  try {
    materializeAccessQuestions(read, questions);
  } catch (error) {
    return String(Predicate.hasProperty(error, 'message') ? error.message : error);
  }
  return 'accepted';
};

const manyQuestions = (count: number): AccessQuestions =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${index}`, canRun(applyAction)]));

describe('materializeAccessQuestions', () => {
  it('turns every question into the gate question it asks', () => {
    const [assign, restricted, rows] = materializeAccessQuestions(ownRead, {
      assign: canRun(assignAction),
      restricted: canSeeFields(recordsRead, RESTRICTED_KEY),
      rows: canList(recordsRead),
    });
    expect(assign).toMatchObject({
      carrier: {
        accessDeclaration: { key: ASSIGN_KEY },
        entrypoint: { entrypointKey: `${MODULE}.action.assign` },
        schemaVersion: '1',
      },
      kind: 'decide',
      legalEntityScope: 'required',
      name: 'assign',
      sameAsOwnDecision: false,
    });
    expect(assign?.parentRead).toBeUndefined();
    expect(restricted).toMatchObject({
      carrier: { accessDeclaration: { key: RESTRICTED_KEY, kind: 'field_read' } },
      kind: 'field',
      parentRead: { capability: { capabilityKey: RECORDS_READ_KEY, selectors: [] } },
      sameAsOwnDecision: false,
    });
    expect(rows).toMatchObject({ carrier: { accessDeclaration: { key: RECORDS_READ_KEY } }, kind: 'list' });
    expect(Object.isFrozen(assign)).toBe(true);
  });

  it('keeps a workload-only target and its marker in the carrier', () => {
    const workloadTarget = target(`${MODULE}.action.sync`, {
      accessWorkload: Schema.decodeSync(AccessWorkloadSchema)({
        reason: 'Nightly facility sync',
        workloads: [`${MODULE}.sync`],
      }),
    });
    const [question] = materializeAccessQuestions(ownRead, { sync: canRun(workloadTarget) });
    expect(question?.carrier.accessWorkload).toEqual(workloadTarget.descriptor.accessWorkload);
  });

  it('marks a question about the read itself as answered by its own decision', () => {
    const own = materializeAccessQuestions(ownRead, { other: canRun(applyAction), self: canRun(ownReadTarget) });
    expect(own.map((question) => question.sameAsOwnDecision)).toEqual([false, true]);
    // A detail read's own decision holds no row predicate, so listing itself is still asked.
    const [listSelf] = materializeAccessQuestions(ownRead, { rows: canList(ownReadTarget) });
    expect(listSelf?.sameAsOwnDecision).toBe(false);
    const [listOwnList] = materializeAccessQuestions(
      { ...ownRead, accessKind: 'list' },
      { rows: canList(ownReadTarget) },
    );
    expect(listOwnList?.sameAsOwnDecision).toBe(true);
  });

  it('asks the gate about the same carrier under another legal-entity scope', () => {
    const otherScope: AccessQuestionTarget = {
      descriptor: { ...ownReadTarget.descriptor, legalEntityScope: 'optional' },
    };
    const [question] = materializeAccessQuestions(ownRead, { self: canRun(otherScope) });
    expect(question).toMatchObject({ legalEntityScope: 'optional', sameAsOwnDecision: false });
  });

  it("refuses a question about another module's operation", () => {
    const foreign = target(
      'billing.invoices.api.records',
      { accessDeclaration: declaration(RECORDS_READ_KEY) },
      'billing.invoices',
    );
    expect(refusal({ foreign: canRun(foreign) })).toContain("not to the asking read's module facility.operations");
    expect(refusal({ foreign: canList(foreign) })).toContain('belongs to billing.invoices');
    // An empty record is what its type allows: it asks nothing.
    expect(materializeAccessQuestions(ownRead, {})).toStrictEqual([]);
  });

  it('refuses a target without a protected carrier', () => {
    expect(refusal({ open: canRun(target(`${MODULE}.api.open`, {})) })).toContain('no protected access carrier');
  });

  it('refuses can_run on a record-scoped declaration', () => {
    const scoped = target(`${MODULE}.action.edit`, {
      accessDeclaration: declaration(`${MODULE}.record.edit`, { kind: 'action', selectors: ['assigned'] }),
    });
    expect(refusal({ edit: canRun(scoped) })).toContain('record-scoped; ask can_list');
    expect(refusal({ edit: canList(scoped) })).toBe('accepted');
  });

  it('refuses a field group the target does not declare', () => {
    expect(refusal({ secret: canSeeFields(recordsRead, `${MODULE}.records.secret`) })).toContain(
      'declares no field group',
    );
    expect(refusal({ secret: canSeeFields(applyAction, RESTRICTED_KEY) })).toContain('declares no field group');
  });

  it('refuses more than 16 questions', () => {
    expect(refusal(manyQuestions(MAX_ACCESS_QUESTIONS))).toBe('accepted');
    expect(refusal(manyQuestions(MAX_ACCESS_QUESTIONS + 1))).toContain('at most 16');
  });

  it('gives a field capability run as an operation its own parent read', () => {
    const fieldAction = target(`${MODULE}.action.reassign`, {
      accessDeclaration: declaration(`${MODULE}.owner.reassign`, {
        fieldClass: 'owner_assignment',
        kind: 'field_write',
        modes: ['run'],
      }),
    });
    const [question] = materializeAccessQuestions(ownRead, { reassign: canRun(fieldAction) });
    expect(question?.parentRead?.capability.capabilityKey).toBe(`${MODULE}.owner.reassign`);
  });
});

describe('answerAccessQuestions', () => {
  it.effect('answers a question about the read itself from its own decision, without a gate call', () =>
    Effect.gen(function* accessQuestionCase() {
      const { calls, gate } = recordingGate({});
      const answers = yield* answer({ gate, questions: { self: canRun(ownReadTarget) } });
      expect(answers.self).toBe('allowed');
      const listed = yield* answer({
        gate,
        ownListAccess: allRows,
        questions: { rows: canList(ownReadTarget) },
        read: { ...ownRead, accessKind: 'list' },
      });
      expect(listed.rows).toEqual(Result.succeed(Option.some(allRows)));
      expect(calls).toEqual([]);
    }),
  );

  it.effect('asks every decision in one batch and lists separately, with the same now and scope', () =>
    Effect.gen(function* accessQuestionCase() {
      const { calls, gate } = recordingGate({
        decisions: { [APPLY_KEY]: 'ALLOWED', [ASSIGN_KEY]: 'DENIED', [RESTRICTED_KEY]: 'ALLOWED' },
        lists: { [RECORDS_READ_KEY]: { decision: ALLOWED, predicate: allRows } },
      });
      const answers = yield* answer({
        gate,
        questions: {
          assign: canRun(assignAction),
          restricted: canSeeFields(recordsRead, RESTRICTED_KEY),
          rows: canList(recordsRead),
          write: canRun(applyAction),
        },
      });
      expect(answers).toEqual({
        assign: 'denied',
        restricted: 'allowed',
        rows: Result.succeed(Option.some(allRows)),
        write: 'allowed',
      });
      expect(calls.map((call) => call.method)).toEqual(['decideMany', 'list']);
      const [batch, listing] = calls;
      const batched: readonly GateInput[] = Array.isArray(batch?.input) ? batch.input : [];
      expect(batched.map((input) => keyOf(input.carrier))).toEqual([ASSIGN_KEY, RESTRICTED_KEY, APPLY_KEY]);
      for (const input of [...batched, listing?.input]) {
        expect(input).toMatchObject({ legalEntityScope: 'required', now, scope });
      }
      // The field question rides its target's own capability, decided scope-wide.
      expect(batched[1]?.parentRead).toEqual({
        capability: expect.objectContaining({ capabilityKey: RECORDS_READ_KEY, selectors: [] }),
      });
      expect(batched[0]?.parentRead).toBeUndefined();
    }),
  );

  it.effect('asks one by one when the gate has no batch', () =>
    Effect.gen(function* accessQuestionCase() {
      const { calls, gate } = recordingGate({ batch: false, decisions: { [APPLY_KEY]: 'ALLOWED' } });
      const answers = yield* answer({
        gate,
        questions: { assign: canRun(assignAction), write: canRun(applyAction) },
      });
      expect(answers).toEqual({ assign: 'denied', write: 'allowed' });
      expect(calls.map((call) => call.method)).toEqual(['decide', 'decide']);
    }),
  );

  it.effect('maps every outcome of a run question', () =>
    Effect.gen(function* accessQuestionCase() {
      const outcomes: readonly DecisionOutcome[] = ['ALLOWED', 'DENIED', 'NEEDS_APPROVAL', 'UNAVAILABLE'];
      const answers = yield* Effect.all(
        outcomes.map((outcome) =>
          answer({
            gate: recordingGate({ decisions: { [APPLY_KEY]: outcome } }).gate,
            questions: { write: canRun(applyAction) },
          }),
        ),
      );
      expect(answers.map(({ write }) => write)).toEqual(['allowed', 'denied', 'needs_approval', 'unavailable']);
    }),
  );

  it.effect('maps every outcome of a field question; a proposable field is denied', () =>
    Effect.gen(function* accessQuestionCase() {
      const outcomes: readonly DecisionOutcome[] = ['ALLOWED', 'DENIED', 'NEEDS_APPROVAL', 'UNAVAILABLE'];
      const answers = yield* Effect.all(
        outcomes.map((outcome) =>
          answer({
            gate: recordingGate({ decisions: { [RESTRICTED_KEY]: outcome } }).gate,
            questions: { restricted: canSeeFields(recordsRead, RESTRICTED_KEY) },
          }),
        ),
      );
      expect(answers.map(({ restricted }) => restricted)).toEqual(['allowed', 'denied', 'denied', 'unavailable']);
    }),
  );

  it.effect('maps every list answer; no predicate is no row, never every row', () =>
    Effect.gen(function* accessQuestionCase() {
      const listings: readonly ListAccessResolution[] = [
        { decision: ALLOWED, predicate: allRows },
        { decision: ALLOWED },
        { decision: decisionOf('DENIED') },
        { decision: decisionOf('NEEDS_APPROVAL'), predicate: allRows },
        { decision: decisionOf('UNAVAILABLE') },
      ];
      const answers = yield* Effect.all(
        listings.map((listing) =>
          answer({
            gate: recordingGate({ lists: { [RECORDS_READ_KEY]: listing } }).gate,
            questions: { rows: canList(recordsRead) },
          }),
        ),
      );
      expect(answers.map(({ rows }) => rows)).toEqual([
        Result.succeed(Option.some(allRows)),
        Result.succeed(Option.none()),
        Result.succeed(Option.none()),
        Result.succeed(Option.none()),
        Result.fail('unavailable'),
      ]);
    }),
  );

  it.effect('answers a batch that lost an answer as unavailable for that question', () =>
    Effect.gen(function* accessQuestionCase() {
      const { gate } = recordingGate({ decisions: { [APPLY_KEY]: 'ALLOWED' } });
      const short: BoundAccessGate = { ...gate, decideMany: () => Effect.succeed([ALLOWED]) };
      const answers = yield* answer({
        gate: short,
        questions: { assign: canRun(assignAction), write: canRun(applyAction) },
      });
      expect(answers).toEqual({ assign: 'allowed', write: 'unavailable' });
    }),
  );

  it.effect('answers every question unavailable when the composition has no gate', () =>
    Effect.gen(function* accessQuestionCase() {
      const answers = yield* answer({
        questions: {
          restricted: canSeeFields(recordsRead, RESTRICTED_KEY),
          rows: canList(recordsRead),
          self: canRun(ownReadTarget),
          write: canRun(applyAction),
        },
      });
      expect(answers).toEqual({
        restricted: 'unavailable',
        rows: Result.fail('unavailable'),
        self: 'unavailable',
        write: 'unavailable',
      });
    }),
  );

  it.effect('passes the given transaction to decide, decideMany and list, and none when absent', () =>
    Effect.gen(function* accessQuestionCase() {
      const questions = { rows: canList(recordsRead), write: canRun(applyAction) };
      const batched = recordingGate({});
      yield* answer({ gate: batched.gate, questions, transaction: ownedTransaction });
      const sequential = recordingGate({ batch: false });
      yield* answer({ gate: sequential.gate, questions, transaction: ownedTransaction });
      const calls = [...batched.calls, ...sequential.calls];
      expect(calls.map((call) => call.method)).toEqual(['decideMany', 'list', 'decide', 'list']);
      expect(calls.every((call) => call.transaction === ownedTransaction)).toBe(true);
      const runForm = recordingGate({});
      yield* answer({ gate: runForm.gate, questions });
      expect(runForm.calls.map((call) => call.transaction)).toEqual([undefined, undefined]);
    }),
  );

  it.effect('asks nothing when the read itself was not allowed', () =>
    Effect.gen(function* accessQuestionCase() {
      const { calls, gate } = recordingGate({ decisions: { [APPLY_KEY]: 'ALLOWED' } });
      for (const outcome of ['DENIED', 'NEEDS_APPROVAL', 'UNAVAILABLE'] as const) {
        const answers = yield* answer({
          gate,
          own: decisionOf(outcome),
          questions: { rows: canList(recordsRead), self: canRun(ownReadTarget), write: canRun(applyAction) },
        });
        expect(answers).toEqual({ rows: Result.fail('unavailable'), self: 'unavailable', write: 'unavailable' });
      }
      expect(calls).toEqual([]);
    }),
  );
});
