import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { fenceLegacyIcoAuthorityAction } from '../../src/actions/fence-legacy-ico-authority.action.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

const tenantId = 'dfb10000-0000-4000-8000-000000000001';
const principalId = 'dfb20000-0000-4000-8000-000000000001';
const proof = {
  tenantId,
  fenceId: 'dfb30000-0000-4000-8000-000000000001',
  snapshotVersion: 'a'.repeat(64),
  migrationPlanRef: 'internal-complete-inventory-plan',
  fencedAt: '2026-11-07T00:00:00.000Z',
};

it.effect(
  'native fence Action commits valid metadata-only whole-inventory evidence through the real Core collector',
  () =>
    Effect.gen(function* fenceCollectorBoundary() {
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        ownerRegistration: partyRegistryBackendRegistration,
        services: [
          bindActionTestServices(fenceLegacyIcoAuthorityAction, {
            fence: () => Effect.succeed(proof),
          }),
        ],
      });
      const result = yield* harness.runtime.runAction({
        registration: fenceLegacyIcoAuthorityAction,
        payload: { expectedSnapshotVersion: proof.snapshotVersion, migrationPlanRef: proof.migrationPlanRef },
        principal: {
          tenantId,
          principalId,
          authMethod: 'session',
          authBindingId: principalId,
          authContextRef: 'session:internal-fence-collector-fixture',
        },
        transport: { correlationId: 'internal-fence-collector-fixture', idempotencyKey: 'internal-fence-collector' },
      });
      expect(result).toEqual(proof);
      expect(harness.snapshot().committed).toHaveLength(1);
      expect(harness.snapshot().committed[0]?.evidence.dataAccessEvents).toEqual([
        {
          accessKind: 'read',
          evidenceCaptureMode: 'metadata_only',
          evidencePolicyKey: 'party.registry.fence-legacy-ico-authority.access.v1',
          queryHash: proof.snapshotVersion,
          resultCount: 1,
          servingModuleKey: 'party.registry',
        },
      ]);
    }),
);
