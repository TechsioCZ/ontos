import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActionAuthorityProofV2Schema,
  actionAuthorityDigestV2,
  actionAuthorityQuestionsV2,
  bindActionAuthorityV2,
  decodeActionAuthorityProofV2,
} from '../../src/access/approvals/action-authority-v2.ts';
import {
  actionCommandGateQuestionV2,
  actionCommandQuestionsV2,
  makeActionCommandV2,
} from '../../src/access/approvals/action-command-v2.ts';
import {
  prepareActionAuthorityV2,
  prepareBoundActionAuthorityV2,
} from '../../src/access/approvals/prepared-action-authority-v2.ts';
import { recheckActionAuthorityV2 } from '../../src/access/approvals/action-authority-currentness-v2.ts';
import { approveActionV2, executeActionV2, proposeActionV2 } from '../../src/access/approvals/action-proposal-v2.ts';
import {
  mandateInsertValues,
  proposalFrom,
  proposalInsertValues,
} from '../../src/access/approvals/persistence/records.ts';
import { verifyHumanPrincipal } from '../../src/access/approvals/principals.ts';
import { assessAuthorityLoss } from '../../src/access/approvals/lapse.ts';
import { PreparedActionStepV2 } from '../../src/access/approvals/prepared-action-step-v2.ts';
import { ActionInvocationRefSchema } from '../../src/access/approvals/execution.ts';
import { ProposalSchema } from '../../src/access/model.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import { prepareEngineEvidence } from '../../src/access/enforcement/prepared-check.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import {
  LegalEntityIdSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  RecordKeySchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import { insideDatabaseTransaction, refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { actionFor, ownerKey, principal } from '../support/action-command-v2.ts';
import { makeTestDatabase } from '../support/database.ts';
import { at, cell, makeAuthority, makeCheck } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const scope: OperationalScope = { ...principal, correlationId: 'forward-authority' };
const now = at('2026-11-07T01:00:00Z');
const first = RecordKeySchema.make('record-1');
const second = RecordKeySchema.make('record-2');
const payload = { ids: [first, second], salary: 25 };
const principalId = PrincipalIdSchema.make(principal.principalId);

it('rejects a copied continuation prototype without treating it as prepared authority or throwing a defect', () => {
  const original = new PreparedActionStepV2(1);
  const copy = Schema.decodeUnknownSync(Schema.instanceOf(PreparedActionStepV2))(
    Object.create(PreparedActionStepV2.prototype),
  );
  expect(PreparedActionStepV2.read(original)).toBe(1);
  expect(PreparedActionStepV2.read(copy)).toBeUndefined();
});

const makeFixture = (phase: 'approver' | 'requester', withPreparation = false) =>
  Effect.gen(function* proofFixture() {
    const command = yield* makeActionCommandV2({ payload, registration: actionFor(), scope });
    const mode = phase === 'requester' ? 'propose' : 'approve';
    const spec: AuthoritySpec = {
      cells: [
        cell({
          capability: `${ownerKey}.record.change`,
          mode,
          selector: { _tag: 'targets', recordKeys: [first, second] },
        }),
        cell({ capability: `${ownerKey}.record.write-salary`, mode }),
        cell({ capability: `${ownerKey}.record.read`, mode: 'run' }),
        cell({ capability: `${ownerKey}.record.read-salary`, mode: 'run' }),
      ],
      legalEntityScope: {
        _tag: 'LegalEntity',
        legalEntityId: LegalEntityIdSchema.make(principal.legalEntityId ?? ''),
        tenantId: TenantIdSchema.make(principal.tenantId),
      },
    };
    const authority = makeAuthority(spec).port;
    let revision = 1;
    let remoteCalls = 0;
    const check = makeCheck({ authority: spec }).port;
    const intent = {
      authorityFor: () => authority,
      joined: () => ({ authorityFor: () => authority }),
    };
    const ports = {
      candidates: { listCandidateIds: () => Effect.succeed([]) },
      check: {
        checkBulk: Effect.fn('ForwardAuthorityFixture.remote')(function* remoteCheck(
          items: Parameters<typeof check.checkBulk>[0],
        ) {
          yield* refuseInsideDatabaseTransaction('spicedb', 'forward-authority-proof');
          remoteCalls += 1;
          return yield* check.checkBulk(items);
        }),
      },
      decisionLog: { record: () => Effect.void },
      intent,
      principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
    };
    const preparedPorts = {
      ...ports,
      currentness: { read: () => Effect.sync(() => [{ revision, scopeId: 'fixture-scope-revision' }]) },
    };
    const gate = bindAccessGate(
      makeAccessDecisionService({
        authorityFor: ports.intent.authorityFor,
        check: ports.check,
        decisionLog: ports.decisionLog,
        legalEntities: ports.candidates,
        principalKinds: ports.principalKinds,
      }),
      withPreparation ? preparedPorts : ports,
    );
    const questions = actionCommandQuestionsV2(command).filter(
      (question) => phase === 'approver' || question.role === 'write',
    );
    const decisions = yield* Effect.forEach(
      questions,
      (question) => actionCommandGateQuestionV2(command, question, phase, scope, now).pipe(Effect.flatMap(gate.decide)),
      { concurrency: 1 },
    );
    const proof = yield* bindActionAuthorityV2({ command, decisions, now, phase, principalId });
    const expectation = { phase, principalId, scopeId: proof.scopeId };
    return {
      advanceRevision: () => {
        revision += 2;
      },
      authority,
      check: ports.check,
      command,
      decisions,
      expectation,
      gate,
      ports: preparedPorts,
      proof,
      remoteCalls: () => remoteCalls,
      spec,
    };
  });

const forwardProposalFixture = () =>
  Effect.gen(function* completeForwardProposalFixture() {
    const requester = yield* makeFixture('requester');
    const approver = yield* makeFixture('approver');
    const human = yield* Effect.fromResult(verifyHumanPrincipal({ principalId, principalKind: 'human' }));
    const capability = capabilityPolicyOf(requester.command.declaration);
    const pending = yield* proposeActionV2({
      capability,
      command: requester.command,
      now,
      proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-000000000030'),
      requester: human,
      requesterAuthority: requester.proof,
      scopeId: requester.proof.scopeId,
      tenantId: requester.command.scope.tenantId,
    });
    const approve = {
      approver: human,
      approverAuthority: approver.proof,
      capability,
      command: requester.command,
      currentRequesterAuthority: requester.proof,
      now,
      policy: { selfApproval: 'permitted' as const },
      proposal: pending,
    };
    return { approve, approver, human, pending, requester };
  });

it.effect('a real governing-read loss reaches the forward approver proof without inventing historical witnesses', () =>
  Effect.gen(function* fullSetReadLoss() {
    const { approve, pending } = yield* forwardProposalFixture();
    const mandate = yield* approveActionV2(approve);
    const loss = {
      authorityLoss: 'parent_record_read_lost' as const,
      principalId,
      scopeId: mandate.scopeId,
      tenantId: mandate.tenantId,
    };
    expect(mandate.witnesses).toEqual([]);
    expect(assessAuthorityLoss(mandate, loss)).toMatchObject({
      _tag: 'lapse',
      authorityLoss: 'parent_record_read_lost',
    });
    expect(assessAuthorityLoss(pending, loss)).toHaveProperty('_tag', 'retain');
    expect(
      assessAuthorityLoss(mandate, {
        ...loss,
        principalId: PrincipalIdSchema.make('00000000-0000-4000-8000-000000000099'),
      }),
    ).toHaveProperty('_tag', 'retain');
    expect(assessAuthorityLoss({ ...mandate, status: 'executed' }, loss)).toHaveProperty('_tag', 'retain');
  }),
);

it.effect('round-trips full forward proposal and approval proofs without historical execution/RUN assignments', () =>
  Effect.gen(function* forwardDurableRecord() {
    const { approve, approver, pending, requester } = yield* forwardProposalFixture();
    const mandate = yield* approveActionV2(approve);
    expect(pending.witnesses).toEqual([]);
    expect(pending.actionAuthority).toEqual(requester.proof);
    expect(mandate.approval).toMatchObject({ actionAuthority: approver.proof });
    if (mandate.approval === undefined) {
      expect.unreachable('The forward mandate has its complete approval');
    }
    const mandateRow = mandateInsertValues(mandate, mandate.approval, '00000000-0000-4000-8000-000000000031');
    expect(mandateRow.approverAssignmentIncarnationId).toBeNull();
    expect(mandateRow.executionAssignmentIncarnationId).toBeNull();
    expect(yield* Effect.fromResult(proposalFrom(proposalInsertValues(mandate), mandateRow, []))).toEqual(mandate);
    expect(yield* Effect.fromResult(proposalFrom(proposalInsertValues(pending), undefined, []))).toEqual(pending);
    for (const value of [
      { ...pending, target: first },
      { ...pending, actionAuthority: approver.proof },
      { ...mandate, actionAuthority: { ...requester.proof, commandDigest: '0'.repeat(64) } },
      { ...mandate, approval: { ...mandate.approval, actionAuthority: requester.proof } },
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(ProposalSchema)(value)))).toBe(true);
    }
  }),
);

