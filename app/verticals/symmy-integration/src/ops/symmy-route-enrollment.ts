/**
 * Operator enrollment of one Symmy job route: every decision, without I/O.
 *
 * A route row (`symmy_integration.job_routes`) is the only authority the runtime reads for a Symmy route, and the
 * runtime role can only read it. This module decides what one enrollment of one route for one Tenant and company may
 * write, and why it refuses otherwise:
 *
 * - every route kind has an operation inventory except the stock route, which waits on its Inventory backend;
 * - the configuration names owner operations only (never an executable intent), each one in the route's inventory
 *   (what the route's admission plan and executor call and what its Shell dispatch reads), with every required one;
 * - an operation whose published call needs a company is never enrolled on a Tenant-only route;
 * - the routes of one source share the logical source identity their readers and writers compare;
 * - the lifecycle policy is one the retention configuration names for exactly this route;
 * - an exact replay changes nothing, any other difference is refused unless the operator asks to replace the route,
 *   and a replacement is refused while the route has outstanding work.
 */
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Option, Schema } from 'effect';

import { SymmyRouteContextRequestSchema } from '../../shared/apis/symmy-route-context.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import {
  SymmyJobLifecyclePolicyRefSchema,
  SymmyLifecycleRouteIdSchema,
} from '../../shared/domain/symmy-job-notification.ts';
import type { SymmyJobRetentionPolicy } from '../../shared/domain/symmy-job-retention.ts';
import { SymmyDecodedSourceSelectorSchema } from '../../shared/domain/symmy-source-selector.ts';
import type { symmyJobRoutes } from '../db/schema.ts';
import { symmyIntegrationRegisteredWorkloadCalls } from '../registered-workload-calls.ts';
import { SymmyRouteEnrollmentRefused } from './symmy-route-enrollment-refused.ts';
import type { SymmyRouteEnrollmentRefusal, SymmyRouteEnrollmentRefusalCode } from './symmy-route-enrollment-refused.ts';

/** The admission contract every non-fixture route admits under (`input.fixtureId ?? 'INTERNAL_C14'`). */
const ADMISSION_FIXTURE_IDS: readonly string[] = ['INTERNAL_C14'];
const catalogModule = 'commerce.catalog';
const pricingModule = 'commerce.pricing';
const priceGroupModule = 'pricing.price-group-catalog';
const partyModule = 'party.registry';
const customerModule = 'commerce.customer-context';
const definePrice = 'commerce.pricing.define-price';
const revisePrice = 'commerce.pricing.revise-price';
const priceWrites: ReadonlySet<string> = new Set([definePrice, revisePrice]);

const RouteKeySchema = SymmyRouteContextRequestSchema.fields.routeKey;
export type SymmyEnrollmentRouteKey = typeof RouteKeySchema.Type;
const versionText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(80));

/** One route of one Tenant, company and integration principal, exactly as the operator reviewed it. */
export const SymmyRouteEnrollmentRequestSchema = Schema.Struct({
  configuration: SymmyFixtureExecutionPlanSchema,
  /** Absent only for a Tenant-only route. */
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  /** Required for a route that admits writes; it pins their retention. */
  lifecyclePolicy: Schema.optionalKey(SymmyJobLifecyclePolicyRefSchema),
  mappingVersion: versionText,
  /** The integration principal the Symmy API key authenticates as. */
  principalId: PrincipalIdSchema,
  /** The code the Symmy path names a selected Customer Group by; only the Customer Group membership route has one. */
  routeCode: Schema.optionalKey(SymmyDecodedSourceSelectorSchema.members[0].fields.code),
  /** Chosen by the operator, so the retention configuration can name the route before it is written. */
  routeId: SymmyLifecycleRouteIdSchema,
  routeKey: RouteKeySchema,
  routeRevision: versionText,
  tenantId: TenantIdSchema,
});
export type SymmyRouteEnrollmentRequest = typeof SymmyRouteEnrollmentRequestSchema.Type;

const refusal = (code: SymmyRouteEnrollmentRefusalCode, detail: string): SymmyRouteEnrollmentRefusal => ({
  code,
  detail,
});
const refuseWhen = (failed: boolean, code: SymmyRouteEnrollmentRefusalCode, detail: string) =>
  failed ? [refusal(code, detail)] : [];

