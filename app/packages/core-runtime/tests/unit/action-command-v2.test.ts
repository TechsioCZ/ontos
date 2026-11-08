import { Effect, Exit, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActionCommandV2Schema,
  actionCommandGateQuestionV2,
  actionCommandQuestionsV2,
  decodeActionCommandV2,
  freezeActionCommandV2,
  makeActionCommandV2,
  rebindActionCommandV2,
  rebindRegisteredActionCommandV2,
} from '../../src/access/approvals/action-command-v2.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import { LegalEntityIdSchema, RecordKeySchema, TenantIdSchema } from '../../src/access/ids.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import { defineAction, getRegisteredActionCommandReader } from '../../src/actions/definition.ts';
import { getVerticalRuntimeActions } from '../../src/modules/runtime-registration.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { actionFor, ownerKey, principal } from '../support/action-command-v2.ts';
import { at, cell, makeAuthority, makeCheck } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const first = RecordKeySchema.make('record-1');
const second = RecordKeySchema.make('record-2');
const payload = { ids: [second, first], salary: 25 };
const scope: OperationalScope = { ...principal, correlationId: 'forward-command' };
const action = actionFor();
const now = at('2026-11-07T01:00:00Z');

it.effect(
  'rebinds an existential owner registration through its original payload and complete target readers only',
  () =>
    Effect.gen(function* originalCommandReader() {
      const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey });
      const [registration] = getVerticalRuntimeActions(owner.ownerRegistration);
      if (registration === undefined) {
        expect.unreachable('The actual owner retains its registered Action');
      }
      const command = yield* makeActionCommandV2({ payload, registration: action, scope });
      yield* rebindRegisteredActionCommandV2({ command, registration, scope });
      expect(getRegisteredActionCommandReader(registration)?.descriptor).toBe(action.descriptor);
      const copy = { ...registration };
      expect(getRegisteredActionCommandReader(copy)).toBeUndefined();
      expect(
        Exit.isFailure(yield* Effect.exit(rebindRegisteredActionCommandV2({ command, registration: copy, scope }))),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            rebindRegisteredActionCommandV2({
              command: { ...command, fieldGroups: [] },
              registration,
              scope,
            }),
          ),
        ),
      ).toBe(true);
    }),
);

it.effect('uses the genuine schema encoder and decoder for transformed payloads without acquiring owner services', () =>
  Effect.gen(function* transformedCommandPayload() {
    const registration = defineAction(
      {
        ...action.descriptor,
        payloadSchema: Schema.Struct({ ids: Schema.Array(RecordKeySchema), salary: Schema.NumberFromString }),
      },
      () => Effect.die('Command rebinding must never run the owner handler'),
    );
    const command = yield* makeActionCommandV2({ payload: { ids: [first, second], salary: 25 }, registration, scope });
    expect(command.payload).toEqual({ ids: [first, second], salary: '25' });
    expect(command.fieldGroups.map(({ key }) => key)).toEqual([`${ownerKey}.record.write-salary`]);
    yield* rebindRegisteredActionCommandV2({ command, registration, scope });
  }),
);

const canonicalGate = (supplied: AuthoritySpec) => {
  const authoritySpec: AuthoritySpec = {
    ...supplied,
    legalEntityScope: {
      _tag: 'LegalEntity',
      legalEntityId: LegalEntityIdSchema.make(principal.legalEntityId ?? ''),
      tenantId: TenantIdSchema.make(principal.tenantId),
    },
  };
  const ports = {
    candidates: { listCandidateIds: () => Effect.succeed([]) },
    check: makeCheck({ authority: authoritySpec }).port,
    decisionLog: { record: () => Effect.void },
    intent: { authorityFor: () => makeAuthority(authoritySpec).port },
    principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
  };
  return bindAccessGate(
    makeAccessDecisionService({
      authorityFor: ports.intent.authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
    }),
    ports,
  );
};

const writeCells = (mode: 'approve' | 'propose') => [
  cell({ capability: `${ownerKey}.record.change`, mode, selector: { _tag: 'targets', recordKeys: [first, second] } }),
  cell({ capability: `${ownerKey}.record.write-salary`, mode }),
];
const readCells = [
  cell({
    capability: `${ownerKey}.record.read`,
    mode: 'run',
    selector: { _tag: 'targets', recordKeys: [first, second] },
  }),
  cell({ capability: `${ownerKey}.record.read-salary`, mode: 'run' }),
];

it.effect(
  'binds the original payload, complete canonical target set and independent registered Read into one digest',
  () =>
    Effect.gen(function* frozenCompleteCommand() {
      const command = yield* makeActionCommandV2({ payload, registration: action, scope });
      expect(command.format).toBe('core.action/2');
      expect(command.payload).toEqual(payload);
      expect(command.targets.map(({ recordKey }) => recordKey)).toEqual([first, second]);
      expect(command.governingRead?.readKey).toBe(`${ownerKey}.api.records`);
      expect(command.governingRead?.fieldGroups.map(({ key }) => key)).toEqual([`${ownerKey}.record.read-salary`]);
      expect(command.scope).toEqual({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId });
      const original = freezeActionCommandV2(command);
      const codec = Schema.fromJsonString(ActionCommandV2Schema);
      const encoded = yield* Schema.encodeEffect(codec)(command);
      const roundtrip = yield* Schema.decodeEffect(codec)(encoded);
      expect(freezeActionCommandV2(roundtrip)).toEqual(original);
      expect(Result.isSuccess(original)).toBe(true);
      const changed = yield* makeActionCommandV2({ payload: { ...payload, salary: 26 }, registration: action, scope });
      expect(freezeActionCommandV2(changed)).not.toEqual(original);
      expect(yield* rebindActionCommandV2(action, command, scope)).toEqual(payload);
    }),
);