it.effect(
  'executes one forward full-set mandate with APPROVE and independent read RUN, never an Action RUN grant',
  () =>
    Effect.gen(function* completeForwardMandate() {
      const { approve, approver, human, requester } = yield* forwardProposalFixture();
      const mandate = yield* approveActionV2(approve);
      const requesterPrepared = yield* prepareBoundActionAuthorityV2({
        command: requester.command,
        expectation: requester.expectation,
        now,
        ports: requester.ports,
        proof: requester.proof,
        scope,
      });
      const approverPrepared = yield* prepareBoundActionAuthorityV2({
        command: approver.command,
        expectation: approver.expectation,
        now,
        ports: approver.ports,
        proof: approver.proof,
        scope,
      });
      const before = requester.remoteCalls() + approver.remoteCalls();
      const executor = yield* makeTestDatabase(() => Effect.succeed([]));
      const executed = yield* executor.transaction((transaction) =>
        Effect.gen(function* consumeForwardMandate() {
          const currentRequesterAuthority = yield* requesterPrepared.recheck(now, transaction);
          const currentApproverAuthority = yield* approverPrepared.recheck(now, transaction);
          return yield* executeActionV2({
            actionInvocationId: ActionInvocationRefSchema.make('00000000-0000-4000-8000-000000000032'),
            actor: human,
            command: requester.command,
            currentApproverAuthority,
            currentRequesterAuthority,
            now,
            proposal: mandate,
          });
        }).pipe(insideDatabaseTransaction('full-forward-mandate')),
      );
      expect(executed.status).toBe('executed');
      expect(executed.execution?.actionInvocationId).toBe('00000000-0000-4000-8000-000000000032');
      expect(requester.remoteCalls() + approver.remoteCalls()).toBe(before);
      const replay = yield* executeActionV2({
        actionInvocationId: ActionInvocationRefSchema.make('00000000-0000-4000-8000-000000000033'),
        actor: human,
        command: requester.command,
        currentApproverAuthority: approver.proof,
        currentRequesterAuthority: requester.proof,
        now,
        proposal: executed,
      }).pipe(Effect.flip);
      expect(replay).toMatchObject({ _tag: 'MandateRefusedError', code: 'proposal_already_executed' });
    }),
);

