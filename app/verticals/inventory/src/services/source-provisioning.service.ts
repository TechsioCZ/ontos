import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import type { Effect as EffectType, Option as OptionType } from 'effect';
import { Crypto, DateTime, Effect, Match, Option, Schema } from 'effect';

import type { DefineSourceProvisioningPolicyPayload } from '../../shared/actions/define-source-provisioning-policy.ts';
import type { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import type {
  CatalogToStockBinding,
  CatalogToStockBindingCandidate,
  CatalogToStockBindingPersistence,
  CatalogToStockBindingRejected,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type { ExternalStockCorrelationPersistenceUnavailable } from '../../shared/domain/external-stock-correlation-persistence-unavailable.ts';
import type { ExternalStockCorrelationRejected } from '../../shared/domain/external-stock-correlation-rejected.ts';
import { ExternalStockKeySchema } from '../../shared/domain/external-stock-correlation.ts';
import type {
  EstablishExternalStockCorrelationInput,
  ExternalStockCorrelation,
  ExternalStockCorrelationPersistence,
  ExternalStockCorrelationPersistenceError,
  ExternalStockTarget,
} from '../../shared/domain/external-stock-correlation.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryBackendConfigurationPersistenceUnavailable } from '../../shared/domain/inventory-backend-configuration-persistence-unavailable.ts';
import type { SourceProvisioningConflictRef } from '../../shared/domain/source-provisioning-conflict-ref.ts';
import { SourceProvisioningPolicyRejected } from '../../shared/domain/source-provisioning-policy-rejected.ts';
import type { SourceProvisioningUnavailable } from '../../shared/domain/source-provisioning-unavailable.ts';
import { SourceStockItemProvisioningRejected } from '../../shared/domain/source-stock-item-provisioning-rejected.ts';
import { SourceProvisioningPolicySchema } from '../../shared/domain/source-provisioning.ts';
import type {
  ProvisionSourceStockItemInput,
  ProvisioningDisposition,
  SourceProvisioningPolicy,
  SourceStockItemProvisioning,
  SourceStockItemProvisioningInvocationId,
} from '../../shared/domain/source-provisioning.ts';
import type { StockItemPersistenceUnavailable } from '../../shared/domain/stock-item-persistence-unavailable.ts';
import { CreateStockItemInputSchema } from '../../shared/domain/stock-item.ts';
import type { StockItem, StockItemRejected } from '../../shared/domain/stock-item.ts';
import type { StockLocationPersistenceUnavailable } from '../../shared/domain/stock-location-persistence-unavailable.ts';
import { ActiveLifecycleSchema } from '../../shared/domain/stock-location.ts';
import type { StockPositionPersistenceUnavailable } from '../../shared/domain/stock-position-persistence-unavailable.ts';
import type { CreateStockPositionInput, StockPositionRejected } from '../../shared/domain/stock-position.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';
import type { InventoryBackendConfigurationPersistence } from '../persistence/inventory-backend-configuration-repository.ts';
import type {
  SourceProvisioningPolicyPersistence,
  SourceStockItemProvisioningReceiptPersistence,
} from '../persistence/source-provisioning-repository.ts';
import { sourceProvisioningUnavailable } from '../persistence/source-provisioning-repository.ts';
import type { StockLocationPersistenceRejected } from '../persistence/stock-location-persistence-rejected.ts';
import type { StockLocationPersistence } from '../persistence/stock-location-repository.ts';
import type { StockPositionPersistence } from '../persistence/stock-position-repository.ts';
import { stockItemRegistration } from './stock-item-service.ts';
import { stockPositionEstablishment } from './stock-position-service.ts';

type OwnerUnavailable =
  | CatalogToStockBindingUnavailable
  | ExternalStockCorrelationPersistenceUnavailable
  | InventoryBackendConfigurationPersistenceUnavailable
  | SourceProvisioningUnavailable
  | StockItemPersistenceUnavailable
  | StockLocationPersistenceUnavailable
  | StockPositionPersistenceUnavailable;

/** Every owner persistence failure means the same to a caller: nothing committed, retry the same input. */
const unavailableFrom = (failure: OwnerUnavailable): SourceProvisioningUnavailable =>
  sourceProvisioningUnavailable(failure);

const provisioningRejected = (
  reason: SourceStockItemProvisioningRejected['reason'],
  conflictRef?: SourceProvisioningConflictRef,
): SourceStockItemProvisioningRejected =>
  conflictRef === undefined
    ? new SourceStockItemProvisioningRejected({ code: 'source_stock_item_provisioning_rejected', reason })
    : new SourceStockItemProvisioningRejected({ code: 'source_stock_item_provisioning_rejected', conflictRef, reason });

const policyRejected = (
  reason: SourceProvisioningPolicyRejected['reason'],
  conflictRef?: SourceProvisioningConflictRef,
): SourceProvisioningPolicyRejected =>
  conflictRef === undefined
    ? new SourceProvisioningPolicyRejected({ code: 'source_provisioning_policy_rejected', reason })
    : new SourceProvisioningPolicyRejected({ code: 'source_provisioning_policy_rejected', conflictRef, reason });

/** Exact value equality of two owner records, independent of key order. */
const sameValue = <Value>(left: Value, right: Value): boolean =>
  computeCanonicalValueHash(left) === computeCanonicalValueHash(right);

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(
  Effect.mapError(sourceProvisioningUnavailable),
);
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

type Qualification = Pick<
  SourceProvisioningPolicy,
  'customerConfigurationId' | 'externalScope' | 'issuer' | 'namespace'
>;

const qualifiedKey = (
  qualification: Qualification,
  key: { readonly identifierKind: 'ITEM' | 'LOCATION'; readonly tenantId: string; readonly value: string },
) =>
  Schema.decodeUnknownEffect(ExternalStockKeySchema)({
    customerConfigurationId: qualification.customerConfigurationId,
    externalScope: qualification.externalScope,
    externalValue: key.value,
    identifierKind: key.identifierKind,
    issuer: qualification.issuer,
    namespace: qualification.namespace,
    tenantId: key.tenantId,
  }).pipe(Effect.mapError(sourceProvisioningUnavailable));

/** The owner correlation lifecycle's establishment, bound by the Action's service factory. */
export interface SourceProvisioningCorrelationEstablishment {
  readonly establish: (request: {
    readonly correlationResourceId: string;
    readonly input: EstablishExternalStockCorrelationInput;
  }) => EffectType.Effect<ExternalStockCorrelation, ExternalStockCorrelationPersistenceError>;
}

/** The owner binding lifecycle's establishment, bound by the Action's service factory. */
export interface SourceProvisioningBindingEstablishment {
  readonly establish: (request: {
    readonly bindingId: string;
    readonly candidate: CatalogToStockBindingCandidate;
  }) => EffectType.Effect<CatalogToStockBinding, CatalogToStockBindingRejected | CatalogToStockBindingUnavailable>;
}

/** The current correlations of a key and the owner lifecycle that establishes a new one. */
export interface SourceProvisioningCorrelations {
  readonly current: Pick<ExternalStockCorrelationPersistence, 'findEffective'>;
  readonly lifecycle: SourceProvisioningCorrelationEstablishment;
}

type CorrelationOutcome =
  | {
      readonly disposition: ProvisioningDisposition;
      readonly ref: SourceStockItemProvisioning['itemCorrelation']['ref'];
    }
  | { readonly conflict: SourceStockItemProvisioning['itemCorrelation']['ref'] };

/**
 * Makes the qualified ERP key correlate to exactly `target` from `effectiveFrom`: an exactly matching Current
 * correlation is adopted, none is established through the owner lifecycle, and one to any other target is a conflict.
 */
const ensureCorrelation = Effect.fn('SourceProvisioning.ensureCorrelation')(function* ensureCorrelation(
  correlations: SourceProvisioningCorrelations,
  request: {
    readonly effectiveFrom: string;
    readonly identifierKind: 'ITEM' | 'LOCATION';
    readonly qualification: Qualification;
    readonly target: ExternalStockTarget;
    readonly tenantId: string;
    readonly value: string;
  },
): EffectType.fn.Return<
  CorrelationOutcome,
  ExternalStockCorrelationPersistenceUnavailable | ExternalStockCorrelationRejected | SourceProvisioningUnavailable,
  Crypto.Crypto
> {
  const externalKey = yield* qualifiedKey(request.qualification, request);
  const current = yield* correlations.current.findEffective(externalKey, yield* nowIso);
  const [existing] = current;
  if (existing !== undefined) {
    return current.length === 1 && sameValue(existing.target, request.target)
      ? { disposition: 'ADOPTED', ref: existing.correlationRef }
      : { conflict: existing.correlationRef };
  }
  const correlationResourceId = yield* nextId;
  const established = yield* correlations.lifecycle.establish({
    correlationResourceId,
    input: {
      effectiveFrom: request.effectiveFrom,
      externalKey,
      ownerEvidenceRef: `inventory-source:${computeCanonicalValueHash(externalKey)}`,
      target: request.target,
    },
  });
  return { disposition: 'ESTABLISHED', ref: established.correlationRef };
});

/** The owner records one policy definition reads and writes, all inside one Core transaction. */
export interface SourceProvisioningPolicyPorts {
  readonly configurations: Pick<InventoryBackendConfigurationPersistence, 'findCurrent'>;
  readonly correlations: SourceProvisioningCorrelations;
  readonly locations: Pick<StockLocationPersistence, 'read'>;
  readonly policies: Pick<
    SourceProvisioningPolicyPersistence,
    'findByOwnerConfiguration' | 'insert' | 'lockOwnerConfiguration'
  >;
}

type PolicyDefinitionFailure =
  | ExternalStockCorrelationPersistenceUnavailable
  | ExternalStockCorrelationRejected
  | InventoryBackendConfigurationPersistenceUnavailable
  | SourceProvisioningPolicyRejected
  | SourceProvisioningUnavailable
  | StockLocationPersistenceRejected
  | StockLocationPersistenceUnavailable;

const mapPolicyDefinitionFailure = (
  failure: PolicyDefinitionFailure,
): SourceProvisioningPolicyRejected | SourceProvisioningUnavailable =>
  Match.value(failure).pipe(
    Match.tags({
      ExternalStockCorrelationPersistenceUnavailable: unavailableFrom,
      ExternalStockCorrelationRejected: ({ correlationRef, reason }) =>
        reason === 'TENANT_SCOPE_MISMATCH'
          ? policyRejected('TENANT_SCOPE_MISMATCH')
          : policyRejected('LOCATION_CORRELATION_CONFLICT', correlationRef),
      InventoryBackendConfigurationPersistenceUnavailable: unavailableFrom,
      SourceProvisioningPolicyRejected: (rejected) => rejected,
      SourceProvisioningUnavailable: (unavailable) => unavailable,
      StockLocationPersistenceRejected: ({ locationRef, reason }) =>
        reason === 'TENANT_SCOPE_MISMATCH'
          ? policyRejected('TENANT_SCOPE_MISMATCH')
          : policyRejected('STOCK_LOCATION_NOT_FOUND', locationRef),
      StockLocationPersistenceUnavailable: unavailableFrom,
    }),
    Match.exhaustive,
  );

const policyContent = (policy: Omit<SourceProvisioningPolicy, 'definedAt' | 'policyRef'>) => ({
  customerConfigurationId: policy.customerConfigurationId,
  effectiveFrom: policy.effectiveFrom,
  externalScope: policy.externalScope,
  issuer: policy.issuer,
  locations: policy.locations.toSorted((left, right) => left.locationKey.localeCompare(right.locationKey)),
  namespace: policy.namespace,
  ownerConfigurationRef: policy.ownerConfigurationRef,
  unitRef: policy.unitRef,
});

const correlateAllowedLocation = Effect.fn('SourceProvisioningPolicy.correlateLocation')(function* correlateLocation(
  ports: SourceProvisioningPolicyPorts,
  request: {
    readonly candidate: Omit<SourceProvisioningPolicy, 'definedAt' | 'policyRef'>;
    readonly location: SourceProvisioningPolicy['locations'][number];
    readonly tenantId: string;
  },
) {
  const { candidate, location, tenantId } = request;
  const stored = yield* ports.locations.read(location.stockLocationRef);
  if (Option.isNone(stored)) {
    return yield* policyRejected('STOCK_LOCATION_NOT_FOUND', location.stockLocationRef);
  }
  if (!Schema.is(ActiveLifecycleSchema)(stored.value.lifecycle)) {
    return yield* policyRejected('STOCK_LOCATION_NOT_ACTIVE', location.stockLocationRef);
  }
  const correlation = yield* ensureCorrelation(ports.correlations, {
    effectiveFrom: candidate.effectiveFrom,
    identifierKind: 'LOCATION',
    qualification: candidate,
    target: { _tag: 'STOCK_LOCATION', ref: location.stockLocationRef },
    tenantId,
    value: location.locationKey,
  });
  return 'conflict' in correlation
    ? yield* policyRejected('LOCATION_CORRELATION_CONFLICT', correlation.conflict)
    : correlation;
});

/**
 * Records the one provisioning policy of an external Inventory Backend configuration. Each allowed location gets its
 * LOCATION correlation (adopted when it already names that exact Stock Location). An identical repeat is an exact
 * replay; any other content for a backend that already has a policy is refused naming it.
 */
export const recordSourceProvisioningPolicy = Effect.fn('SourceProvisioningPolicy.record')(
  function* recordSourceProvisioningPolicy(
    ports: SourceProvisioningPolicyPorts,
    request: { readonly input: DefineSourceProvisioningPolicyPayload; readonly tenantId: string },
  ) {
    const { input, tenantId } = request;
    if (
      input.ownerConfigurationRef.tenantId !== tenantId ||
      input.unitRef.tenantId !== tenantId ||
      input.locations.some(({ stockLocationRef }) => stockLocationRef.tenantId !== tenantId)
    ) {
      return yield* policyRejected('TENANT_SCOPE_MISMATCH');
    }
    yield* ports.policies.lockOwnerConfiguration(input.ownerConfigurationRef.resourceId);
    const configuration = yield* ports.configurations.findCurrent(input.customerConfigurationId);
    if (
      Option.isNone(configuration) ||
      configuration.value.configurationId !== input.ownerConfigurationRef.resourceId ||
      configuration.value.tenantId !== input.ownerConfigurationRef.tenantId ||
      DateTime.toEpochMillis(DateTime.makeUnsafe(configuration.value.selectedAt)) >
        DateTime.toEpochMillis(DateTime.makeUnsafe(yield* nowIso))
    ) {
      return yield* policyRejected('OWNER_CONFIGURATION_NOT_FOUND', input.ownerConfigurationRef);
    }
    const { selectedAt, selection } = configuration.value;
    if (selection.backend !== 'external_business_system') {
      return yield* policyRejected('OWNER_CONFIGURATION_NOT_EXTERNAL', input.ownerConfigurationRef);
    }
    const candidate = policyContent({
      customerConfigurationId: input.customerConfigurationId,
      effectiveFrom: selectedAt,
      externalScope: input.externalScope,
      issuer: { backendId: selection.backendId, backendKind: selection.backend },
      locations: input.locations,
      namespace: input.namespace,
      ownerConfigurationRef: input.ownerConfigurationRef,
      unitRef: input.unitRef,
    });
    const replayOrConflict = (existing: SourceProvisioningPolicy) =>
      sameValue(policyContent(existing), candidate)
        ? Effect.succeed({ outcome: 'EXACT_REPLAY' as const, policy: existing })
        : Effect.fail(policyRejected('POLICY_ALREADY_DEFINED', existing.policyRef));
    const existing = yield* ports.policies.findByOwnerConfiguration(input.ownerConfigurationRef.resourceId);
    if (Option.isSome(existing)) {
      return yield* replayOrConflict(existing.value);
    }
    yield* Effect.forEach(
      candidate.locations,
      (location) => correlateAllowedLocation(ports, { candidate, location, tenantId }),
      { concurrency: 1, discard: true },
    );
    const policy = yield* Schema.decodeUnknownEffect(SourceProvisioningPolicySchema)({
      ...candidate,
      definedAt: yield* nowIso,
      policyRef: {
        moduleId: 'commerce.inventory',
        resourceId: yield* nextId,
        resourceType: 'commerce.inventory.source-provisioning-policy',
        tenantId,
      },
    }).pipe(Effect.mapError(sourceProvisioningUnavailable));
    const stored = yield* ports.policies.insert(policy);
    return stored.outcome === 'INSERTED'
      ? { outcome: 'DEFINED' as const, policy: stored.policy }
      : yield* replayOrConflict(stored.policy);
  },
  (effect) => effect.pipe(Effect.mapError(mapPolicyDefinitionFailure)),
);

/** The policy never overrides the backend owner's selection or its effective date. */
export const sourceProvisioningPolicyHasCurrentOwner = (
  policy: SourceProvisioningPolicy,
  configuration: InventoryBackendConfiguration,
  asOf: string,
): boolean =>
  configuration.tenantId === policy.policyRef.tenantId &&
  configuration.customerConfigurationId === policy.customerConfigurationId &&
  configuration.configurationId === policy.ownerConfigurationRef.resourceId &&
  configuration.selection.backend === policy.issuer.backendKind &&
  configuration.selection.backendId === policy.issuer.backendId &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(configuration.selectedAt)) ===
    DateTime.toEpochMillis(DateTime.makeUnsafe(policy.effectiveFrom)) &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(policy.effectiveFrom)) <=
    DateTime.toEpochMillis(DateTime.makeUnsafe(asOf));

