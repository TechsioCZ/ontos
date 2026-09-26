import { Duration, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';

import {
  InventoryBackendConfigurationSchema,
  SelectInventoryBackendPayloadSchema,
  SelectInventoryBackendResultSchema,
  dispatchReservationAuthority,
} from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import type {
  InventorySourceConflict,
  InventorySourceConflictOpen,
} from '../../shared/domain/inventory-source-conflict.ts';
import { InventoryBackendSelectionRejected } from '../../shared/domain/inventory-backend-selection-rejected.ts';
import type { InventoryBackendConfigurationPersistence } from '../../src/persistence/inventory-backend-configuration-repository.ts';
import { makeInventoryBackendConfigurationService } from '../../src/services/inventory-backend-configuration.service.ts';
import { makeInventorySourceConflictService } from '../../src/services/inventory-source-conflict.service.ts';
import {
  handleSelectInventoryBackend,
  selectInventoryBackendAction,
} from '../../src/actions/select-inventory-backend.action.ts';
import { inventoryBackendConfigurationCurrentRead } from '../../src/api/inventory-backend-configuration-current.read.ts';

const tenantId = '0199ffff-ffff-7fff-bfff-ffffffffffff';
const customerConfigurationId = 'customer-configuration-1';
const decodePayload = Schema.decodeUnknownSync(SelectInventoryBackendPayloadSchema);
const decodeConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema);
const authorizationTargetRef = {
  moduleId: 'commerce.inventory',
  resourceId: '0199ffff-ffff-7fff-bfff-fffffffffffe',
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
} as const;

const externalPayload = decodePayload({
  authorizationTargetRef,
  customerConfigurationId,
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-primary',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'UNSUPPORTED',
  },
});

const configuration = decodeConfiguration({
  configurationId: '0199ffff-ffff-7fff-bfff-fffffffffffe',
  customerConfigurationId,
  revision: 1,
  selectedAt: '2026-09-24T10:00:00.000Z',
  selection: externalPayload.selection,
  tenantId,
});

const makeMemoryPersistence = () => {
  let current = Option.none<InventoryBackendConfiguration>();
  const persistence: InventoryBackendConfigurationPersistence = {
    findCurrent: () => Effect.succeed(current),
    insertInitial: (candidate) => {
      current = Option.some(candidate);
      return Effect.succeed({ configuration: candidate, outcome: 'INSERTED' as const });
    },
  };
  return persistence;
};