it.effect(
  'retains self-approval policy, full requester currentness, changed command and terminal refusal controls',
  () =>
    Effect.gen(function* forwardApprovalControls() {
      const { approve, requester } = yield* forwardProposalFixture();
      expect(
        yield* approveActionV2({ ...approve, policy: { selfApproval: 'forbidden' } }).pipe(Effect.flip),
      ).toMatchObject({ _tag: 'ApprovalRefusedError', code: 'self_approval_forbidden' });
      expect(
        yield* approveActionV2({
          ...approve,
          currentRequesterAuthority: { ...requester.proof, questions: [requester.proof.questions[0]] },
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: 'ApprovalRefusedError', code: 'requester_authority_lost' });
      const changed = yield* makeActionCommandV2({
        payload: { ...payload, salary: 26 },
        registration: actionFor(),
        scope,
      });
      expect(yield* approveActionV2({ ...approve, command: changed }).pipe(Effect.flip)).toMatchObject({
        _tag: 'ActionPermissionCheckError',
      });
      const approved = yield* approveActionV2(approve);
      expect(yield* approveActionV2({ ...approve, proposal: approved }).pipe(Effect.flip)).toMatchObject({
        _tag: 'ApprovalRefusedError',
        code: 'proposal_not_pending',
      });
    }),
);

for (const phase of ['approver', 'requester'] as const) {
  it.effect(`retains every exact target and field authority in a strict durable ${phase} proof`, () =>
    Effect.gen(function* completeProof() {
      const { command, expectation, proof } = yield* makeFixture(phase);
      const expectedCount = phase === 'approver' ? 8 : 4;
      expect(proof.questions).toHaveLength(expectedCount);
      expect(new Set(proof.questions.map(({ questionHash }) => questionHash)).size).toBe(expectedCount);
      expect(proof.questions.filter(({ purpose }) => purpose === 'governing_read')).toHaveLength(
        phase === 'approver' ? 4 : 0,
      );
      const writeMode = phase === 'approver' ? 'approve' : 'propose';
      expect(
        proof.questions.every(({ mode, purpose }) => mode === (purpose === 'governing_read' ? 'run' : writeMode)),
      ).toBe(true);
      const codec = Schema.fromJsonString(ActionAuthorityProofV2Schema);
      const json = yield* Schema.encodeEffect(codec)(proof);
      const restored = yield* Schema.decodeEffect(codec)(json);
      expect(actionAuthorityDigestV2(restored)).toBe(actionAuthorityDigestV2(proof));
      expect(yield* actionAuthorityQuestionsV2(command, restored, expectation)).toHaveLength(expectedCount);
    }),
  );
}

it.effect('does not collapse the same assignment and grant used for different records', () =>
  Effect.gen(function* distinctQuestions() {
    const { proof } = yield* makeFixture('approver');
    const writes = proof.questions.filter(({ purpose }) => purpose === 'approve_write');
    expect(writes).toHaveLength(4);
    expect(writes[0]?.witnesses).toEqual(writes[2]?.witnesses);
    expect(writes[0]?.questionHash).not.toBe(writes[2]?.questionHash);
    expect(writes[1]?.witnesses).toHaveLength(2);
    expect(proof.questions.filter(({ purpose }) => purpose === 'governing_read').at(1)?.witnesses).toHaveLength(2);
  }),
);

it.effect('rejects copied, missing, reordered, foreign and legacy stored questions without parser fallback', () =>
  Effect.gen(function* invalidDurableProofs() {
    const { command, expectation, proof } = yield* makeFixture('approver');
    const [firstQuestion, ...rest] = proof.questions;
    const invalidProofs: readonly unknown[] = [
      {},
      { ...proof, format: null },
      { ...proof, questions: rest },
      { ...proof, questions: [firstQuestion, firstQuestion, ...rest.slice(1)] },
      { ...proof, questions: proof.questions.toReversed() },
      { ...proof, commandDigest: '0'.repeat(64) },
      { ...proof, targetSetHash: '0'.repeat(64) },
      { ...proof, phase: 'requester' },
      { ...proof, principalId: '00000000-0000-4000-8000-000000000009' },
      { ...proof, scopeId: '00000000-0000-4000-8000-000000000009' },
      {
        ...proof,
        questions: proof.questions.map((question) => ({ ...question, mode: 'run', purpose: 'execution' })),
      },
    ];
    for (const invalid of invalidProofs) {
      const exit = yield* Effect.exit(actionAuthorityQuestionsV2(command, invalid, expectation));
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const changed = yield* makeActionCommandV2({
      payload: { ...payload, salary: 26 },
      registration: actionFor(),
      scope,
    });
    expect(Exit.isFailure(yield* Effect.exit(actionAuthorityQuestionsV2(changed, proof, expectation)))).toBe(true);
  }),
);

it.effect('cannot persist a field answer after removing its independent parent witness', () =>
  Effect.gen(function* parentEvidenceRequired() {
    const { command, expectation, proof } = yield* makeFixture('approver');
    for (const key of [`${ownerKey}.record.change`, `${ownerKey}.record.read`]) {
      const changed = {
        ...proof,
        questions: proof.questions.map((question) => ({
          ...question,
          witnesses:
            question.witnesses.length > 1
              ? question.witnesses.filter((witness) => witness.capabilityKey !== key)
              : question.witnesses,
        })),
      };
      expect(Exit.isFailure(yield* Effect.exit(actionAuthorityQuestionsV2(command, changed, expectation)))).toBe(true);
    }
  }),
);

it.effect('keeps unavailable authority retryable and refuses a mixed, missing or witnessless grant', () =>
  Effect.gen(function* noSyntheticProof() {
    const { command, decisions } = yield* makeFixture('approver');
    for (const outcome of ['DENIED', 'NEEDS_APPROVAL', 'UNAVAILABLE'] as const) {
      const mixed = decisions.map((decision, index) => (index === 4 ? { ...decision, outcome } : decision));
      const failure = yield* bindActionAuthorityV2({
        command,
        decisions: mixed,
        now,
        phase: 'approver',
        principalId,
      }).pipe(Effect.flip);
      expect(failure._tag).toBe(outcome === 'UNAVAILABLE' ? 'ActionPermissionCheckError' : 'ActionPermissionDenied');
    }
    for (const invalid of [decisions.slice(1), decisions.map((decision) => ({ ...decision, evidence: [] }))]) {
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            bindActionAuthorityV2({ command, decisions: invalid, now, phase: 'approver', principalId }),
          ),
        ),
      ).toBe(true);
    }
  }),
);