/** The Stock Item reads and the registration insert provisioning composes. */
export interface SourceProvisioningStockItems {
  readonly findByExactSelectionMeaning: (
    tenantId: string,
    exactSelectionMeaningId: StockItem['exactSelectionMeaning']['id'],
  ) => EffectType.Effect<OptionType.Option<StockItem>, StockItemPersistenceUnavailable>;
  readonly findById: (
    tenantId: string,
    stockItemId: string,
  ) => EffectType.Effect<OptionType.Option<StockItem>, StockItemPersistenceUnavailable>;
  readonly insert: (
    item: StockItem,
  ) => EffectType.Effect<StockItem, StockItemPersistenceUnavailable | StockItemRejected>;
}

/** The owner records one ERP item provisioning reads and writes, all inside one Core transaction. */
export interface SourceStockItemProvisioningPorts {
  readonly bindingLifecycle: SourceProvisioningBindingEstablishment;
  readonly bindings: Pick<CatalogToStockBindingPersistence, 'findCurrentByExactSelectionMeaning'>;
  readonly configurations: Pick<InventoryBackendConfigurationPersistence, 'findCurrent'>;
  readonly correlations: SourceProvisioningCorrelations;
  readonly policies: Pick<SourceProvisioningPolicyPersistence, 'findByRef' | 'lockOwnerConfiguration'>;
  readonly positions: StockPositionPersistence;
  readonly receipts: SourceStockItemProvisioningReceiptPersistence;
  readonly stockItems: SourceProvisioningStockItems;
}

