import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { seedSourceProcessingNativeFixture } from '../support/source-processing-native.ts';
import {
  SourceProcessingGovernanceNativeError,
  retireSourceProcessingNativePurpose,
} from '../support/source-processing-governance-native.ts';
import { ProcessingPurposeRefSchema } from '../../shared/resources/processing-purpose.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.live(
  'retires only the genuine exact source fixture purpose without modifying its version, basis, or decisions',
  () =>
    Effect.gen(function* nativeSourcePurposeControl() {
      const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy']);
      const ownedDatabase = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot,
        mode: 'schema-only',
        purpose: 'implementation-1096-registered-workload-gateway',
      });
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      const legalEntityId = yield* crypto.randomUUIDv4();
      const governancePrincipalId = yield* crypto.randomUUIDv4();
      const source = yield* seedSourceProcessingNativeFixture({
        connections: ownedDatabase.connections,
        contexts: [
          {
            authMethod: 'session',
            principalId: governancePrincipalId,
            request: {
              consumerModuleId: 'party.registry',
              operation: 'CREATE',
              source: {
                issuer: 'internal:fixture',
                namespace: 'clients',
                occurrenceId: 'one',
                recordId: 'one',
                recordType: 'customer',
                routeRef: 'route:one',
              },
              target: null,
            },
          },
        ],
        contractEvidenceRef: 'internal:explicit-contract-fixture',
        controllerRef: legalEntityId,
        dataCategoryRefs: ['party:name'],
        governancePrincipalId,
        legalEntityId,
        meaning: 'Explicit internal source-processing fixture governance only',
        tenantId,
      });
      const purposeRef = yield* Schema.decodeUnknownEffect(ProcessingPurposeRefSchema)(source.purposeRef);
      const input = {
        connections: ownedDatabase.connections,
        governancePrincipalId,
        legalEntityId,
        ownedDatabase,
        purpose: 'implementation-1096-registered-workload-gateway' as const,
        purposeRef,
        tenantId,
      };
      const client = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
      const before = yield* client`select
      (select jsonb_agg(to_jsonb(p) order by purpose_version_id) from privacy.purpose_versions p where tenant_id=${tenantId}::uuid) as versions,
      (select jsonb_agg(to_jsonb(b) order by assignment_ref) from privacy.legal_basis_assignments b where tenant_id=${tenantId}::uuid) as bases,
      (select jsonb_agg(to_jsonb(d) order by decision_id) from privacy.applicability_decisions d where tenant_id=${tenantId}::uuid) as decisions`;

      const wrongInputs = [
        { ...input, governancePrincipalId: legalEntityId },
        { ...input, legalEntityId: tenantId },
        { ...input, ownedDatabase: { ...ownedDatabase } },
        {
          ...input,
          connections: {
            ...input.connections,
            runtime: { ...input.connections.runtime, connectionString: 'postgres://invalid@127.0.0.1:1/ontos' },
          },
        },
      ];
      for (const candidate of wrongInputs) {
        expect(
          Schema.is(SourceProcessingGovernanceNativeError)(
            yield* Effect.flip(retireSourceProcessingNativePurpose(candidate)),
          ),
        ).toBe(true);
      }
      const controlId = yield* crypto.randomUUIDv4();
      yield* client`insert into privacy.processing_purposes (processing_purpose_id,tenant_id,legal_entity_id,business_code,governance_owner_id,lifecycle)
      values (${controlId}::uuid,${tenantId}::uuid,${legalEntityId}::uuid,'NON_FIXTURE_CONTROL',${governancePrincipalId}::uuid,'ACTIVE')`;
      const controlRef = yield* Schema.decodeUnknownEffect(ProcessingPurposeRefSchema)({
        ...source.purposeRef,
        resourceId: controlId,
      });
      expect(
        Schema.is(SourceProcessingGovernanceNativeError)(
          yield* Effect.flip(retireSourceProcessingNativePurpose({ ...input, purposeRef: controlRef })),
        ),
      ).toBe(true);
      const retired = yield* retireSourceProcessingNativePurpose(input);
      expect(retired).toMatchObject({ changed: true, lifecycle: 'RETIRED', purposeRef: source.purposeRef });
      expect(yield* retireSourceProcessingNativePurpose(input)).toEqual({ ...retired, changed: false });
      const state =
        yield* client`select lifecycle,retired_at from privacy.processing_purposes where tenant_id=${tenantId}::uuid and legal_entity_id=${legalEntityId}::uuid and processing_purpose_id=${source.purposeRef.resourceId}::uuid`;
      expect(state).toEqual([{ lifecycle: 'RETIRED', retired_at: new Date(retired.retiredAt) }]);
      expect(
        yield* client`select lifecycle,retired_at from privacy.processing_purposes where processing_purpose_id=${controlId}::uuid`,
      ).toEqual([{ lifecycle: 'ACTIVE', retired_at: null }]);
      const after = yield* client`select
      (select jsonb_agg(to_jsonb(p) order by purpose_version_id) from privacy.purpose_versions p where tenant_id=${tenantId}::uuid) as versions,
      (select jsonb_agg(to_jsonb(b) order by assignment_ref) from privacy.legal_basis_assignments b where tenant_id=${tenantId}::uuid) as bases,
      (select jsonb_agg(to_jsonb(d) order by decision_id) from privacy.applicability_decisions d where tenant_id=${tenantId}::uuid) as decisions`;
      expect(after).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(nativeServices), Effect.provide(Reactivity.layer)),
);
