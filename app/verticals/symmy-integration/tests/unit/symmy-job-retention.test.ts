import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  SymmyJobRetentionPolicySchema,
  symmyRetentionTargetForPrivacyHandoff,
} from '../../shared/domain/symmy-job-retention.ts';

const id = '10000000-0000-4000-8000-000000000003';
const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  contentScopeRefs: [`integration.symmy.job:${id}#integration.symmy.job-intent`],
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: [],
  idempotencyKey: 'internal-disposition-key',
  kind: 'DELETE',
  measureId: 'internal-measure',
  owningCapability: 'integration.symmy',
  preconditionRefs: [],
  requestedAt: '2026-11-07T00:00:00.000Z',
  requestedResult: 'Remove the approved operational payload',
  resourceRefs: [`integration.symmy.job:${id}`],
  right: 'ERASURE',
  sourceDecisionRef: 'internal-decision',
  sourceDecisionRevision: 1,
  subjectRef: 'internal-subject',
  taskId: 'internal-task',
  tenantId: 'internal-tenant',
});

it('requires an exact job-qualified content disposition rather than a generic payload permission', () => {
  expect(symmyRetentionTargetForPrivacyHandoff(handoff)).toEqual({ id, kind: 'JOB' });
  expect(
    symmyRetentionTargetForPrivacyHandoff({ ...handoff, contentScopeRefs: ['integration.symmy.job-intent'] }),
  ).toBeUndefined();
  expect(
    symmyRetentionTargetForPrivacyHandoff({
      ...handoff,
      contentScopeRefs: [`integration.symmy.job:10000000-0000-4000-8000-000000000099#integration.symmy.job-intent`],
    }),
  ).toBeUndefined();
});

it('keeps synchronous admission identity separate while requiring the same exact native disposition scope', () => {
  const resourceRef = `integration.symmy.sync-admission:${id}`;
  expect(
    symmyRetentionTargetForPrivacyHandoff({
      ...handoff,
      contentScopeRefs: [`${resourceRef}#integration.symmy.job-intent`],
      resourceRefs: [resourceRef],
    }),
  ).toEqual({ id, kind: 'SYNC' });
  expect(symmyRetentionTargetForPrivacyHandoff({ ...handoff, resourceRefs: [resourceRef] })).toBeUndefined();
});

it('rejects foreign owners, multiple resources and mismatched disposition kinds', () => {
  expect(symmyRetentionTargetForPrivacyHandoff({ ...handoff, owningCapability: 'party.registry' })).toBeUndefined();
  expect(
    symmyRetentionTargetForPrivacyHandoff({
      ...handoff,
      resourceRefs: [...handoff.resourceRefs, ...handoff.resourceRefs],
    }),
  ).toBeUndefined();
  expect(symmyRetentionTargetForPrivacyHandoff({ ...handoff, dispositionDecision: 'RETAIN' })).toBeUndefined();
  expect(symmyRetentionTargetForPrivacyHandoff({ ...handoff, kind: 'RECTIFY' })).toBeUndefined();
});

it('requires explicit target absence and a concrete governance company in external policy configuration', () => {
  const encoded = {
    governanceLegalEntityId: id,
    policyId: 'internal-retention',
    retentionMs: 60_000,
    revision: 'v1',
    routeId: id,
    targetLegalEntityId: null,
    tenantId: id,
  };
  const decode = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema);
  const encode = Schema.encodeSync(SymmyJobRetentionPolicySchema);
  const tenantPolicy = decode(encoded);
  expect(Option.isNone(tenantPolicy.targetLegalEntityId)).toBe(true);
  expect(encode(tenantPolicy)).toEqual(encoded);
  const companyPolicy = decode({ ...encoded, targetLegalEntityId: id });
  expect(Option.getOrNull(companyPolicy.targetLegalEntityId)).toBe(id);
  expect(encode(companyPolicy)).toEqual({ ...encoded, targetLegalEntityId: id });
  const { targetLegalEntityId: _target, ...missingTarget } = encoded;
  const { governanceLegalEntityId: _governance, ...missingGovernance } = encoded;
  expect(() => decode(missingTarget)).toThrow();
  expect(() => decode(missingGovernance)).toThrow();
});