it.effect('retains the least authority deadline and never encodes an expired or extended admission', () =>
  Effect.gen(function* boundedProofDeadline() {
    const { command, decisions } = yield* makeFixture('approver');
    const early = at('2026-11-07T01:00:01Z');
    const bounded = decisions.map((decision, index) => ({
      ...decision,
      admissionDeadline: index === 4 ? early : at('2026-11-07T01:00:02Z'),
    }));
    const proof = yield* bindActionAuthorityV2({ command, decisions: bounded, now, phase: 'approver', principalId });
    expect(proof.admissionDeadline).toBe(early.getTime());
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          bindActionAuthorityV2({ command, decisions: bounded, now: early, phase: 'approver', principalId }),
        ),
      ),
    ).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(decodeActionAuthorityProofV2({ ...proof, extra: true })))).toBe(true);
  }),
);

for (const phase of ['approver', 'requester'] as const) {
  it.effect(`replans the complete ${phase} authority under the physical writer I/O guard without remote calls`, () =>
    Effect.gen(function* preparedWholeCommand() {
      const fixture = yield* makeFixture(phase, true);
      const prepared = yield* prepareActionAuthorityV2({
        command: fixture.command,
        gate: fixture.gate,
        now,
        phase,
        scope,
      });
      const remoteCalls = fixture.remoteCalls();
      const executor = yield* makeTestDatabase(() => Effect.succeed([]));
      const current = yield* executor.transaction((transaction) =>
        prepared.recheck(now, transaction).pipe(insideDatabaseTransaction('forward-authority-writer')),
      );
      expect(current).toEqual(prepared.proof);
      expect(fixture.remoteCalls()).toBe(remoteCalls);
      fixture.advanceRevision();
      const stale = yield* Effect.exit(
        executor.transaction((transaction) =>
          prepared.recheck(now, transaction).pipe(insideDatabaseTransaction('stale-forward-authority-writer')),
        ),
      );
      expect(Exit.isFailure(stale)).toBe(true);
      expect(fixture.remoteCalls()).toBe(remoteCalls);
    }),
  );
}