/** Who makes a call: the Shell or the Symmy admission for the integration principal, or the route's executor. */
export const SymmyRouteCallerSchema = Schema.Literals(['integration', 'executor']);
/** One published operation, by entrypoint and version. */
export interface SymmyRouteCallRef {
  readonly entrypointKey: string;
  readonly schemaVersion: string;
}
export interface SymmyRouteInventoryOperation extends SymmyRouteCallRef {
  readonly caller: typeof SymmyRouteCallerSchema.Type;
  /** The item entity kind the admission plan reads an executor operation from. */
  readonly entityKind?: string;
  readonly moduleId: string;
  /** Registered reads the executor makes for this operation, besides its own call and the recoveries of it. */
  readonly reads?: readonly SymmyRouteCallRef[];
  readonly required: boolean;
}
/** A published read the Symmy admission makes with the integration principal's own assertion. */
export interface SymmyRouteAdmissionRead extends SymmyRouteCallRef {
  readonly moduleId: string;
}
/** Logical sources whose routes the readers and writers compare field by field. */
const SourceFamilySchema = Schema.Literals(['customerGroups', 'customers', 'priceLists', 'products']);
type SourceFamily = typeof SourceFamilySchema.Type;
export interface SymmyRouteInventory {
  /** How the route admits work: a durable job, a synchronous admission, or none (a read). */
  readonly admission: 'job' | 'read' | 'sync';
  readonly admissionReads?: readonly SymmyRouteAdmissionRead[];
  /** The route reads a company's data and is unusable without one. */
  readonly companyRequired?: boolean;
  readonly family?: SourceFamily;
  readonly operations: readonly SymmyRouteInventoryOperation[];
  /** The route is one per selected Customer Group: it names a route code and the selector it resolves to. */
  readonly selected?: boolean;
  /** Every item names one entity kind: the record type its reader asks the owner for. */
  readonly uniformEntityKind?: boolean;
}
const executor = (
  moduleId: string,
  entrypointKey: string,
  schemaVersion: string,
  options: {
    readonly entityKind?: string;
    readonly reads?: readonly SymmyRouteCallRef[];
    readonly required?: boolean;
  } = {},
): SymmyRouteInventoryOperation => {
  const operation: SymmyRouteInventoryOperation = {
    caller: 'executor',
    entrypointKey,
    moduleId,
    required: options.required ?? false,
    schemaVersion,
  };
  if (options.entityKind !== undefined) {
    Object.assign(operation, { entityKind: options.entityKind });
  }
  if (options.reads !== undefined) {
    Object.assign(operation, { reads: options.reads });
  }
  return operation;
};
const shellRead = (moduleId: string, entrypointKey: string, required = false): SymmyRouteInventoryOperation => ({
  caller: 'integration',
  entrypointKey,
  moduleId,
  required,
  schemaVersion: '1',
});
const read = (entrypointKey: string): SymmyRouteCallRef => ({ entrypointKey, schemaVersion: '1' });
const catalogSourceProducts = read('commerce.catalog.api.catalog-source-products');
const priceGroupAssociations = read('pricing.price-group-catalog.api.price-group-source-associations');

/**
 * The route-specific operation inventories, each read from the code that plans, executes and dispatches the route:
 *
 * - productsBatch: the operations `buildSymmyProductPlan` and `priceContextOf` look up by entity kind; the Catalog
 *   source lookup the adapters make before and after a Catalog write (`readCatalogSourceProduct`,
 *   `verifyExistingCatalogTarget`); the association read the Shell makes for a price that names a price group
 *   (`readSymmyProductPriceGroupFacts`).
 * - priceListsBatchUpsert: the Price Group create and Price define `buildSymmyPriceListPlan` looks up; the catalog
 *   head read before a create (`readCatalogHead`) and the association read that resolves a created list
 *   (`readCreatedPriceGroup`).
 * - priceListPricesBatch: the define and revise `buildSymmyPriceBatchPlan` looks up; the current definition and
 *   association reads of `verifyBatchPriceGroup`; the association read the Shell requires (`requireSourcedPriceGroup`).
 * - customersBatch: the Party and Customer Context operations `buildSymmyCustomerPlan` looks up on the entity kind of
 *   its Party create; the current profile read before a company ICO change (`currentOrganizationIcoTarget`); the
 *   Privacy intake check the admission makes with the integration principal (`requireSymmyCustomerIntakePrivacy`).
 * - customerGroupsBatch: the Customer Group create and update a synchronous admission executes (`syncIntentAllowed`).
 * - customerGroupCustomersBatch: the membership apply of one selected Customer Group and the group definition read
 *   the adapter makes before it (`currentMembershipDefinition`).
 * - adminProducts, adminCustomers, priceLists, adminRegions: the reads `SymmyGovernedDispatch.read` and its
 *   projections require (`requireRouteRead`, `requireReadOperation`) or use when the route enrolls them
 *   (`routeAllows`). priceLists also lends its price reads to a REVISE of priceListPricesBatch
 *   (`readSymmyPriceBatchFacts`).
 *
 * The job read (GET jobs/{id}) has no route: it is the poll workload every job route requires of its key.
 */
