import { ReadHandlerNotFound, ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { rowsVisibleToListAccess } from '../../src/access/list-access-rows.ts';
import { duplicateCandidateDetailRead } from '../../src/api/duplicate-candidate-detail.read.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

/**
 * The negative controls for the `assigned` selector (O10, O24): a record-scoped capability with
 * `assigned` names the record the gate decides, so a person without the assignment has no record in
 * the detail, and the owner's row filter drops every row whose owner column does not name the caller —
 * including the rows nobody is assigned to. Both halves run the production read runtime.
 */

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000002';
const assigneeId = '20000000-0000-4000-8000-000000000003';
const caseId = '30000000-0000-4000-8000-000000000001';
const otherCaseId = '30000000-0000-4000-8000-000000000002';
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:assigned-record-access',
    authMethod: 'session',
    principalId,
    tenantId,
  }),
  correlationId: 'assigned-record-access',
};
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:00:00.000Z'));

const conditionOf = (encoded: (typeof ListAccessConditionSchema)['Encoded']): ListAccessCondition =>
  Schema.decodeUnknownSync(ListAccessConditionSchema)(encoded);
const filterOf = (...conditions: [ListAccessCondition, ...ListAccessCondition[]]): ListAccessPredicate => ({
  groups: [{ clauses: [{ conditions }] }],
});
const assignedTo = (assignee: string) =>
  filterOf(conditionOf({ _tag: 'AssignedTo', holder: { _tag: 'Principal', principalId: assignee } }));

const detailInvocation = {
  input: { caseRef: makeDuplicateCandidateCaseRef(tenantId, caseId) },
  principal: scope,
  registration: duplicateCandidateDetailRead,
  transport: { correlationId: scope.correlationId },
} as const;

it.layer(NodeCrypto.layer)('assigned record access', (suite) => {
  suite.effect('refuses a record-scoped Duplicate Candidate detail before any owner read when the gate denies it', () =>
    Effect.gen(function* deniedAssignedDetail() {
      const harness = yield* makeReadTestHarness({
        access: { 'party.registry.duplicate-candidate.read': 'denied' },
        executeOwnerQuery: () => Effect.die('Owner SQL must not run when the gate denies the record'),
        operationTime,
        ownerRegistration: partyRegistryBackendRegistration,
        scope,
      });
      const failure = yield* harness.runtime.runRead(detailInvocation).pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      // Denied at the gate, before the transaction even installs the scope.
      expect(harness.snapshot().stages).not.toContain('scope_installed');
    }),
  );

  suite.effect('runs the same record-scoped detail for a caller the gate allows', () =>
    Effect.gen(function* allowedAssignedDetail() {
      const harness = yield* makeReadTestHarness({
        access: { 'party.registry.duplicate-candidate.read': 'allowed' },
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime,
        ownerRegistration: partyRegistryBackendRegistration,
        ownerAuthorizationDecision: 'allowed',
        scope,
      });
      const failure = yield* harness.runtime.runRead(detailInvocation).pipe(Effect.flip);
      // The gate allowed the record, so the owner ran and answered "no such case" — not a denial.
      expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries.length).toBeGreaterThan(0);
    }),
  );
});

it('hides every row from a caller the owner column does not name, including unassigned rows', () => {
  // The owner's projection of a Duplicate Candidate row: its immutable id and its assignee column.
  const rows: readonly { readonly assignedPrincipalId?: string; readonly caseId: string }[] = [
    { assignedPrincipalId: assigneeId, caseId },
    { caseId: otherCaseId },
  ];
  const visible = (filter?: ListAccessPredicate) =>
    rowsVisibleToListAccess({
      filter,
      row: ({ assignedPrincipalId, caseId: recordKey }) =>
        assignedPrincipalId === undefined ? { recordKey } : { assignedPrincipalId, recordKey },
      rows,
    }).map(({ caseId: id }) => id);
  // A caller without the assignment sees no record at all, including the record nobody is assigned to.
  expect(visible(assignedTo(principalId))).toEqual([]);
  // The assignee sees exactly the assigned record.
  expect(visible(assignedTo(assigneeId))).toEqual([caseId]);
  // A scope-wide grant keeps every row, and a read the gate does not row-scope is never filtered.
  expect(visible(filterOf(conditionOf({ _tag: 'AllInScope' })))).toEqual([caseId, otherCaseId]);
  expect(visible()).toEqual([caseId, otherCaseId]);
});