for (const phase of ['approver', 'requester'] as const) {
  it.effect(`prepares the stored ${phase} proof outside SQL and repeats every bound question with engine replay`, () =>
    Effect.gen(function* prepareStoredAuthority() {
      const fixture = yield* makeFixture(phase);
      const prepared = yield* prepareBoundActionAuthorityV2({
        command: fixture.command,
        expectation: fixture.expectation,
        now,
        ports: fixture.ports,
        proof: fixture.proof,
        scope,
      });
      const remoteCalls = fixture.remoteCalls();
      const executor = yield* makeTestDatabase(() => Effect.succeed([]));
      expect(
        yield* executor.transaction((transaction) =>
          prepared.recheck(now, transaction).pipe(insideDatabaseTransaction('stored-forward-proof-writer')),
        ),
      ).toEqual(fixture.proof);
      expect(fixture.remoteCalls()).toBe(remoteCalls);
      fixture.advanceRevision();
      const stale = yield* executor
        .transaction((transaction) =>
          prepared.recheck(now, transaction).pipe(insideDatabaseTransaction('stale-stored-forward-proof-writer')),
        )
        .pipe(Effect.flip);
      expect(stale._tag).toBe('ActionPermissionCheckError');
      expect(fixture.remoteCalls()).toBe(remoteCalls);
    }),
  );
}