const symmyRouteInventories = new Map<SymmyEnrollmentRouteKey, SymmyRouteInventory>([
  [
    'adminCustomers',
    {
      admission: 'read',
      family: 'customers',
      operations: [
        shellRead(customerModule, 'commerce.customer-context.api.customer-profile-source-page', true),
        shellRead(customerModule, 'commerce.customer-context.api.customer-profile-ico'),
        shellRead(customerModule, 'commerce.customer-context.api.organization-customer-profile-ico'),
        shellRead(customerModule, 'commerce.customer-context.api.customer-profile-source-parties'),
        shellRead(partyModule, 'party.registry.api.source-profile-export'),
        shellRead(partyModule, 'party.registry.api.organization-business-name-export'),
        shellRead(partyModule, 'party.registry.api.source-party-search'),
      ],
      uniformEntityKind: true,
    },
  ],
  [
    'adminProducts',
    {
      admission: 'read',
      family: 'products',
      operations: [shellRead(catalogModule, 'commerce.catalog.api.catalog-source-product-page', true)],
    },
  ],
  [
    'adminRegions',
    {
      admission: 'read',
      companyRequired: true,
      operations: [
        shellRead('commerce.market-catalog', 'commerce.market-catalog.api.current-market-catalog', true),
        shellRead(pricingModule, 'commerce.pricing.api.current-supported-currencies', true),
      ],
    },
  ],
  [
    'customerGroupCustomersBatch',
    {
      admission: 'job',
      family: 'customerGroups',
      operations: [
        executor(customerModule, 'commerce.customer-context.apply-customer-group-membership-source', '1', {
          reads: [read('commerce.customer-context.api.customer-group-definition-source')],
          required: true,
        }),
      ],
      selected: true,
    },
  ],
  [
    'customerGroupsBatch',
    {
      admission: 'sync',
      family: 'customerGroups',
      operations: [
        executor(customerModule, 'commerce.customer-context.create-customer-group', '1', { required: true }),
        executor(customerModule, 'commerce.customer-context.update-customer-group', '1'),
      ],
    },
  ],
  [
    'customersBatch',
    {
      admission: 'job',
      admissionReads: [{ ...read('privacy.core.api.source-processing-eligibility'), moduleId: 'privacy.core' }],
      family: 'customers',
      operations: [
        executor(partyModule, 'party.registry.create-party', '1', { required: true }),
        executor(partyModule, 'party.registry.counterparty-customer-onboard', '1'),
        executor(partyModule, 'party.registry.add-contact-point', '1'),
        executor(customerModule, 'commerce.customer-context.ensure-retail-customer-profile', '1'),
        executor(customerModule, 'commerce.customer-context.create-counterparty-purchasing-profile', '1'),
        executor(customerModule, 'commerce.customer-context.add-saved-address', '1'),
        executor(customerModule, 'commerce.customer-context.change-organization-customer-profile-ico', '1', {
          reads: [read('commerce.customer-context.api.customer-profile-source')],
        }),
      ],
      uniformEntityKind: true,
    },
  ],
  [
    'priceListPricesBatch',
    {
      admission: 'job',
      family: 'priceLists',
      operations: [
        executor(pricingModule, definePrice, '2', {
          entityKind: 'PRICE',
          reads: [priceGroupAssociations],
        }),
        executor(pricingModule, revisePrice, '2', {
          entityKind: 'PRICE',
          reads: [read('commerce.pricing.api.price-definition'), priceGroupAssociations],
        }),
        shellRead(priceGroupModule, priceGroupAssociations.entrypointKey, true),
      ],
    },
  ],
  [
    'priceLists',
    {
      admission: 'read',
      family: 'priceLists',
      operations: [
        shellRead(priceGroupModule, priceGroupAssociations.entrypointKey, true),
        shellRead(priceGroupModule, 'pricing.price-group-catalog.api.price-group-definition', true),
        shellRead(pricingModule, 'commerce.pricing.api.price-group-source-prices'),
        shellRead(pricingModule, 'commerce.pricing.api.price-schedule'),
      ],
    },
  ],
  [
    'priceListsBatchUpsert',
    {
      admission: 'job',
      family: 'priceLists',
      operations: [
        executor(priceGroupModule, 'pricing.price-group-catalog.create-price-group', '1', {
          entityKind: 'PRICE_GROUP',
          reads: [read('pricing.price-group-catalog.api.price-group-catalog-head')],
          required: true,
        }),
        executor(pricingModule, definePrice, '2', {
          entityKind: 'PRICE',
          reads: [priceGroupAssociations],
        }),
      ],
    },
  ],
  [
    'productsBatch',
    {
      admission: 'job',
      family: 'products',
      operations: [
        executor(catalogModule, 'commerce.catalog.create-product', '2', {
          entityKind: 'PRODUCT',
          reads: [catalogSourceProducts],
          required: true,
        }),
        executor(catalogModule, 'commerce.catalog.update-product', '1', {
          entityKind: 'PRODUCT',
          reads: [catalogSourceProducts],
        }),
        executor(catalogModule, 'commerce.catalog.create-variant', '2', {
          entityKind: 'VARIANT',
          reads: [catalogSourceProducts],
        }),
        executor(catalogModule, 'commerce.catalog.set-variant-localized-facts', '1', {
          entityKind: 'VARIANT',
          reads: [catalogSourceProducts],
        }),
        executor(pricingModule, definePrice, '2', { entityKind: 'PRICE' }),
        shellRead(priceGroupModule, priceGroupAssociations.entrypointKey),
      ],
    },
  ],
]);

