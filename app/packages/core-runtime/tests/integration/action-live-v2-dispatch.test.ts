import { NodeServices } from '@effect/platform-node';
import { Effect, Layer, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionProposalAcceptedSchema } from '../../src/actions/proposal-accepted.ts';
import { makeNativeActionV2Fixture, nativeV2Keys } from '../support/action-live-v2.ts';
import { NativeHumanSessionsFactoryLive } from '../support/native-human-sessions.ts';

type Fixture = Effect.Success<typeof makeNativeActionV2Fixture>;

const park = Effect.fn('NativeV2Test.park')(function* park(fixture: Fixture, key = 'native-v2-propose') {
  const accepted = yield* fixture.runtime.runAction({
    payload: fixture.payload,
    principal: yield* fixture.principalFor(fixture.requesterId),
    registration: fixture.action,
    successContract: 'result-or-proposal',
    transport: { correlationId: key, idempotencyKey: key, intent: 'propose' },
  });
  if (!Schema.is(ActionProposalAcceptedSchema)(accepted)) {
    return yield* Effect.die('The registered native proposal must return its own 202, never a handler result');
  }
  expect(fixture.executions.value).toBe(0);
  return accepted;
});

const approve = Effect.fn('NativeV2Test.approve')(function* approve(
  fixture: Fixture,
  accepted: Effect.Success<ReturnType<typeof park>>,
) {
  return yield* fixture.approvalsFor(fixture.approverScope).approve({
    approver: { _tag: 'Principal', principalId: fixture.approverId },
    approverKind: 'human',
    policy: { selfApproval: 'forbidden' },
    proposalId: accepted.proposalId,
    scopeId: fixture.companyScope,
    tenantId: fixture.tenantId,
  });
});

const executeInput = Effect.fn('NativeV2Test.executeInput')(function* executeInput(
  fixture: Fixture,
  proposalId: string,
  idempotencyKey = 'native-v2-execute',
) {
  const [row] = yield* fixture.admin.unsafe<{ readonly mandate_id: string }>(
    'select mandate_id from core.access_mandates where tenant_id = $1 and proposal_id = $2',
    [fixture.tenantId, proposalId],
  );
  if (row === undefined) {
    return yield* Effect.die('The genuine approval store must have created the mandate');
  }
  return {
    payload: null,
    principal: yield* fixture.principalFor(fixture.approverId),
    registration: fixture.action,
    transport: { correlationId: idempotencyKey, idempotencyKey, mandateId: row.mandate_id },
  };
});

const ownerRows = (fixture: Fixture) =>
  fixture.admin.unsafe<{
    readonly record_key: string;
    readonly salary: number;
    readonly version: number;
  }>('select record_key,salary,version from public.native_action_v2_records order by record_key');

const retire = Effect.fn('NativeV2Test.retire')(function* retire(fixture: Fixture, capabilityKey: string) {
  const grant = fixture.approverRole.grants.find((candidate) => candidate.capabilityKey === capabilityKey);
  if (grant === undefined) {
    return yield* Effect.die('The test must retire a real seeded grant');
  }
  yield* fixture.admin.unsafe(
    "update core.access_grant_incarnations set status = 'retired' where grant_incarnation_id = $1",
    [grant.grantId],
  );
  yield* fixture.reconcile();
  return yield* Effect.void;
});