describe('Inventory Backend configuration', () => {
  it('requires Inventory Migration permission for the exact configuration target', () => {
    const scope = trustVerifiedGatewayPrincipalContext({
      authBindingId: '0199ffff-ffff-7fff-bfff-fffffffffffd',
      authContextRef: 'test:inventory-backend-configuration',
      authMethod: 'api_key',
      correlationId: 'inventory-backend-configuration',
      principalId: '0199ffff-ffff-7fff-bfff-fffffffffffc',
      tenantId,
    });

    expect(getActionBusinessPermissionTargetResolver(selectInventoryBackendAction)?.(externalPayload, scope)).toEqual({
      permission: 'inventory.migration.manage',
      target: {
        kind: 'inventory_resource',
        resource: {
          moduleId: authorizationTargetRef.moduleId,
          resourceId: authorizationTargetRef.resourceId,
          resourceType: authorizationTargetRef.resourceType,
        },
        tenantId,
      },
    });
  });

  it('accepts exactly one backend selection and rejects unsupported WMS capability claims', () => {
    expect(() =>
      decodePayload({
        authorizationTargetRef,
        customerConfigurationId,
        selection: [],
      }),
    ).toThrow();
    expect(() =>
      decodePayload({
        authorizationTargetRef,
        customerConfigurationId,
        selection: [externalPayload.selection, { ...externalPayload.selection, backendId: 'erp-secondary' }],
      }),
    ).toThrow();
    expect(() =>
      decodePayload({
        authorizationTargetRef,
        customerConfigurationId,
        selection: {
          backend: 'ontos_wms',
          backendId: 'ontos-wms-primary',
          exactReservationCapability: 'UNSUPPORTED',
          stockCorrectionCapability: 'SUPPORTED',
        },
      }),
    ).toThrow();
  });

  it('publishes tenant-level Action and governed read boundaries without legal-entity scope', () => {
    expect(selectInventoryBackendAction.descriptor).toMatchObject({
      actionKey: 'commerce.inventory.select-inventory-backend',
      idempotency: 'required',
      legalEntityScope: 'forbidden',
      owningModuleKey: 'commerce.inventory',
    });
    expect(inventoryBackendConfigurationCurrentRead.descriptor).toMatchObject({
      legalEntityScope: 'forbidden',
      readKey: 'commerce.inventory.api.inventory-backend-configuration-current',
    });
  });

  it.effect('creates one Customer Configuration-wide selection and replays the exact identity idempotently', () =>
    Effect.gen(function* createAndReplay() {
      const service = makeInventoryBackendConfigurationService(makeMemoryPersistence());

      const created = yield* service.select(externalPayload, tenantId);
      const replayed = yield* service.select(externalPayload, tenantId);

      expect(created.outcome).toBe('SELECTED');
      expect(created.configuration).toMatchObject({
        customerConfigurationId,
        revision: 1,
        selection: externalPayload.selection,
        tenantId,
      });
      expect(replayed).toEqual({ configuration: created.configuration, outcome: 'EXACT_REPLAY' });
    }),
  );

  it.effect('rejects a target that does not match the current configuration before mutation', () =>
    Effect.gen(function* rejectMismatchedTarget() {
      let insertCount = 0;
      const persistence: InventoryBackendConfigurationPersistence = {
        findCurrent: () => Effect.succeedSome(configuration),
        insertInitial: () =>
          Effect.sync(() => {
            insertCount += 1;
            return { configuration, outcome: 'EXISTING' as const };
          }),
      };
      const failure = yield* makeInventoryBackendConfigurationService(persistence)
        .select(
          decodePayload({
            ...externalPayload,
            authorizationTargetRef: {
              ...externalPayload.authorizationTargetRef,
              resourceId: '0199ffff-ffff-7fff-bfff-fffffffffffb',
            },
          }),
          tenantId,
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'authorization_target_mismatch' });
      expect(insertCount).toBe(0);
    }),
  );

  it.effect('requires explicit cutover when the exact selected backend changes', () =>
    Effect.gen(function* rejectReplacement() {
      const persistence = makeMemoryPersistence();
      const service = makeInventoryBackendConfigurationService(persistence);
      yield* service.select(externalPayload, tenantId);

      const failure = yield* service
        .select(
          decodePayload({
            authorizationTargetRef,
            customerConfigurationId,
            selection: {
              backend: 'ontos_wms',
              backendId: 'ontos-wms-primary',
              exactReservationCapability: 'SUPPORTED',
              stockCorrectionCapability: 'SUPPORTED',
            },
          }),
          tenantId,
        )
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(InventoryBackendSelectionRejected);
      expect(failure).toMatchObject({
        code: 'inventory_backend_selection_rejected',
        fallbackApplied: false,
        reason: 'backend_change_requires_explicit_cutover',
      });
    }),
  );

  it.effect('durably records external plus WMS authority conflict without changing the selected backend', () =>
    Effect.gen(function* recordBackendConflict() {
      const persistence = makeMemoryPersistence();
      let stored = Option.none<InventorySourceConflict>();
      let appendCount = 0;
      const conflicts = makeInventorySourceConflictService({
        assertions: { findById: () => Effect.die('not used') },
        backendConfigurations: persistence,
        conflicts: {
          appendOpen: (conflict: InventorySourceConflictOpen) =>
            Effect.sync(() => {
              appendCount += 1;
              stored = Option.some(conflict);
              return conflict;
            }),
          appendResolution: () => Effect.die('not used'),
          findLatest: () => Effect.succeed(stored),
        },
        positions: { read: () => Effect.die('not used'), save: () => Effect.die('not used') },
      });
      const service = makeInventoryBackendConfigurationService(persistence, conflicts);
      const selected = yield* service.select(externalPayload, tenantId);
      const wmsPayload = decodePayload({
        authorizationTargetRef,
        customerConfigurationId,
        selection: {
          backend: 'ontos_wms',
          backendId: 'ontos-wms-primary',
          exactReservationCapability: 'SUPPORTED',
          stockCorrectionCapability: 'SUPPORTED',
        },
      });

      const context = {
        recordDataAccess: () => Effect.void,
        scope: { tenantId },
        services: service,
      };
      // @ts-expect-error Focused handler fixture implements only the successful non-establishing path exercised here.
      const result = yield* handleSelectInventoryBackend(wmsPayload, context);
      const { detectedAt } = Option.getOrThrow(stored);
      yield* TestClock.adjust(Duration.seconds(1));
      // @ts-expect-error Focused handler fixture implements only the successful non-establishing path exercised here.
      const replay = yield* handleSelectInventoryBackend(wmsPayload, context);

      expect(Schema.is(SelectInventoryBackendResultSchema)(result)).toBe(true);
      expect(result).toMatchObject({
        configuration: selected.configuration,
        fallbackApplied: false,
        outcome: 'BACKEND_CONFIGURATION_CONFLICT',
      });
      expect(replay).toEqual(result);
      expect(appendCount).toBe(1);
      expect(Option.getOrThrow(stored).detectedAt).toBe(detectedAt);
      expect(Option.getOrThrow(stored)).toMatchObject({
        conflictRef: result.outcome === 'BACKEND_CONFIGURATION_CONFLICT' ? result.conflictRef : undefined,
        conflictType: 'BACKEND_CONFIGURATION',
        currentTruth: 'INDETERMINATE',
        evidence: { attemptedSelection: wmsPayload.selection, selectedConfiguration: selected.configuration },
        status: 'OPEN',
      });
    }),
  );

  it.effect('dispatches the exact external owner without inserting OntOS WMS', () =>
    Effect.gen(function* dispatchExactOwner() {
      const dispatch = yield* dispatchReservationAuthority(configuration);

      expect(dispatch).toEqual({
        authority: {
          authorityMode: 'SINGLE_CUSTOMER_CONFIGURATION_BACKEND',
          customerConfigurationId,
          cutoverMode: 'EXPLICIT_ONLY',
          fallbackBackend: null,
          ownerAccess: 'DIRECT_EXTERNAL_OWNER_CONTRACT',
          physicalStockSystemOfRecord: 'external_business_system',
          reservationAuthority: 'external_business_system',
          selectedBackend: 'external_business_system',
        },
        backendId: 'erp-primary',
      });
    }),
  );

  it.effect('returns typed non-success and no proof when the selected backend cannot enforce exact Reservation', () =>
    Effect.gen(function* rejectUnsupportedGuarantee() {
      const unsupported = decodeConfiguration({
        ...configuration,
        selection: {
          backend: 'external_business_system',
          backendId: 'erp-observation-only',
          exactReservationCapability: 'UNSUPPORTED',
          stockCorrectionCapability: 'UNSUPPORTED',
        },
      });
      const failure = yield* dispatchReservationAuthority(unsupported).pipe(Effect.flip);

      expect(failure).toMatchObject({
        code: 'inventory_reservation_guarantee_unsupported',
        fallbackApplied: false,
        proofIssued: false,
        reason: 'selected_backend_does_not_support_required_guarantee',
        selectedBackendId: 'erp-observation-only',
      });
    }),
  );
});