type EnrolledOperation = SymmyFixtureExecutionPlan['items'][number]['effects'][number]['operation'];
type OperationKey = Pick<EnrolledOperation, 'entrypointKey' | 'moduleId' | 'schemaVersion'>;
const sameOperation = (left: OperationKey, right: OperationKey) =>
  left.moduleId === right.moduleId &&
  left.entrypointKey === right.entrypointKey &&
  left.schemaVersion === right.schemaVersion;
export const symmyOperationName = ({ entrypointKey, schemaVersion }: SymmyRouteCallRef) =>
  `${entrypointKey}@${schemaVersion}`;

/** The inventory of the route, or the typed reason it cannot be enrolled. */
export const symmyRouteInventoryOf = (
  routeKey: SymmyEnrollmentRouteKey,
): Option.Option<SymmyRouteInventory> | SymmyRouteEnrollmentRefusal => {
  if (routeKey === 'inventoryStockBatch') {
    return refusal(
      'stock_route_pending_inventory_setup',
      'The stock route is enrolled by its own slice once its Inventory backend and positions are set up',
    );
  }
  return Option.fromUndefinedOr(symmyRouteInventories.get(routeKey));
};

/** The operations a configuration enrolls, with the entity kind of the item naming each. */
const enrolledOperations = (configuration: SymmyFixtureExecutionPlan) =>
  configuration.items.flatMap(({ effects, source }) =>
    effects.map(({ operation }) => ({ entityKind: source.entityKind, operation })),
  );
/** The inventory operations a configuration enrolls. */
export const symmyEnrolledInventory = (inventory: SymmyRouteInventory, configuration: SymmyFixtureExecutionPlan) =>
  inventory.operations.filter((operation) =>
    enrolledOperations(configuration).some((enrolled) => sameOperation(enrolled.operation, operation)),
  );

/** The published call an executor operation makes in the route's admission mode, if Symmy registers exactly one. */
export const symmyExecutorCallsOf = (admission: SymmyRouteInventory['admission'], operation: SymmyRouteCallRef) =>
  symmyIntegrationRegisteredWorkloadCalls.filter(
    (call) =>
      call.entrypointKey === operation.entrypointKey &&
      call.schemaVersion === operation.schemaVersion &&
      !('recoveryOf' in call) &&
      (admission === 'sync' ? 'sourceActionKey' in call : 'workerKey' in call),
  );

const selectorRefusals = (request: SymmyRouteEnrollmentRequest, inventory: SymmyRouteInventory) => {
  const { selector } = request.configuration;
  if (inventory.selected !== true) {
    return [
      ...refuseWhen(
        selector !== undefined,
        'configuration_field_not_allowed',
        `${request.routeKey} resolves no selected Customer Group`,
      ),
      ...refuseWhen(request.routeCode !== undefined, 'route_code_invalid', `${request.routeKey} has no route code`),
    ];
  }
  const logicalRoute: string = request.configuration.sourceRouteId ?? request.routeId;
  return [
    ...refuseWhen(
      request.routeCode === undefined,
      'route_code_invalid',
      'A selected Customer Group route names the code its path selects the group by',
    ),
    ...refuseWhen(
      selector === undefined ||
        selector.kind !== 'CUSTOMER_GROUP' ||
        selector.source.entityKind !== 'CUSTOMER_GROUP' ||
        selector.source.route.tenantId !== request.tenantId ||
        selector.source.route.integrationRouteId !== logicalRoute ||
        selector.target?.tenantId !== request.tenantId ||
        selector.target.moduleId !== customerModule ||
        selector.target.resourceType !== 'commerce.customer-context.customer-group',
      'selector_invalid',
      'The selector names one Customer Group of this Tenant, created by the source route this route runs under',
    ),
  ];
};