it.layer(NativeHumanSessionsFactoryLive.pipe(Layer.provideMerge(NodeServices.layer)), { excludeTestServices: true })(
  'live forward Action dispatch',
  (suite) => {
    suite.effect('proposes, approves and executes the original two-record command under the physical I/O guard', () =>
      Effect.gen(function* nativeFullLifecycle() {
        const fixture = yield* makeNativeActionV2Fixture;
        const requesterIdentity = yield* fixture.requesterSession.authenticate();
        const approverIdentity = yield* fixture.approverSession.authenticate();
        const requesterTenantIdentity = yield* fixture.requesterSession.authenticateTenant();
        const approverTenantIdentity = yield* fixture.approverSession.authenticateTenant();
        for (const { company, tenant } of [
          { company: requesterIdentity, tenant: requesterTenantIdentity },
          { company: approverIdentity, tenant: approverTenantIdentity },
        ]) {
          expect(tenant.principal.legalEntityId).toBeUndefined();
          expect(tenant.principal.tenantId).toBe(company.principal.tenantId);
          expect(tenant.principal.principalId).toBe(company.principal.principalId);
          expect(tenant.principal.authBindingId).toBe(company.principal.authBindingId);
          expect(tenant.principal.authContextRef).toBe(company.principal.authContextRef);
          expect(tenant.sessionId).toBe(company.sessionId);
          expect(tenant.providerSubjectId).toBe(company.providerSubjectId);
        }
        expect(requesterIdentity.principal.authMethod).toBe('session');
        expect(approverIdentity.principal.authMethod).toBe('session');
        expect(
          new Set([
            fixture.requesterId,
            fixture.approverId,
            requesterIdentity.authBindingId,
            approverIdentity.authBindingId,
            requesterIdentity.providerSubjectId,
            approverIdentity.providerSubjectId,
            requesterIdentity.sessionId,
            approverIdentity.sessionId,
          ]).size,
        ).toBe(8);
        for (const mismatch of [
          { legalEntityId: fixture.requesterId, principalId: fixture.requesterId, tenantId: fixture.tenantId },
          { legalEntityId: fixture.companyId, principalId: fixture.approverId, tenantId: fixture.tenantId },
          { legalEntityId: fixture.companyId, principalId: fixture.requesterId, tenantId: fixture.approverId },
        ]) {
          expect((yield* Effect.flip(fixture.requesterSession.authenticate(mismatch)))._tag).toBe(
            'NativeHumanSessionFixtureError',
          );
        }
        const accepted = yield* park(fixture);
        const original = Option.getOrThrow(
          yield* fixture.frozenCommands.load(fixture.requesterScope, {
            proposalId: accepted.proposalId,
            scopeId: fixture.companyScope,
          }),
        );
        expect(original.command.target).toBeUndefined();
        expect(original.command.payload).toMatchObject({
          format: 'core.action/2',
          payload: fixture.payload,
          targets: fixture.ids.map((recordKey) => ({
            moduleKey: fixture.action.descriptor.owningModuleKey,
            recordKey,
          })),
        });
        const approved = yield* approve(fixture, accepted);
        expect(approved.actionAuthority?.questions).toHaveLength(4);
        if (approved.approval === undefined || !('actionAuthority' in approved.approval)) {
          return yield* Effect.die('A real forward approval must retain its complete authority proof');
        }
        expect(approved.approval.actionAuthority.questions).toHaveLength(8);
        expect(approved.approval.actionAuthority.questions.map(({ mode, purpose }) => ({ mode, purpose }))).toEqual([
          { mode: 'approve', purpose: 'approve_write' },
          { mode: 'approve', purpose: 'approve_write' },
          { mode: 'run', purpose: 'governing_read' },
          { mode: 'run', purpose: 'governing_read' },
          { mode: 'approve', purpose: 'approve_write' },
          { mode: 'approve', purpose: 'approve_write' },
          { mode: 'run', purpose: 'governing_read' },
          { mode: 'run', purpose: 'governing_read' },
        ]);
        const request = yield* executeInput(fixture, accepted.proposalId);
        expect(yield* fixture.runtime.runAction(request)).toBe(2);
        expect(fixture.executions.value).toBe(1);
        expect(yield* ownerRows(fixture)).toEqual(
          fixture.ids.map((recordKey) => ({ record_key: recordKey, salary: 50, version: 2 })),
        );
        const { calls } = fixture.remote;
        expect((yield* Effect.flip(fixture.runtime.runAction(request)))._tag).toBe('ActionAlreadyCommitted');
        expect(fixture.remote.calls).toBe(calls);
        expect(fixture.executions.value).toBe(1);
        const [receipt] = yield* fixture.admin.unsafe<{
          readonly approver_assignment_incarnation_id: string | null;
          readonly execution_assignment_incarnation_id: string | null;
          readonly execution_operation_id: string | null;
          readonly status: string;
        }>(
          `select p.status,p.execution_operation_id,m.approver_assignment_incarnation_id,
           m.execution_assignment_incarnation_id from core.access_proposals p join core.access_mandates m
           using (tenant_id,proposal_id) where p.proposal_id = $1`,
          [accepted.proposalId],
        );
        expect(receipt).toMatchObject({
          approver_assignment_incarnation_id: null,
          execution_assignment_incarnation_id: null,
          status: 'executed',
        });
        expect(receipt?.execution_operation_id).toBeTruthy();
        expect(
          (yield* Effect.flip(
            fixture.runtime.runAction({
              ...request,
              transport: { ...request.transport, idempotencyKey: 'second-native-execution' },
            }),
          ))._tag,
        ).toBe('ActionAlreadyCommitted');
        expect(fixture.executions.value).toBe(1);
        expect(
          yield* fixture.frozenCommands.load(fixture.requesterScope, {
            proposalId: accepted.proposalId,
            scopeId: fixture.companyScope,
          }),
        ).toEqual(Option.some(original));
        yield* fixture.approverSession.revokeBinding();
        expect((yield* Effect.flip(fixture.approverSession.authenticate()))._tag).toBe(
          'NativeHumanSessionFixtureError',
        );
        expect((yield* Effect.flip(fixture.approverSession.authenticateTenant()))._tag).toBe(
          'NativeHumanSessionFixtureError',
        );
        yield* fixture.requesterSession.signOut();
        expect((yield* Effect.flip(fixture.requesterSession.authenticate()))._tag).toBe(
          'NativeHumanSessionFixtureError',
        );
        expect((yield* Effect.flip(fixture.requesterSession.authenticateTenant()))._tag).toBe(
          'NativeHumanSessionFixtureError',
        );
        return yield* Effect.void;
      }),
    );

    suite.effect('rolls back every changed record and the mandate receipt when the real owner CAS loses', () =>
      Effect.gen(function* nativeOwnerRollback() {
        const fixture = yield* makeNativeActionV2Fixture;
        const accepted = yield* park(fixture);
        yield* approve(fixture, accepted);
        yield* fixture.admin.unsafe('update public.native_action_v2_records set version = 2 where record_key = $1', [
          fixture.ids[1],
        ]);
        const request = yield* executeInput(fixture, accepted.proposalId);
        const outcome = yield* Effect.result(fixture.runtime.runAction(request));
        expect(outcome).toMatchObject({ failure: { _tag: 'NativeV2OwnerWriteError' } });
        expect(fixture.executions.value).toBe(1);
        expect((yield* ownerRows(fixture)).map(({ salary }) => salary)).toEqual([0, 0]);
        const [receipt] = yield* fixture.admin.unsafe<{
          readonly execution_operation_id: string | null;
          readonly status: string;
        }>('select status,execution_operation_id from core.access_proposals where proposal_id = $1', [
          accepted.proposalId,
        ]);
        expect(receipt).toEqual({ execution_operation_id: null, status: 'approved' });
      }),
    );

    for (const capability of [
      nativeV2Keys.action,
      nativeV2Keys.writeField,
      nativeV2Keys.read,
      nativeV2Keys.readField,
    ]) {
      suite.effect(`a lost bound ${capability} grant refuses owner execution and permanently lapses on recheck`, () =>
        Effect.gen(function* nativeBoundLoss() {
          const fixture = yield* makeNativeActionV2Fixture;
          const accepted = yield* park(fixture);
          yield* approve(fixture, accepted);
          yield* retire(fixture, capability);
          const request = yield* executeInput(fixture, accepted.proposalId);
          const result = yield* Effect.result(fixture.runtime.runAction(request));
          expect(Result.isFailure(result)).toBe(true);
          expect(result).toMatchObject({ failure: { _tag: 'ActionPermissionDenied' } });
          expect(fixture.executions.value).toBe(0);
          expect((yield* ownerRows(fixture)).map(({ salary }) => salary)).toEqual([0, 0]);
          const lapsed = yield* fixture.approvalsFor(fixture.approverScope).recheckAuthority({
            proposalId: accepted.proposalId,
            scopeId: fixture.companyScope,
            tenantId: fixture.tenantId,
          });
          expect(lapsed.status).toBe('lapsed');
          const [denials] = yield* fixture.admin.unsafe<{ readonly count: number }>(
            `select count(*)::integer as count from core.audit_events where tenant_id = $1
           and event_type = 'action.rejected'`,
            [fixture.tenantId],
          );
          expect(denials?.count).toBe(1);
        }),
      );
    }
  },
);
