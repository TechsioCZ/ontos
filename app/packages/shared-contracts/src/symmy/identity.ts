import { OntosModuleIdSchema, OntosRequiredOperationContractSchema } from '@app/core-runtime';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Effect, Schema } from 'effect';

const opaqueReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const integrationRouteId = opaqueReference.pipe(Schema.brand('SymmyIntegrationRouteId'));
const issuerId = opaqueReference.pipe(Schema.brand('SymmySourceIssuerId'));
const sourceNamespace = opaqueReference.pipe(Schema.brand('SymmySourceNamespace'));
const routeRevision = opaqueReference.pipe(Schema.brand('SymmyRouteRevision'));
const mappingVersion = opaqueReference.pipe(Schema.brand('SymmyMappingVersion'));
const customerConfigurationId = opaqueReference.pipe(Schema.brand('CustomerConfigurationId'));
const ownerResourceId = opaqueReference.pipe(Schema.brand('ResourceId'));

export const SymmyRouteRefSchema = Schema.Struct({
  integrationRouteId,
  tenantId: TenantIdSchema,
});

const ownerOperation = Schema.Struct({
  ...OntosRequiredOperationContractSchema.fields,
  moduleId: OntosModuleIdSchema,
});

/** Populated only from the verified invocation and registered route. Decoding alone grants no authority. */
export const SymmyRouteContextSchema = Schema.Struct({
  allowedOwnerOperations: Schema.NonEmptyArray(ownerOperation),
  customerConfigurationId: Schema.optionalKey(customerConfigurationId),
  factFamily: opaqueReference,
  issuerId,
  mappingVersion,
  principalId: PrincipalIdSchema,
  route: SymmyRouteRefSchema,
  routeRevision,
  sellingLegalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  sourceNamespace,
});
export type SymmyRouteContext = typeof SymmyRouteContextSchema.Type;

export const SymmySourceRecordKeySchema = Schema.Struct({
  entityKind: opaqueReference,
  sourceRecordId: opaqueReference.pipe(Schema.brand('SymmySourceRecordId')),
});

export const SymmySourceRecordRefSchema = Schema.Struct({
  ...SymmySourceRecordKeySchema.fields,
  issuerId,
  route: SymmyRouteRefSchema,
  sourceNamespace,
});
export type SymmySourceRecordRef = typeof SymmySourceRecordRefSchema.Type;

/** Use the admitted tenant, route, issuer and namespace rather than matching any payload claim. */
export const qualifySymmySourceRecord = (
  context: Pick<SymmyRouteContext, 'issuerId' | 'route' | 'sourceNamespace'>,
  key: typeof SymmySourceRecordKeySchema.Type,
): SymmySourceRecordRef => ({
  entityKind: key.entityKind,
  issuerId: context.issuerId,
  route: { ...context.route },
  sourceNamespace: context.sourceNamespace,
  sourceRecordId: key.sourceRecordId,
});

const occurrenceId = opaqueReference.pipe(Schema.brand('SymmySourceOccurrenceId'));

export const SymmySourceOccurrenceRefSchema = Schema.Struct({
  occurrenceId,
  record: SymmySourceRecordRefSchema,
});

export const SymmyEffectIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyEffectId'));

const ownerResourceRef = Schema.Struct({
  moduleId: OntosModuleIdSchema,
  resourceId: ownerResourceId,
  resourceType: OntosModuleIdSchema,
  tenantId: TenantIdSchema,
});

const ownerTargetMatches = (scope: {
  readonly owner: string;
  readonly target: typeof ownerResourceRef.Type | undefined;
  readonly tenantId: string;
}): boolean =>
  scope.target === undefined || (scope.target.tenantId === scope.tenantId && scope.target.moduleId === scope.owner);

/** Keep the originally selected owner, target and versions on each separately replayable effect. */
export const SymmyOwnerEffectRefSchema = Schema.Struct({
  effectId: SymmyEffectIdSchema,
  mappingVersion,
  occurrence: SymmySourceOccurrenceRefSchema,
  operation: ownerOperation,
  originalTarget: Schema.optionalKey(ownerResourceRef),
  routeRevision,
}).check(
  Schema.makeFilter((effect) =>
    ownerTargetMatches({
      owner: effect.operation.moduleId,
      target: effect.originalTarget,
      tenantId: effect.occurrence.record.route.tenantId,
    })
      ? undefined
      : { issue: 'the effect target must belong to the admitted tenant and operation owner', path: ['originalTarget'] },
  ),
);
export type SymmyOwnerEffectRef = typeof SymmyOwnerEffectRefSchema.Type;

export const SymmyOwnerEffectIntentSchema = Schema.Struct({
  effectId: SymmyEffectIdSchema,
  occurrenceId,
  operation: ownerOperation,
  originalTarget: Schema.optionalKey(ownerResourceRef),
  record: SymmySourceRecordKeySchema,
});

export class SymmyOwnerEffectRejected extends Schema.TaggedError<SymmyOwnerEffectRejected>()(
  'SymmyOwnerEffectRejected',
  { reason: Schema.Literals(['operation_not_allowed', 'target_scope_mismatch']) },
) {}

/** Pins a new owner effect after route admission. Recovery uses the original stored effect reference. */
export const pinSymmyOwnerEffect = Effect.fn('Symmy.pinOwnerEffect')(function* pinOwnerEffect(
  route: SymmyRouteContext,
  intent: typeof SymmyOwnerEffectIntentSchema.Type,
) {
  const { effectId, occurrenceId: sourceOccurrenceId, operation, originalTarget, record } = intent;
  if (
    !route.allowedOwnerOperations.some(
      (allowed) =>
        allowed.entrypointKey === operation.entrypointKey &&
        allowed.moduleId === operation.moduleId &&
        allowed.schemaVersion === operation.schemaVersion,
    )
  ) {
    return yield* new SymmyOwnerEffectRejected({ reason: 'operation_not_allowed' });
  }
  if (
    !ownerTargetMatches({
      owner: operation.moduleId,
      target: originalTarget,
      tenantId: route.route.tenantId,
    })
  ) {
    return yield* new SymmyOwnerEffectRejected({ reason: 'target_scope_mismatch' });
  }

  const effect: SymmyOwnerEffectRef = {
    effectId,
    mappingVersion: route.mappingVersion,
    occurrence: { occurrenceId: sourceOccurrenceId, record: qualifySymmySourceRecord(route, record) },
    operation: { ...operation },
    routeRevision: route.routeRevision,
  };
  return originalTarget === undefined ? effect : { ...effect, originalTarget: { ...originalTarget } };
});