/** What the request itself must satisfy, before any state is read. */
export const symmyRouteRequestRefusals = (
  request: SymmyRouteEnrollmentRequest,
  inventory: SymmyRouteInventory,
): readonly SymmyRouteEnrollmentRefusal[] => {
  const { configuration } = request;
  const enrolled = enrolledOperations(configuration);
  const [first] = configuration.items;
  const writesPrices = enrolled.some(({ operation }) => priceWrites.has(operation.entrypointKey));
  return [
    ...refuseWhen(
      configuration.items.some(({ effects }) => effects.some(({ intent }) => intent !== undefined)),
      'owner_intent_enrolled',
      'A route names the owner operations it may use, never an executable intent',
    ),
    ...refuseWhen(
      configuration.stockScope !== undefined || configuration.inventoryBackendId !== undefined,
      'configuration_field_not_allowed',
      `${request.routeKey} enrolls no stock positions or Inventory backend`,
    ),
    ...selectorRefusals(request, inventory),
    ...enrolled.flatMap(({ entityKind, operation }) => {
      const listed = inventory.operations.find((candidate) => sameOperation(candidate, operation));
      if (listed === undefined) {
        return [
          refusal(
            'operation_not_in_route_inventory',
            `${symmyOperationName(operation)} is neither called by the ${request.routeKey} plan nor read by its dispatch`,
          ),
        ];
      }
      return refuseWhen(
        listed.entityKind !== undefined && listed.entityKind !== entityKind,
        'operation_entity_kind_mismatch',
        `${symmyOperationName(operation)} is read from a ${listed.entityKind ?? ''} item, not ${entityKind}`,
      );
    }),
    ...refuseWhen(
      inventory.uniformEntityKind === true &&
        configuration.items.some(({ source }) => source.entityKind !== first.source.entityKind),
      'operation_entity_kind_mismatch',
      `Every item of ${request.routeKey} names the one record type its reader and writer share`,
    ),
    ...inventory.operations.flatMap((operation) =>
      refuseWhen(
        operation.required && !enrolled.some((candidate) => sameOperation(candidate.operation, operation)),
        'required_operation_missing',
        `${request.routeKey} cannot serve a request without ${symmyOperationName(operation)}`,
      ),
    ),
    ...refuseWhen(
      inventory.admission !== 'read' &&
        !symmyEnrolledInventory(inventory, configuration).some(({ caller }) => caller === 'executor'),
      'required_operation_missing',
      `${request.routeKey} admits writes and enrolls no owner write`,
    ),
    ...refuseWhen(
      writesPrices !== (configuration.priceSource !== undefined && configuration.pricingSourceSystem !== undefined) ||
        (!writesPrices && (configuration.priceSource !== undefined || configuration.pricingSourceSystem !== undefined)),
      'price_source_mismatch',
      'A route names its price source and source system exactly when it writes prices',
    ),
    ...refuseWhen(
      request.legalEntityId === undefined && inventory.companyRequired === true,
      'company_scope_required',
      `${request.routeKey} reads the data of one company and cannot be enrolled on a Tenant-only route`,
    ),
    ...symmyEnrolledInventory(inventory, configuration).flatMap((operation) =>
      refuseWhen(
        request.legalEntityId === undefined &&
          operation.caller === 'executor' &&
          symmyExecutorCallsOf(inventory.admission, operation).some(
            ({ legalEntityScope }) => legalEntityScope === 'required',
          ),
        'company_scope_required',
        `${symmyOperationName(operation)} is published for a company and cannot be enrolled on a Tenant-only route`,
      ),
    ),
    ...refuseWhen(
      configuration.items.some(
        ({ source }) =>
          source.issuerId !== first.source.issuerId || source.sourceNamespace !== first.source.sourceNamespace,
      ),
      'source_identity_mixed',
      'Every item of a route names the same source issuer and namespace',
    ),
    ...refuseWhen(
      inventory.admission !== 'read' && request.lifecyclePolicy === undefined,
      'lifecycle_policy_required',
      `${request.routeKey} admits writes and pins their lifecycle policy`,
    ),
    ...refuseWhen(
      inventory.admission === 'read' && request.lifecyclePolicy !== undefined,
      'configuration_field_not_allowed',
      `${request.routeKey} admits no work and pins no lifecycle policy`,
    ),
  ];
};

/** The fields of a source family's logical identity, as its readers and writers compare them. */
const familyFields = {
  customerGroups: ['issuerId', 'sourceNamespace', 'sourceRouteId', 'sourceRouteRevision', 'sourceMappingVersion'],
  customers: [
    'entityKind',
    'issuerId',
    'sourceNamespace',
    'sourceRouteId',
    'sourceRouteRevision',
    'sourceMappingVersion',
  ],
  priceLists: ['issuerId', 'sourceNamespace', 'sourceRouteId'],
  products: ['issuerId', 'sourceNamespace', 'sourceRouteId'],
} as const satisfies Record<SourceFamily, readonly (keyof SymmyLogicalSourceIdentity)[]>;
/**
 * The route kinds whose logical source a route of this kind must share, when they are enrolled. The membership route
 * of each selected Customer Group shares the source of the group route, not of another group's membership route.
 */
