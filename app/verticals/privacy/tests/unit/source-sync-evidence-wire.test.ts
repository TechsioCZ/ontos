import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SourceSyncProcessingEvidenceSchema } from '../../shared/domain/source-sync-processing-policy.ts';

type DecodedEvidence = typeof SourceSyncProcessingEvidenceSchema.Type;
type DecodedTargetId = NonNullable<DecodedEvidence['target']>['resourceId'];
type AssertFalse<Check extends false> = Check;

export type PlainStringIsNotATargetId = AssertFalse<string extends DecodedTargetId ? true : false>;
export type SourceRecordIdIsNotATargetId = AssertFalse<
  DecodedEvidence['source']['recordId'] extends DecodedTargetId ? true : false
>;

const evidence = {
  _tag: 'SOURCE_SYNC_PROCESSING_POLICY',
  consumerModuleId: 'party.registry',
  dataUse: 'SOURCE_CUSTOMER_SYNC',
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  operation: 'CREATE',
  policyId: 'akros-symmy-source-sync-v2',
  policyRevision: 'v2',
  purpose: 'CUSTOMER_IMPORT',
  source: {
    issuer: 'symmy-akros',
    namespace: 'akros-erp',
    occurrenceId: ' source-occurrence ',
    recordId: ' source-record ',
    recordType: 'CUSTOMER',
    routeRef: '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1',
  },
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  trustedDecisionTime: '2026-11-23T12:00:00.000Z',
  validUntil: '2026-11-24T12:00:00.000Z',
};

it.effect('round-trips explicit absence and present opaque source-sync targets without normalizing identifiers', () =>
  Effect.gen(function* roundTrip() {
    for (const target of [null, { kind: 'PARTY', resourceId: ' party-owner-id ' }]) {
      const wire = { ...evidence, target };
      const decoded = yield* Schema.decodeUnknownEffect(SourceSyncProcessingEvidenceSchema)(wire);
      expect(decoded.target).toStrictEqual(target);
      expect(yield* Schema.encodeEffect(SourceSyncProcessingEvidenceSchema)(decoded)).toStrictEqual(wire);
    }
  }),
);

it.effect('rejects an omitted or undefined source-sync target', () =>
  Effect.gen(function* missingTarget() {
    const decode = Schema.decodeUnknownEffect(SourceSyncProcessingEvidenceSchema);
    expect(Result.isFailure(yield* Effect.result(decode(evidence)))).toBe(true);
    const undefinedTarget = Object.defineProperty({ ...evidence }, 'target', { enumerable: true });
    expect(Result.isFailure(yield* Effect.result(decode(undefinedTarget)))).toBe(true);
  }),
);
