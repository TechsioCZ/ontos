import { randomUUID } from 'node:crypto';

import type { Effect as EffectType } from 'effect';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryBackendConfigurationPersistenceUnavailable } from '../../shared/domain/inventory-backend-configuration-persistence-unavailable.ts';
import {
  StockPositionRejected,
  StockPositionSchema,
  deriveReservedQuantity,
  endStockPosition,
  recordOnHandEvidence,
} from '../../shared/domain/stock-position.ts';
import type {
  CreateStockPositionInput,
  CurrentSuccessfulAllocationQuantity,
  StockPosition,
  StockPositionOnHandEvidence,
  StockPositionReservedEvidence,
} from '../../shared/domain/stock-position.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';
import type {
  StockPositionPersistence,
  StockPositionPersistenceUnavailable,
} from '../persistence/stock-position-repository.ts';
import type { InventoryBackendConfigurationPersistence } from '../persistence/inventory-backend-configuration-repository.ts';
import type { StockPositionAllocationReadUnavailable } from './stock-position-allocation-read-unavailable.ts';

/**
 * Narrow future-allocation seam. #820 consumes only already-established Current successful
 * quantities and does not own Reservation or Allocation lifecycle behavior.
 */
export interface CurrentSuccessfulStockAllocationReader {
  readonly readCurrentSuccessful: (
    positionRef: StockPositionRef,
  ) => EffectType.Effect<readonly CurrentSuccessfulAllocationQuantity[], StockPositionAllocationReadUnavailable>;
}

type SelectedInventoryBackendConfigurationReader = Pick<InventoryBackendConfigurationPersistence, 'findCurrent'>;

type StockPositionServiceError =
  | InventoryBackendConfigurationPersistenceUnavailable
  | StockPositionAllocationReadUnavailable
  | StockPositionPersistenceUnavailable
  | StockPositionRejected;

const notFound = (ref: StockPositionRef) =>
  new StockPositionRejected({ code: 'stock_position_rejected', positionRef: ref, reason: 'POSITION_NOT_FOUND' });