export const symmySourceFamilyPeers = (routeKey: SymmyEnrollmentRouteKey): readonly SymmyEnrollmentRouteKey[] => {
  const family = symmyRouteInventories.get(routeKey)?.family;
  return [...symmyRouteInventories.entries()].flatMap(([key, inventory]) =>
    family !== undefined && inventory.family === family && key !== routeKey ? [key] : [],
  );
};

/** Issuer, namespace, record type and logical source route, as the owners record them and the readers compare. */
interface SymmyLogicalSourceIdentity {
  readonly entityKind: string;
  readonly issuerId: string;
  readonly sourceMappingVersion: string;
  readonly sourceNamespace: string;
  readonly sourceRouteId: string;
  readonly sourceRouteRevision: string;
}
/** A route row or request as the logical source comparison needs it. */
export interface SymmyEnrolledSource {
  readonly configuration: SymmyFixtureExecutionPlan;
  readonly mappingVersion: string;
  readonly routeId: string;
  readonly routeKey: SymmyEnrollmentRouteKey;
  readonly routeRevision: string;
}
const logicalSourceIdentity = ({
  configuration,
  mappingVersion,
  routeId,
  routeRevision,
}: SymmyEnrolledSource): SymmyLogicalSourceIdentity => {
  const [{ source }] = configuration.items;
  // A selected membership route writes for the group its selector names: the group's source is the one compared.
  const named = configuration.selector?.source ?? source;
  return {
    entityKind: source.entityKind,
    issuerId: named.issuerId,
    sourceMappingVersion: configuration.sourceMappingVersion ?? mappingVersion,
    sourceNamespace: named.sourceNamespace,
    sourceRouteId: configuration.sourceRouteId ?? routeId,
    sourceRouteRevision: configuration.sourceRouteRevision ?? routeRevision,
  };
};

/** The routes of one source must name the same logical source, or a reader answers an empty page. */
export const symmyFamilyRefusals = (
  request: SymmyEnrolledSource,
  peers: readonly SymmyEnrolledSource[],
): readonly SymmyRouteEnrollmentRefusal[] => {
  const family = symmyRouteInventories.get(request.routeKey)?.family;
  if (family === undefined) {
    return [];
  }
  const own = logicalSourceIdentity(request);
  return peers.flatMap((peer) => {
    const other = logicalSourceIdentity(peer);
    const differing = familyFields[family].filter((field) => own[field] !== other[field]);
    return refuseWhen(
      differing.length > 0,
      'source_identity_differs_from_counterpart',
      `Route ${peer.routeId} (${peer.routeKey}) of the same source names another ${differing.join(', ')}`,
    );
  });
};

/** The same exactly-one match `requireLifecyclePolicy` makes when work is admitted. */
export const symmyRetentionRefusals = (
  request: SymmyRouteEnrollmentRequest,
  configured: readonly SymmyJobRetentionPolicy[],
): readonly SymmyRouteEnrollmentRefusal[] => {
  const { legalEntityId, lifecyclePolicy } = request;
  if (lifecyclePolicy === undefined) {
    return [];
  }
  const matches = configured.filter(
    (policy) =>
      policy.tenantId === request.tenantId &&
      policy.routeId === request.routeId &&
      policy.policyId === lifecyclePolicy.policyId &&
      policy.revision === lifecyclePolicy.revision &&
      Option.getOrUndefined(policy.targetLegalEntityId) === legalEntityId &&
      (legalEntityId === undefined || policy.governanceLegalEntityId === legalEntityId),
  );
  return refuseWhen(
    matches.length !== 1,
    'lifecycle_policy_not_configured',
    `ONTOS_SYMMY_JOB_RETENTION_POLICIES must name policy ${lifecyclePolicy.policyId}@${
      lifecyclePolicy.revision
    } for route ${request.routeId} exactly once`,
  );
};

type RouteRow = typeof symmyJobRoutes.$inferSelect;
const ROUTE_FIELDS = [
  'active',
  'configuration',
  'fixtureIds',
  'legalEntityId',
  'lifecyclePolicy',
  'mappingVersion',
  'principalId',
  'routeCode',
  'routeId',
  'routeKey',
  'routeRevision',
  'tenantId',
] as const;
export type SymmyRouteField = (typeof ROUTE_FIELDS)[number];
const sameConfiguration = Schema.toEquivalence(SymmyFixtureExecutionPlanSchema);
const samePolicy = Schema.toEquivalence(SymmyJobLifecyclePolicyRefSchema);
const decodeStoredConfiguration = Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema);
const decodeStoredPolicy = Schema.decodeUnknownOption(SymmyJobLifecyclePolicyRefSchema);

