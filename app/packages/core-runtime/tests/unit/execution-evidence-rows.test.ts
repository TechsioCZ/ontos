import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { CallRecord } from '../../src/execution/contract.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { callEvidenceRows } from '../../src/reads/run-evidence-live.ts';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '20000000-0000-4000-8000-000000000002',
  authContextRef: 'better-auth-session:execution-evidence-rows',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000003',
  tenantId: '20000000-0000-4000-8000-000000000001',
});
const scope: OperationalScope = { ...principal, correlationId: 'execution-evidence-rows' };

const base = {
  accessKind: 'detail',
  captureMode: 'metadata_only',
  policyKey: 'test.consumer.evidence.verify',
  readKey: 'test.consumer.api.verify',
  scope,
  servingModuleKey: 'test.consumer',
} as const;

const record = (outcome: CallRecord['outcome'], sequence: number): CallRecord => ({
  callerKind: outcome === 'Forbidden' ? 'refused' : 'person',
  durationMillis: 3,
  name: 'restrictions',
  outcome,
  placement: 'before',
  provider: { entrypointKey: 'test.provider.api.restrictions', moduleId: 'test.provider', schemaVersion: '1' },
  requirementKey: 'test.consumer.requirement.restrictions',
  route: 'Module',
  sequence,
});

it('writes one row per call with the outcome, its code, the target and the read base', () => {
  const rows = callEvidenceRows(
    [record('Ok', 1), record('Forbidden', 2), record('NotFound', 3), record('Rejected', 4), record('Unavailable', 5)],
    base,
  );
  expect(rows.map(({ outcome, outcomeCode, resultCount }) => ({ outcome, outcomeCode, resultCount }))).toEqual([
    { outcome: 'allowed', outcomeCode: 'call_ok', resultCount: 1 },
    { outcome: 'denied', outcomeCode: 'call_forbidden', resultCount: 0 },
    { outcome: 'failed', outcomeCode: 'call_not_found', resultCount: 0 },
    { outcome: 'failed', outcomeCode: 'call_rejected', resultCount: 0 },
    { outcome: 'failed', outcomeCode: 'call_unavailable', resultCount: 0 },
  ]);
  expect(rows[0]).toEqual({
    accessKind: 'detail',
    captureMode: 'metadata_only',
    outcome: 'allowed',
    outcomeCode: 'call_ok',
    outcomeStage: 'execution',
    policyKey: 'test.consumer.evidence.verify',
    readKey: 'test.consumer.api.verify',
    resultCount: 1,
    scope,
    servingModuleKey: 'test.consumer',
    targetModuleKey: 'test.provider',
    targetResourceType: 'test.provider.api.restrictions',
  });
});

it('snake-cases the reserved write outcomes into their codes', () => {
  const rows = callEvidenceRows(
    [
      record('Committed', 1),
      record('CommittedRejection', 2),
      record('DefinitelyUncommitted', 3),
      record('Indeterminate', 4),
    ],
    base,
  );
  expect(rows.map(({ outcome, outcomeCode }) => [outcome, outcomeCode])).toEqual([
    ['failed', 'call_committed'],
    ['failed', 'call_committed_rejection'],
    ['failed', 'call_definitely_uncommitted'],
    ['failed', 'call_indeterminate'],
  ]);
});

it('writes no row for an execution without calls', () => {
  expect(callEvidenceRows([], base)).toEqual([]);
});