const invalid = (input: CreateStockPositionInput, cause: unknown) => {
  const failure = new StockPositionRejected({
    code: 'stock_position_rejected',
    positionRef: {
      moduleId: 'commerce.inventory',
      resourceId: '00000000-0000-4000-8000-000000000000',
      resourceType: 'commerce.inventory.stock-position',
      tenantId: input.scope.stockItemRef.tenantId,
    },
    reason: 'INVALID_POSITION',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const ownerMismatch = (position: StockPosition) =>
  new StockPositionRejected({
    code: 'stock_position_rejected',
    positionRef: position.ref,
    reason: 'OWNER_CONFIGURATION_MISMATCH',
  });

const isSelectedOwner = (position: StockPosition, configuration: InventoryBackendConfiguration): boolean => {
  const configurationId = String(configuration.configurationId);
  const ownerConfigurationId = String(position.onHand.ownerConfigurationRef.resourceId);

  return (
    configuration.tenantId === position.ref.tenantId &&
    configuration.customerConfigurationId === position.scope.customerConfigurationId &&
    configurationId === ownerConfigurationId
  );
};

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- Core supplies this transaction-scoped owner service through the generated factory; it has no independent runtime Context identity; expires: 2027-03-31.
export interface StockPositionServiceContract {
  readonly end: (ref: StockPositionRef, endedAt: string) => EffectType.Effect<StockPosition, StockPositionServiceError>;
  readonly establish: (input: CreateStockPositionInput) => EffectType.Effect<StockPosition, StockPositionServiceError>;
  readonly read: (ref: StockPositionRef) => EffectType.Effect<
    {
      readonly position: StockPosition;
      readonly reserved: StockPositionReservedEvidence;
    },
    StockPositionServiceError
  >;
  readonly recordOnHand: (
    ref: StockPositionRef,
    onHand: StockPositionOnHandEvidence,
  ) => EffectType.Effect<StockPosition, StockPositionServiceError>;
}

export interface StockPositionServiceDependencies {
  readonly allocationReader: CurrentSuccessfulStockAllocationReader;
  readonly backendConfigurationReader: SelectedInventoryBackendConfigurationReader;
  readonly persistence: StockPositionPersistence;
}

/** Owner-local orchestration over one Core-installed transaction scope. */
// oxlint-disable-next-line effect-native/no-dependency-parameters, effect-native/no-wide-factory-signature -- The generated Core transaction factory supplies these owner-local collaborators together; expires: 2027-03-31.
export const makeStockPositionService = ({
  allocationReader,
  backendConfigurationReader,
  persistence,
}: StockPositionServiceDependencies): StockPositionServiceContract => {
  const assertSelectedOwner = (position: StockPosition) =>
    backendConfigurationReader.findCurrent(position.scope.customerConfigurationId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(ownerMismatch(position)),
          onSome: (configuration) =>
            isSelectedOwner(position, configuration) ? Effect.void : Effect.fail(ownerMismatch(position)),
        }),
      ),
    );

  const readPosition = Effect.fn('StockPositionService.readPosition')(function* readCurrentOwnerPosition(
    ref: StockPositionRef,
  ) {
    const position = yield* persistence.read(ref).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(notFound(ref)),
          onSome: Effect.succeed,
        }),
      ),
    );
    yield* assertSelectedOwner(position);
    return position;
  });

  const establish: StockPositionServiceContract['establish'] = Effect.fn('StockPositionService.establish')(
    function* establishStockPosition(input) {
      const current = yield* persistence.findCurrent(input.scope);
      if (Option.isSome(current)) {
        return yield* new StockPositionRejected({
          code: 'stock_position_rejected',
          positionRef: current.value.ref,
          reason: 'POSITION_SCOPE_ALREADY_CURRENT',
        });
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const candidate = yield* Schema.decodeEffect(StockPositionSchema)({
        createdAt,
        endedAt: null,
        lifecycle: 'CURRENT',
        onHand: input.onHand,
        ref: {
          moduleId: 'commerce.inventory',
          resourceId: randomUUID(),
          resourceType: 'commerce.inventory.stock-position',
          tenantId: input.scope.stockItemRef.tenantId,
        },
        revision: 1,
        scope: input.scope,
      }).pipe(Effect.mapError((cause) => invalid(input, cause)));
      yield* assertSelectedOwner(candidate);
      return yield* persistence.create(candidate);
    },
  );

  const read: StockPositionServiceContract['read'] = Effect.fn('StockPositionService.read')(
    function* readStockPosition(ref) {
      const position = yield* readPosition(ref);
      if (position.lifecycle === 'HISTORICAL') {
        const reserved = yield* deriveReservedQuantity(position, []);
        return { position, reserved };
      }
      const allocations = yield* allocationReader.readCurrentSuccessful(position.ref);
      const reserved = yield* deriveReservedQuantity(position, allocations);
      return { position, reserved };
    },
  );

  const recordOnHand: StockPositionServiceContract['recordOnHand'] = Effect.fn('StockPositionService.recordOnHand')(
    function* saveOnHand(ref, onHand) {
      const current = yield* readPosition(ref);
      const next = yield* recordOnHandEvidence(current, onHand);
      yield* assertSelectedOwner(next);
      return yield* persistence.save({ expectedRevision: current.revision, next });
    },
  );

  const end: StockPositionServiceContract['end'] = Effect.fn('StockPositionService.end')(
    function* endCurrentPosition(ref, endedAt) {
      const current = yield* readPosition(ref);
      const next = yield* endStockPosition(current, endedAt);
      return yield* persistence.save({ expectedRevision: current.revision, next });
    },
  );

  return Object.freeze({ end, establish, read, recordOnHand });
};