type ProvisioningFailure =
  | CatalogToStockBindingRejected
  | CatalogToStockBindingUnavailable
  | ExternalStockCorrelationPersistenceUnavailable
  | ExternalStockCorrelationRejected
  | InventoryBackendConfigurationPersistenceUnavailable
  | SourceProvisioningUnavailable
  | SourceStockItemProvisioningRejected
  | StockItemPersistenceUnavailable
  | StockItemRejected
  | StockPositionPersistenceUnavailable
  | StockPositionRejected;

const mapPositionRejection = ({ positionRef, reason }: StockPositionRejected) =>
  Match.value(reason).pipe(
    Match.whenOr('STOCK_LOCATION_NOT_ACTIVE', 'STOCK_LOCATION_NOT_FOUND', () =>
      provisioningRejected('STOCK_LOCATION_NOT_ACTIVE', positionRef),
    ),
    Match.when('OWNER_CONFIGURATION_MISMATCH', () => provisioningRejected('BACKEND_CONFLICT', positionRef)),
    Match.when('STOCK_UNIT_MISMATCH', () => provisioningRejected('STOCK_UNIT_CONFLICT', positionRef)),
    Match.when('TENANT_SCOPE_MISMATCH', () => provisioningRejected('TENANT_SCOPE_MISMATCH')),
    // A concurrent retirement or revision race: nothing committed, and a retry decides again.
    Match.orElse(() => sourceProvisioningUnavailable(reason)),
  );