it.effect('requester proofs ask PROPOSE for every changed field and its Action parent on every target', () =>
  Effect.gen(function* allRequesterQuestions() {
    const command = yield* makeActionCommandV2({ payload, registration: action, scope });
    const questions = actionCommandQuestionsV2(command).filter((question) => question.role === 'write');
    expect(questions).toHaveLength(4);
    const gate = canonicalGate({ cells: writeCells('propose') });
    for (const question of questions) {
      const input = yield* actionCommandGateQuestionV2(command, question, 'requester', scope, now);
      expect(input.mode).toBe('propose');
      expect((yield* gate.decide(input)).outcome).toBe('ALLOWED');
    }
  }),
);

it.effect(
  'approver proofs need Action/field APPROVE and independent record/field-read RUN with no Action RUN grant',
  () =>
    Effect.gen(function* allApproverQuestions() {
      const command = yield* makeActionCommandV2({ payload, registration: action, scope });
      const questions = actionCommandQuestionsV2(command);
      expect(questions).toHaveLength(8);
      expect(new Set(questions.map(({ questionHash }) => questionHash)).size).toBe(8);
      const gate = canonicalGate({ cells: [...writeCells('approve'), ...readCells] });
      for (const question of questions) {
        const input = yield* actionCommandGateQuestionV2(command, question, 'approver', scope, now);
        expect(input.mode).toBe(question.role === 'write' ? 'approve' : 'run');
        expect((yield* gate.decide(input)).outcome).toBe('ALLOWED');
        expect(input.parentRead?.capability.capabilityKey).toBe(question.parent?.key);
      }
    }),
);

for (const missing of ['middle-read', 'read-field', 'write-field', 'approve-parent'] as const) {
  it.effect(`does not substitute write APPROVE for missing ${missing} authority`, () =>
    Effect.gen(function* independentAuthorityRefusal() {
      const command = yield* makeActionCommandV2({ payload, registration: action, scope });
      let cells = [...writeCells('approve'), ...readCells];
      if (missing === 'middle-read') {
        cells = [
          ...writeCells('approve'),
          cell({
            capability: `${ownerKey}.record.read`,
            mode: 'run',
            selector: { _tag: 'targets', recordKeys: [first] },
          }),
          readCells[1],
        ].filter((entry) => entry !== undefined);
      }
      if (missing === 'read-field') {
        cells = cells.filter(({ capabilityKey }) => capabilityKey !== `${ownerKey}.record.read-salary`);
      }
      if (missing === 'write-field') {
        cells = cells.filter(({ capabilityKey }) => capabilityKey !== `${ownerKey}.record.write-salary`);
      }
      if (missing === 'approve-parent') {
        cells = cells.filter(({ capabilityKey }) => capabilityKey !== `${ownerKey}.record.change`);
        cells.push(cell({ capability: `${ownerKey}.record.change`, mode: 'run' }));
      }
      const gate = canonicalGate({ cells });
      const outcomes = [];
      for (const question of actionCommandQuestionsV2(command)) {
        const input = yield* actionCommandGateQuestionV2(command, question, 'approver', scope, now);
        outcomes.push((yield* gate.decide(input)).outcome);
      }
      expect(outcomes).toContain('DENIED');
    }),
  );
}

it.effect('retains every read-field restriction even when this command changes no protected write field', () =>
  Effect.gen(function* independentReadRestrictions() {
    const command = yield* makeActionCommandV2({ payload: { ids: payload.ids }, registration: action, scope });
    expect(command.fieldGroups).toEqual([]);
    expect(command.governingRead?.fieldGroups).toHaveLength(1);
    expect(actionCommandQuestionsV2(command)).toHaveLength(6);
  }),
);

it.effect('has no scalar parser fallback and refuses incomplete, foreign or modified target facts', () =>
  Effect.gen(function* invalidForwardCommands() {
    const command = yield* makeActionCommandV2({ payload, registration: action, scope });
    const { governingRead: _governingRead, ...withoutRead } = command;
    for (const invalid of [
      payload,
      { ...command, format: 'core.action/1' },
      { ...command, targets: [] },
      { ...command, targets: [command.targets[0]] },
      { ...command, targets: [command.targets[0], command.targets[0]] },
      { ...command, targetSetHash: '0'.repeat(64) },
      { ...command, scope: { ...command.scope, tenantId: '00000000-0000-4000-8000-000000000099' } },
      { ...command, surprise: 'not-hashed' },
      withoutRead,
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(decodeActionCommandV2(invalid)))).toBe(true);
    }
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          rebindActionCommandV2(action, command, {
            ...scope,
            legalEntityId: '00000000-0000-4000-8000-000000000099',
          }),
        ),
      ),
    ).toBe(true);
  }),
);