/**
 * The fields in which a stored route differs from the request. Stored pins are decoded through their own schemas and
 * compared by schema equivalence, so jsonb key order is no difference and an undecodable pin always is one.
 */
export const symmyRouteDifferences = (
  request: SymmyRouteEnrollmentRequest,
  row: RouteRow,
): readonly SymmyRouteField[] => {
  const differs = {
    active: !row.active,
    configuration: !Option.exists(decodeStoredConfiguration(row.fixturePlan), (stored) =>
      sameConfiguration(stored, request.configuration),
    ),
    fixtureIds:
      row.fixtureIds.length !== ADMISSION_FIXTURE_IDS.length ||
      row.fixtureIds.some((fixtureId, index) => fixtureId !== ADMISSION_FIXTURE_IDS[index]),
    legalEntityId: row.legalEntityId !== (request.legalEntityId ?? null),
    lifecyclePolicy: Option.match(Option.fromUndefinedOr(request.lifecyclePolicy), {
      onNone: () => row.lifecyclePolicy !== null,
      onSome: (requested) =>
        !Option.exists(decodeStoredPolicy(row.lifecyclePolicy), (stored) => samePolicy(stored, requested)),
    }),
    mappingVersion: row.mappingVersion !== request.mappingVersion,
    principalId: row.principalId !== request.principalId,
    routeCode: row.routeCode !== (request.routeCode ?? null),
    routeId: row.routeId !== request.routeId,
    routeKey: row.routeKey !== request.routeKey,
    routeRevision: row.routeRevision !== request.routeRevision,
    tenantId: row.tenantId !== request.tenantId,
  } satisfies Record<SymmyRouteField, boolean>;
  return ROUTE_FIELDS.filter((field) => differs[field]);
};

/** The row columns one enrollment writes, as the job store reads them back. */
export const symmyPlannedRouteRow = (request: SymmyRouteEnrollmentRequest) => ({
  active: true,
  fixtureIds: [...ADMISSION_FIXTURE_IDS],
  legalEntityId: request.legalEntityId ?? null,
  mappingVersion: request.mappingVersion,
  principalId: request.principalId,
  routeCode: request.routeCode ?? null,
  routeId: request.routeId,
  routeKey: request.routeKey,
  routeRevision: request.routeRevision,
  tenantId: request.tenantId,
});

export type SymmyRouteEnrollmentWrite =
  | { readonly kind: 'insert' }
  | { readonly changed: readonly SymmyRouteField[]; readonly kind: 'replace' }
  | { readonly kind: 'unchanged' };

const conflict = (detail: string) =>
  new SymmyRouteEnrollmentRefused({ refusals: [refusal('route_id_conflict', detail)] });

/**
 * What one enrollment does with the routes already holding its selector (Tenant, principal, company, route kind and
 * code) or its route id. A replacement is decided here only as allowed; the store refuses it while work is outstanding.
 */
export const decideSymmyRouteWrite = (
  request: SymmyRouteEnrollmentRequest,
  existing: { readonly byRouteId: Option.Option<RouteRow>; readonly bySelector: Option.Option<RouteRow> },
  replace: boolean,
): SymmyRouteEnrollmentWrite | SymmyRouteEnrollmentRefused => {
  if (Option.isNone(existing.bySelector)) {
    return Option.isSome(existing.byRouteId)
      ? conflict(`Route id ${request.routeId} is already enrolled for another selector`)
      : { kind: 'insert' };
  }
  const current = existing.bySelector.value;
  if (current.routeId !== request.routeId) {
    return conflict(`The selector is enrolled as route ${current.routeId}; a route id is never rebound`);
  }
  const changed = symmyRouteDifferences(request, current);
  if (changed.length === 0) {
    return { kind: 'unchanged' };
  }
  if (!replace) {
    return new SymmyRouteEnrollmentRefused({
      refusals: [refusal('route_drift', `Route ${current.routeId} is enrolled with another ${changed.join(', ')}`)],
    });
  }
  if (current.routeRevision === request.routeRevision) {
    return new SymmyRouteEnrollmentRefused({
      refusals: [refusal('revision_not_advanced', 'A replacement names a new route revision')],
    });
  }
  return { changed, kind: 'replace' };
};

/** The Core facts a route depends on, as their owners' readers report them. */
export const symmyCoreRefusals = (facts: {
  readonly activeModules: ReadonlySet<string>;
  /** False only when the request names a company that is not an active company of the Tenant. */
  readonly companyActive: boolean;
  readonly moduleKeys: readonly string[];
  /** Why the integration principal is not eligible, when it is not. */
  readonly principalIneligible: Option.Option<string>;
}): readonly SymmyRouteEnrollmentRefusal[] => [
  ...facts.moduleKeys.flatMap((moduleKey) =>
    refuseWhen(
      !facts.activeModules.has(moduleKey),
      'module_not_active',
      `Module ${moduleKey} is not active in the Tenant`,
    ),
  ),
  ...refuseWhen(!facts.companyActive, 'company_not_active', 'The company is not an active company of the Tenant'),
  ...Option.match(facts.principalIneligible, {
    onNone: () => [],
    onSome: (reason) => [refusal('integration_principal_not_active', `The integration principal is ${reason}`)],
  }),
];