const mapProvisioningFailure = (
  failure: ProvisioningFailure,
): SourceProvisioningUnavailable | SourceStockItemProvisioningRejected =>
  Match.value(failure).pipe(
    Match.tags({
      CatalogToStockBindingRejected: ({ bindingRef, stockItemRef }) =>
        provisioningRejected('BINDING_CONFLICT', bindingRef ?? stockItemRef),
      CatalogToStockBindingUnavailable: unavailableFrom,
      ExternalStockCorrelationPersistenceUnavailable: unavailableFrom,
      ExternalStockCorrelationRejected: ({ correlationRef, reason }) =>
        reason === 'TENANT_SCOPE_MISMATCH'
          ? provisioningRejected('TENANT_SCOPE_MISMATCH')
          : provisioningRejected('ITEM_CORRELATION_CONFLICT', correlationRef),
      InventoryBackendConfigurationPersistenceUnavailable: unavailableFrom,
      SourceProvisioningUnavailable: (unavailable) => unavailable,
      SourceStockItemProvisioningRejected: (rejected) => rejected,
      StockItemPersistenceUnavailable: unavailableFrom,
      StockItemRejected: (rejection) =>
        rejection.reason === 'stock_unit_mismatch'
          ? provisioningRejected('STOCK_UNIT_CONFLICT')
          : sourceProvisioningUnavailable(rejection),
      StockPositionPersistenceUnavailable: unavailableFrom,
      StockPositionRejected: mapPositionRejection,
    }),
    Match.exhaustive,
  );