it.effect(
  'refuses a projection revision change during stored-proof preparation instead of sealing mixed evidence',
  () =>
    Effect.gen(function* changedDuringPreparation() {
      const fixture = yield* makeFixture('approver');
      const before = fixture.remoteCalls();
      const failure = yield* prepareBoundActionAuthorityV2({
        command: fixture.command,
        expectation: fixture.expectation,
        now,
        ports: {
          ...fixture.ports,
          check: {
            checkBulk: (items) =>
              fixture.ports.check.checkBulk(items).pipe(Effect.tap(() => Effect.sync(fixture.advanceRevision))),
          },
        },
        proof: fixture.proof,
        scope,
      }).pipe(Effect.flip);
      expect(failure._tag).toBe('ActionPermissionCheckError');
      expect(fixture.remoteCalls()).toBeGreaterThan(before);
    }),
);

it.effect('cannot prepare a lost saved incarnation even if a fresh canonical gate grants the replacement', () =>
  Effect.gen(function* noReplacementAtPreparation() {
    const fixture = yield* makeFixture('approver');
    const capability = `${ownerKey}.record.change`;
    const replacement = cell({ capability, mode: 'approve' });
    const authority = makeAuthority({
      ...fixture.spec,
      cells: [...fixture.spec.cells.filter((candidate) => candidate.capabilityKey !== capability), replacement],
    }).port;
    const failure = yield* prepareBoundActionAuthorityV2({
      command: fixture.command,
      expectation: fixture.expectation,
      now,
      ports: { ...fixture.ports, intent: { ...fixture.ports.intent, authorityFor: () => authority } },
      proof: fixture.proof,
      scope,
    }).pipe(Effect.flip);
    expect(failure._tag).toBe('ActionPermissionDenied');
  }),
);

it.effect('does not extend the saved proof deadline when current membership has a later deadline', () =>
  Effect.gen(function* retainedSavedDeadline() {
    const fixture = yield* makeFixture('approver');
    const deadline = now.getTime() + 1;
    const bounded = { ...fixture.proof, admissionDeadline: deadline };
    const prepared = yield* prepareBoundActionAuthorityV2({
      command: fixture.command,
      expectation: fixture.expectation,
      now,
      ports: fixture.ports,
      proof: bounded,
      scope,
    });
    expect(prepared.proof).toEqual(bounded);
    const executor = yield* makeTestDatabase(() => Effect.succeed([]));
    const failure = yield* executor
      .transaction((transaction) =>
        prepared
          .recheck(DateTime.toDateUtc(DateTime.makeUnsafe(deadline)), transaction)
          .pipe(insideDatabaseTransaction('expired-stored-proof')),
      )
      .pipe(Effect.flip);
    expect(failure._tag).toBe('ActionPermissionDenied');
  }),
);

