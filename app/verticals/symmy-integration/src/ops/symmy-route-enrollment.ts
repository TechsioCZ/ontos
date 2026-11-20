/**
 * Operator enrollment of one Symmy job route: every decision, without I/O.
 *
 * A route row (`symmy_integration.job_routes`) is the only authority the runtime reads for a Symmy route, and the
 * runtime role can only read it. This module decides what one enrollment of one route for one Tenant and company may
 * write, and why it refuses otherwise:
 *
 * - only route kinds with an operation inventory are enrollable; the stock route waits on its backend decision;
 * - the configuration names owner operations only (never an executable intent), each one in the route's inventory
 *   (what the route's admission plan can call and what its Shell dispatch reads), with every required one present;
 * - an operation whose published call needs a company is never enrolled on a Tenant-only route;
 * - write and read routes of one source share the same logical source identity;
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
import type { symmyJobRoutes } from '../db/schema.ts';
import { symmyIntegrationRegisteredWorkloadCalls } from '../registered-workload-calls.ts';
import { SymmyRouteEnrollmentRefused } from './symmy-route-enrollment-refused.ts';
import type { SymmyRouteEnrollmentRefusal, SymmyRouteEnrollmentRefusalCode } from './symmy-route-enrollment-refused.ts';

/** The admission contract every non-fixture route admits under (`input.fixtureId ?? 'INTERNAL_C14'`). */
const ADMISSION_FIXTURE_IDS: readonly string[] = ['INTERNAL_C14'];
const WORKER_JOB_KEY = 'integration.symmy.execute-symmy-job';
const catalogModule = 'commerce.catalog';
const pricingModule = 'commerce.pricing';
const priceGroupModule = 'pricing.price-group-catalog';

const RouteKeySchema = SymmyRouteContextRequestSchema.fields.routeKey;
export type SymmyEnrollmentRouteKey = typeof RouteKeySchema.Type;
const versionText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(80));