interface ProvisionedStockItem {
  readonly disposition: ProvisioningDisposition;
  readonly item: StockItem;
}

const adoptStockItem = (
  item: StockItem,
  request: { readonly input: ProvisionSourceStockItemInput; readonly policy: SourceProvisioningPolicy },
): EffectType.Effect<ProvisionedStockItem, SourceStockItemProvisioningRejected> => {
  if (item.exactSelectionMeaning.kind !== request.input.exactSelectionMeaning.kind) {
    return Effect.fail(provisioningRejected('EXACT_SELECTION_MEANING_CONFLICT', item.stockItemRef));
  }
  return sameValue(item.unitRef, request.policy.unitRef)
    ? Effect.succeed({ disposition: 'ADOPTED', item })
    : Effect.fail(provisioningRejected('STOCK_UNIT_CONFLICT', item.stockItemRef));
};

/** A concurrent provisioning of the same meaning committed first: adopt the Item it registered. */
const adoptRegistrationWinner = Effect.fn('SourceStockItemProvisioning.adoptRegistrationWinner')(function* adoptWinner(
  ports: SourceStockItemProvisioningPorts,
  request: {
    readonly input: ProvisionSourceStockItemInput;
    readonly policy: SourceProvisioningPolicy;
    readonly rejection: StockItemRejected;
  },
): EffectType.fn.Return<ProvisionedStockItem, ProvisioningFailure> {
  const { rejection } = request;
  if (rejection.reason !== 'exact_selection_meaning_already_registered' || rejection.stockItemId === undefined) {
    return yield* rejection;
  }
  const winner = yield* ports.stockItems.findById(request.policy.policyRef.tenantId, rejection.stockItemId);
  return Option.isSome(winner)
    ? yield* adoptStockItem(winner.value, request)
    : yield* sourceProvisioningUnavailable(rejection);
});