const sameSelectedSource = (stored: RouteRow['fixturePlan'], requested: SymmyFixtureExecutionPlan['selector']) =>
  Option.exists(
    decodeStoredConfiguration(stored),
    ({ selector }) =>
      selector !== undefined &&
      requested !== undefined &&
      selector.target?.resourceId === requested.target?.resourceId &&
      selector.kind === requested.kind &&
      selector.source.issuerId === requested.source.issuerId &&
      selector.source.sourceNamespace === requested.source.sourceNamespace &&
      selector.source.sourceRecordId === requested.source.sourceRecordId &&
      selector.source.route.integrationRouteId === requested.source.route.integrationRouteId,
  );

/**
 * The principal's other active routes of this kind and of the kinds sharing its source. The route context resolves a
 * route by Tenant, principal, kind and code (or qualified selector) across companies, so a second active route that
 * answers the same lookup makes both unreachable; the routes of one source must name the same logical source.
 */
export const symmyRelatedRouteRefusals = (
  request: SymmyRouteEnrollmentRequest,
  inventory: SymmyRouteInventory,
  related: readonly RouteRow[],
) => {
  const others = related.filter(({ active, routeId }) => active && routeId !== request.routeId);
  // A route of the same company and code is the enrolled route itself, which the write decision handles.
  const ambiguous = others.filter(
    (row) =>
      row.routeKey === request.routeKey &&
      ((row.routeCode === (request.routeCode ?? null) && row.legalEntityId !== (request.legalEntityId ?? null)) ||
        (inventory.selected === true && sameSelectedSource(row.fixturePlan, request.configuration.selector))),
  );
  const peerKeys = new Set(symmySourceFamilyPeers(request.routeKey));
  const peers = others.filter(({ routeKey }) => peerKeys.has(routeKey));
  const readable = peers.flatMap((row): readonly SymmyEnrolledSource[] =>
    Option.match(decodeStoredConfiguration(row.fixturePlan), {
      onNone: () => [],
      onSome: (configuration) => [{ ...row, configuration }],
    }),
  );
  return {
    peers: readable.map(({ routeId, routeKey }) => ({ routeId, routeKey })),
    refusals: [
      ...ambiguous.map(({ routeId }) =>
        refusal('route_selector_ambiguous', `Active route ${routeId} answers the same route lookup of this principal`),
      ),
      ...peers.flatMap(({ routeId, routeKey }) =>
        refuseWhen(
          !readable.some((peer) => peer.routeId === routeId),
          'source_identity_differs_from_counterpart',
          `Route ${routeId} (${routeKey}) of the same source has no readable configuration`,
        ),
      ),
      ...symmyFamilyRefusals(request, readable),
    ],
  };
};

const RETENTION_ACTION = 'integration.symmy.execute-symmy-retention';
/**
 * Work a replacement would strand: jobs with an effect that has not settled and whose intents retention has not
 * erased, and synchronous admissions whose intents retention has not erased. A blocked effect never settles by
 * itself, so the refusal names the governed retention Action that erases a blocked job's intents once the retention
 * of its lifecycle policy has elapsed; an erased job carries no intent and can never call an owner again.
 */
export const symmyOutstandingRefusals = (work: {
  readonly admissions: readonly string[];
  readonly jobs: readonly { readonly jobId: string; readonly state: string }[];
}): readonly SymmyRouteEnrollmentRefusal[] => {
  const blocked = work.jobs.flatMap(({ jobId, state }) => (state === 'blocked' ? [jobId] : []));
  const listed = work.jobs.map(({ jobId, state }) => `${jobId} (${state})`).join(', ');
  return [
    ...refuseWhen(work.jobs.length > 0, 'outstanding_work', `Settle these jobs first: ${listed}`),
    ...refuseWhen(
      blocked.length > 0,
      'outstanding_work',
      `Blocked jobs ${blocked.join(', ')} never settle by themselves: ${RETENTION_ACTION} erases their intents once the retention of their lifecycle policy has elapsed, and an erased job is no outstanding work`,
    ),
    ...refuseWhen(
      work.admissions.length > 0,
      'outstanding_work',
      `${RETENTION_ACTION} must erase these synchronous admissions first: ${work.admissions.join(', ')}`,
    ),
  ];
};