/** One route of one Tenant, company and integration principal, exactly as the operator reviewed it. */
export const SymmyRouteEnrollmentRequestSchema = Schema.Struct({
  configuration: SymmyFixtureExecutionPlanSchema,
  /** Absent only for a Tenant-only route. */
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  /** Required for a route that admits durable jobs; it pins their retention. */
  lifecyclePolicy: Schema.optionalKey(SymmyJobLifecyclePolicyRefSchema),
  mappingVersion: versionText,
  /** The integration principal the Symmy API key authenticates as. */
  principalId: PrincipalIdSchema,
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

/** Who calls an inventoried operation: the Symmy worker, or the Shell for the integration principal. */
/** Who calls an inventoried operation: the Shell for the integration principal, or the Symmy worker. */
export const SymmyRouteCallerSchema = Schema.Literals(['integration', 'worker']);
export interface SymmyRouteInventoryOperation {
  readonly caller: typeof SymmyRouteCallerSchema.Type;
  /** The item entity kind the admission plan reads a worker operation from. */
  readonly entityKind?: string;
  readonly entrypointKey: string;
  readonly moduleId: string;
  readonly required: boolean;
  readonly schemaVersion: string;
}
interface RouteInventory {
  /** The route of the same source whose logical source identity must equal this one's. */
  readonly counterpart: SymmyEnrollmentRouteKey;
  readonly durableJobs: boolean;
  readonly operations: readonly SymmyRouteInventoryOperation[];
}
const worker = (moduleId: string, entrypointKey: string, schemaVersion: string, entityKind: string, required = false) =>
  ({ caller: 'worker', entityKind, entrypointKey, moduleId, required, schemaVersion }) as const;
const shellRead = (moduleId: string, entrypointKey: string, required = false) =>
  ({ caller: 'integration', entrypointKey, moduleId, required, schemaVersion: '1' }) as const;

/**
 * The route-specific operation inventory. productsBatch: the operations `buildSymmyProductPlan` and
 * `priceContextOf` look up by entity kind, plus the association read the Shell makes when a price names a price
 * group (`readSymmyProductPriceGroupFacts`). adminProducts: the page read the Shell requires
 * (`SymmyGovernedDispatch.read`). Every other route kind is refused until its inventory is added here.
 */
const symmyRouteInventories = new Map<SymmyEnrollmentRouteKey, RouteInventory>([
  [
    'adminProducts',
    {
      counterpart: 'productsBatch',
      durableJobs: false,
      operations: [shellRead(catalogModule, 'commerce.catalog.api.catalog-source-product-page', true)],
    },
  ],
  [
    'productsBatch',
    {
      counterpart: 'adminProducts',
      durableJobs: true,
      operations: [
        worker(catalogModule, 'commerce.catalog.create-product', '2', 'PRODUCT', true),
        worker(catalogModule, 'commerce.catalog.update-product', '1', 'PRODUCT'),
        worker(catalogModule, 'commerce.catalog.create-variant', '2', 'VARIANT'),
        worker(catalogModule, 'commerce.catalog.set-variant-localized-facts', '1', 'VARIANT'),
        worker(pricingModule, 'commerce.pricing.define-price', '2', 'PRICE'),
        shellRead(priceGroupModule, 'pricing.price-group-catalog.api.price-group-source-associations'),
      ],
    },
  ],
]);

type EnrolledOperation = SymmyFixtureExecutionPlan['items'][number]['effects'][number]['operation'];
const sameOperation = (
  left: Pick<EnrolledOperation, 'entrypointKey' | 'moduleId' | 'schemaVersion'>,
  right: Pick<EnrolledOperation, 'entrypointKey' | 'moduleId' | 'schemaVersion'>,
) =>
  left.moduleId === right.moduleId &&
  left.entrypointKey === right.entrypointKey &&
  left.schemaVersion === right.schemaVersion;
const operationName = ({ entrypointKey, schemaVersion }: Pick<EnrolledOperation, 'entrypointKey' | 'schemaVersion'>) =>
  `${entrypointKey}@${schemaVersion}`;

/** The worker's published call of one operation: its workload and whether it runs for a company. */
export const symmyWorkerCallOf = (operation: Pick<EnrolledOperation, 'entrypointKey' | 'schemaVersion'>) =>
  symmyIntegrationRegisteredWorkloadCalls.find(
    (call) =>
      call.jobKey === WORKER_JOB_KEY &&
      call.entrypointKey === operation.entrypointKey &&
      call.schemaVersion === operation.schemaVersion,
  );

/** The inventory of the route, or the typed reason it cannot be enrolled. */
export const symmyRouteInventoryOf = (
  routeKey: SymmyEnrollmentRouteKey,
): Option.Option<RouteInventory> | SymmyRouteEnrollmentRefusal => {
  if (routeKey === 'inventoryStockBatch') {
    return refusal(
      'stock_route_pending_backend_decision',
      'The stock route is not enrollable until the product owner decides its Inventory backend',
    );
  }
  return Option.fromUndefinedOr(symmyRouteInventories.get(routeKey));
};

/** The operations a configuration enrolls, with the entity kind of the item naming each. */
const enrolledOperations = (configuration: SymmyFixtureExecutionPlan) =>
  configuration.items.flatMap(({ effects, source }) =>
    effects.map(({ operation }) => ({ entityKind: source.entityKind, operation })),
  );

/** Issuer, namespace and source route the owners record for the route's source, and the readers compare. */
interface SymmyLogicalSourceIdentity {
  readonly issuerId: string;
  readonly sourceNamespace: string;
  readonly sourceRouteId: string;
}
const symmyLogicalSourceIdentity = (
  routeId: string,
  configuration: SymmyFixtureExecutionPlan,
): SymmyLogicalSourceIdentity => {
  const [{ source }] = configuration.items;
  return {
    issuerId: source.issuerId,
    sourceNamespace: source.sourceNamespace,
    sourceRouteId: configuration.sourceRouteId ?? routeId,
  };
};

/** What the request itself must satisfy, before any state is read. */
export const symmyRouteRequestRefusals = (
  request: SymmyRouteEnrollmentRequest,
  inventory: RouteInventory,
): readonly SymmyRouteEnrollmentRefusal[] => {
  const { configuration } = request;
  const enrolled = enrolledOperations(configuration);
  const [first] = configuration.items;
  const writesPrices = enrolled.some(({ operation }) => operation.entrypointKey === 'commerce.pricing.define-price');
  return [
    ...refuseWhen(
      configuration.items.some(({ effects }) => effects.some(({ intent }) => intent !== undefined)),
      'owner_intent_enrolled',
      'A route names the owner operations it may use, never an executable intent',
    ),
    ...refuseWhen(
      configuration.stockScope !== undefined ||
        configuration.inventoryBackendId !== undefined ||
        configuration.selector !== undefined,
      'configuration_field_not_allowed',
      `${request.routeKey} enrolls no stock positions, Inventory backend or source selector`,
    ),
    ...enrolled.flatMap(({ entityKind, operation }) => {
      const listed = inventory.operations.find((candidate) => sameOperation(candidate, operation));
      if (listed === undefined) {
        return [
          refusal(
            'operation_not_in_route_inventory',
            `${operationName(operation)} is neither called by the ${request.routeKey} plan nor read by its dispatch`,
          ),
        ];
      }
      return refuseWhen(
        listed.entityKind !== undefined && listed.entityKind !== entityKind,
        'operation_entity_kind_mismatch',
        `${operationName(operation)} is read from a ${listed.entityKind ?? ''} item, not ${entityKind}`,
      );
    }),
    ...inventory.operations.flatMap((operation) =>
      refuseWhen(
        operation.required && !enrolled.some((candidate) => sameOperation(candidate.operation, operation)),
        'required_operation_missing',
        `${request.routeKey} cannot serve a request without ${operationName(operation)}`,
      ),
    ),
    ...refuseWhen(
      writesPrices !== (configuration.priceSource !== undefined && configuration.pricingSourceSystem !== undefined) ||
        (!writesPrices && (configuration.priceSource !== undefined || configuration.pricingSourceSystem !== undefined)),
      'price_source_mismatch',
      'A route names its price source and source system exactly when it defines prices',
    ),
    ...enrolled.flatMap(({ operation }) =>
      refuseWhen(
        request.legalEntityId === undefined && symmyWorkerCallOf(operation)?.legalEntityScope === 'required',
        'company_scope_required',
        `${operationName(operation)} is published for a company and cannot be enrolled on a Tenant-only route`,
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
      inventory.durableJobs && request.lifecyclePolicy === undefined,
      'lifecycle_policy_required',
      `${request.routeKey} admits durable jobs and pins their lifecycle policy`,
    ),
  ];
};

/** Write and read routes of one source must name the same logical source, or the read answers an empty page. */
export const symmyCounterpartRefusals = (
  request: SymmyRouteEnrollmentRequest,
  counterpart: Option.Option<{ readonly configuration: SymmyFixtureExecutionPlan; readonly routeId: string }>,
): readonly SymmyRouteEnrollmentRefusal[] =>
  Option.match(counterpart, {
    onNone: () => [],
    onSome: ({ configuration, routeId }) => {
      const own = symmyLogicalSourceIdentity(request.routeId, request.configuration);
      const other = symmyLogicalSourceIdentity(routeId, configuration);
      return refuseWhen(
        own.issuerId !== other.issuerId ||
          own.sourceNamespace !== other.sourceNamespace ||
          own.sourceRouteId !== other.sourceRouteId,
        'source_identity_differs_from_counterpart',
        `Route ${routeId} of the same source names issuer, namespace or source route other than this one`,
      );
    },
  });

/** The same exactly-one match `requireLifecyclePolicy` makes when a job is admitted. */
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
    routeCode: row.routeCode !== null,
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
  routeCode: null,
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
 * What one enrollment does with the routes already holding its selector (Tenant, principal, company, route kind) or
 * its route id. A replacement is decided here only as allowed; the store refuses it while work is outstanding.
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