const ensureStockItem = Effect.fn('SourceStockItemProvisioning.ensureStockItem')(function* ensureStockItem(
  ports: SourceStockItemProvisioningPorts,
  request: { readonly input: ProvisionSourceStockItemInput; readonly policy: SourceProvisioningPolicy },
): EffectType.fn.Return<ProvisionedStockItem, ProvisioningFailure, Crypto.Crypto> {
  const { input, policy } = request;
  const { tenantId } = policy.policyRef;
  const existing = yield* ports.stockItems.findByExactSelectionMeaning(tenantId, input.exactSelectionMeaning.id);
  if (Option.isSome(existing)) {
    return yield* adoptStockItem(existing.value, request);
  }
  const registration = yield* Schema.decodeUnknownEffect(CreateStockItemInputSchema)({
    exactSelectionMeaning: input.exactSelectionMeaning,
    tenantId,
    unitRef: policy.unitRef,
  }).pipe(Effect.mapError(sourceProvisioningUnavailable));
  const crypto = yield* Crypto.Crypto;
  return yield* stockItemRegistration(
    ports.stockItems,
    crypto,
  )(registration).pipe(
    Effect.map((item): ProvisionedStockItem => ({ disposition: 'ESTABLISHED', item })),
    Effect.catchTag('StockItemRejected', (rejection) => adoptRegistrationWinner(ports, { ...request, rejection })),
  );
});