it.effect('refuses an unprepared gate rather than asking remote authority inside a writer', () =>
  Effect.gen(function* noPreparedAuthorityFallback() {
    const fixture = yield* makeFixture('approver');
    const before = fixture.remoteCalls();
    const exit = yield* Effect.exit(
      prepareActionAuthorityV2({
        command: fixture.command,
        gate: fixture.gate,
        now,
        phase: 'approver',
        scope,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fixture.remoteCalls()).toBe(before);
  }),
);

it.effect('rechecks every durable bound question through the canonical planner and one exact engine snapshot', () =>
  Effect.gen(function* liveBoundAuthority() {
    const fixture = yield* makeFixture('approver');
    const evidence = prepareEngineEvidence(fixture.check);
    const input = {
      authority: fixture.authority,
      command: fixture.command,
      expectation: fixture.expectation,
      now,
      proof: fixture.proof,
      scope,
    };
    const live = yield* recheckActionAuthorityV2({ ...input, check: evidence.capture });
    expect(live).toEqual(fixture.proof);
    evidence.seal();
    const before = fixture.remoteCalls();
    const writerProof = yield* recheckActionAuthorityV2({ ...input, check: evidence.replay }).pipe(
      insideDatabaseTransaction('bound-forward-proof'),
    );
    expect(writerProof).toEqual(fixture.proof);
    expect(fixture.remoteCalls()).toBe(before);
  }),
);

for (const capability of [
  `${ownerKey}.record.change`,
  `${ownerKey}.record.write-salary`,
  `${ownerKey}.record.read`,
  `${ownerKey}.record.read-salary`,
]) {
  it.effect(`a different live grant never rescues the lost bound ${capability} authority`, () =>
    Effect.gen(function* originalIncarnationRequired() {
      const fixture = yield* makeFixture('approver');
      const original = fixture.spec.cells.find((candidate) => candidate.capabilityKey === capability);
      const replacement = cell({ capability, mode: original?.mode ?? 'approve' });
      const authority = makeAuthority({
        ...fixture.spec,
        cells: [...fixture.spec.cells.filter((candidate) => candidate.capabilityKey !== capability), replacement],
      }).port;
      const failure = yield* recheckActionAuthorityV2({
        authority,
        check: fixture.check,
        command: fixture.command,
        expectation: fixture.expectation,
        now,
        proof: fixture.proof,
        scope,
      }).pipe(Effect.flip);
      expect(failure._tag).toBe('ActionPermissionDenied');
    }),
  );
}

it.effect('distinguishes lost membership, expired deadlines, foreign scope and unavailable current facts', () =>
  Effect.gen(function* currentBoundAuthorityFailures() {
    const fixture = yield* makeFixture('approver');
    const base = {
      authority: fixture.authority,
      check: fixture.check,
      command: fixture.command,
      expectation: fixture.expectation,
      now,
      proof: fixture.proof,
      scope,
    };
    const noMembership = { ...fixture.authority, readScope: () => Effect.succeed(Option.none()) };
    expect((yield* recheckActionAuthorityV2({ ...base, authority: noMembership }).pipe(Effect.flip))._tag).toBe(
      'ActionPermissionDenied',
    );
    const unavailable = {
      ...fixture.authority,
      readCells: () => Effect.fail(accessDecisionUnavailable('Intent is unavailable')),
    };
    expect((yield* recheckActionAuthorityV2({ ...base, authority: unavailable }).pipe(Effect.flip))._tag).toBe(
      'ActionPermissionCheckError',
    );
    expect((yield* recheckActionAuthorityV2({ ...base, now: at('2028-01-01T00:00:00Z') }).pipe(Effect.flip))._tag).toBe(
      'ActionPermissionDenied',
    );
    expect(
      (yield* recheckActionAuthorityV2({
        ...base,
        scope: { ...scope, legalEntityId: LegalEntityIdSchema.make('00000000-0000-4000-8000-000000000009') },
      }).pipe(Effect.flip))._tag,
    ).toBe('ActionPermissionCheckError');
  }),
);