const ensurePosition = Effect.fn('SourceStockItemProvisioning.ensurePosition')(function* ensurePosition(
  ports: SourceStockItemProvisioningPorts,
  request: {
    readonly item: StockItem;
    readonly location: SourceProvisioningPolicy['locations'][number];
    readonly policy: SourceProvisioningPolicy;
  },
): EffectType.fn.Return<SourceStockItemProvisioning['positions'][number], ProvisioningFailure, Crypto.Crypto> {
  const { item, location, policy } = request;
  const input: CreateStockPositionInput = {
    onHand: {
      _tag: 'UNKNOWN',
      meaning: 'ON_HAND',
      ownerConfigurationRef: policy.ownerConfigurationRef,
      unitRef: policy.unitRef,
    },
    scope: {
      customerConfigurationId: policy.customerConfigurationId,
      stockItemRef: item.stockItemRef,
      stockLocationRef: location.stockLocationRef,
      unitRef: policy.unitRef,
    },
  };
  const provisioned = (disposition: ProvisioningDisposition, positionRef: StockPositionRef) => ({
    disposition,
    locationKey: location.locationKey,
    positionRef,
    stockLocationRef: location.stockLocationRef,
  });
  // Locks the configuration, the Item and the Location first, so a concurrent provisioning waits and then adopts.
  yield* ports.positions.lockEstablishmentTargets(input);
  const current = yield* ports.positions.findCurrent(input.scope);
  if (Option.isSome(current)) {
    const position = current.value;
    if (!sameValue(position.onHand.ownerConfigurationRef, policy.ownerConfigurationRef)) {
      return yield* provisioningRejected('BACKEND_CONFLICT', position.ref);
    }
    return sameValue(position.scope.unitRef, policy.unitRef)
      ? provisioned('ADOPTED', position.ref)
      : yield* provisioningRejected('STOCK_UNIT_CONFLICT', position.ref);
  }
  const established = yield* stockPositionEstablishment(ports.positions, ports.configurations)(input);
  return provisioned('ESTABLISHED', established.ref);
});

const ensureBinding = Effect.fn('SourceStockItemProvisioning.ensureBinding')(function* ensureBinding(
  ports: SourceStockItemProvisioningPorts,
  request: { readonly input: ProvisionSourceStockItemInput; readonly item: StockItem },
): EffectType.fn.Return<SourceStockItemProvisioning['binding'], ProvisioningFailure, Crypto.Crypto> {
  const { input, item } = request;
  const current = yield* ports.bindings.findCurrentByExactSelectionMeaning(
    item.stockItemRef.tenantId,
    input.exactSelectionMeaning,
  );
  const [existing] = current;
  if (existing !== undefined) {
    return current.length === 1 &&
      sameValue(existing.stockItemRef, item.stockItemRef) &&
      sameValue(existing.catalogSelection, input.catalogSelection)
      ? { disposition: 'ADOPTED', ref: existing.bindingRef }
      : yield* provisioningRejected('BINDING_CONFLICT', existing.bindingRef);
  }
  const bindingId = yield* nextId;
  const binding = yield* ports.bindingLifecycle.establish({
    bindingId,
    candidate: {
      catalogSelection: input.catalogSelection,
      exactSelectionMeaning: input.exactSelectionMeaning,
      stockItem: item,
    },
  });
  return { disposition: 'ESTABLISHED', ref: binding.bindingRef };
});

/**
 * One ERP item under its backend's provisioning policy, in one transaction: the Stock Item of the exact Catalog
 * meaning, one Stock Position per allowed location, the ITEM correlation and the Catalog binding. Each part that
 * already exists with exactly this content is adopted; any other content is refused with a typed reason. A repeat
 * changes nothing and returns the same refs. The receipt of the invocation is stored with the result.
 */
export const provisionSourceStockItem = Effect.fn('SourceStockItemProvisioning.provision')(
  function* provisionSourceStockItem(
    ports: SourceStockItemProvisioningPorts,
    request: {
      readonly actionInvocationId: SourceStockItemProvisioningInvocationId;
      readonly input: ProvisionSourceStockItemInput;
    },
  ): EffectType.fn.Return<SourceStockItemProvisioning, ProvisioningFailure, Crypto.Crypto> {
    const { input } = request;
    const found = yield* ports.policies.findByRef(input.policyRef);
    if (Option.isNone(found)) {
      return yield* provisioningRejected('POLICY_NOT_FOUND', input.policyRef);
    }
    const policy = found.value;
    yield* ports.policies.lockOwnerConfiguration(policy.ownerConfigurationRef.resourceId);
    const original = yield* ports.receipts.findByInvocation(request.actionInvocationId);
    if (Option.isSome(original)) {
      return sameValue(original.value.input, input)
        ? original.value.provisioning
        : yield* sourceProvisioningUnavailable('Provisioning invocation already records different input');
    }
    const configuration = yield* ports.configurations.findCurrent(policy.customerConfigurationId);
    if (
      Option.isNone(configuration) ||
      !sourceProvisioningPolicyHasCurrentOwner(policy, configuration.value, yield* nowIso)
    ) {
      return yield* provisioningRejected('BACKEND_CONFLICT', policy.ownerConfigurationRef);
    }
    // An ended or corrected LOCATION correlation is an owner revocation, not a reason to recreate it.
    yield* Effect.forEach(
      policy.locations,
      Effect.fn('SourceStockItemProvisioning.requireLocation')(function* requireLocation(location) {
        const key = yield* qualifiedKey(policy, {
          identifierKind: 'LOCATION',
          tenantId: policy.policyRef.tenantId,
          value: location.locationKey,
        });
        const current = yield* ports.correlations.current.findEffective(key, yield* nowIso);
        const [correlation] = current;
        if (
          current.length !== 1 ||
          correlation === undefined ||
          !sameValue(correlation.target, { _tag: 'STOCK_LOCATION', ref: location.stockLocationRef })
        ) {
          return yield* provisioningRejected('STOCK_LOCATION_NOT_ACTIVE', location.stockLocationRef);
        }
        return yield* Effect.void;
      }),
      { concurrency: 1, discard: true },
    );
    const stockItem = yield* ensureStockItem(ports, { input, policy });
    const positions = yield* Effect.forEach(
      policy.locations,
      (location) => ensurePosition(ports, { item: stockItem.item, location, policy }),
      { concurrency: 1 },
    );
    const correlation = yield* ensureCorrelation(ports.correlations, {
      effectiveFrom: policy.effectiveFrom,
      identifierKind: 'ITEM',
      qualification: policy,
      target: { _tag: 'STOCK_ITEM', ref: stockItem.item.stockItemRef },
      tenantId: policy.policyRef.tenantId,
      value: input.itemKey,
    });
    if ('conflict' in correlation) {
      return yield* provisioningRejected('ITEM_CORRELATION_CONFLICT', correlation.conflict);
    }
    const binding = yield* ensureBinding(ports, { input, item: stockItem.item });
    const provisioning: SourceStockItemProvisioning = {
      binding,
      itemCorrelation: correlation,
      itemKey: input.itemKey,
      policyRef: policy.policyRef,
      positions,
      stockItem: { disposition: stockItem.disposition, ref: stockItem.item.stockItemRef },
    };
    yield* ports.receipts.append({
      actionInvocationId: request.actionInvocationId,
      input,
      provisioning,
      recordedAt: yield* nowIso,
    });
    return provisioning;
  },
  (effect) => effect.pipe(Effect.mapError(mapProvisioningFailure)),
);
