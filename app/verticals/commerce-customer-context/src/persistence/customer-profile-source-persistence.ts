import { CommerceOrganizationBusinessEligibility } from '../integrations/organization-business-eligibility.ts';
import {
  OrganizationProfileSourceCurrentSchema,
  OrganizationProfileSourceCreateSchema,
  OrganizationProfileSourceReceiptSchema,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
  ORGANIZATION_PROFILE_SOURCE_RECEIPT_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_RECEIPT_VERSION,
} from '../../shared/domain/organization-profile-source.ts';
import {
  defineScopedRoutine,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  requireModuleOperation,
  OperationContextUnavailable,
} from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { computeCanonicalValueHash, readScopedAdmittedWorkload } from '@app/core-runtime/access/enforcement';
import { readVerifiedGatewayRecovery } from '@app/core-runtime/auth/system-principal-context-provenance';
import { Effect, Match, Option, Schema } from 'effect';
import {
  CustomerProfileSourceResponseSchema,
  CustomerProfileSourceReceiptSchema,
  CustomerProfileSourceItemSchema,
} from '../../shared/apis/customer-profile-source.ts';
import type {
  CustomerProfileSourceRequest,
  CustomerProfileSourceResponse,
  CustomerProfileSourceItem,
} from '../../shared/apis/customer-profile-source.ts';
import type { CustomerProfileSourceAssertion } from '../../shared/domain/customer-profile-source.ts';
import { CommerceSourceProcessingEligibility } from '../integrations/source-processing-eligibility.ts';
import { CommerceSourceProfileOwnerProof } from '../integrations/source-profile-owner-proof.ts';

const storedSourceResponseSchema = Schema.Union([
  CustomerProfileSourceResponseSchema.members[0],
  CustomerProfileSourceResponseSchema.members[1],
  CustomerProfileSourceResponseSchema.members[2],
  Schema.TaggedStruct('RECEIPT', {
    current: CustomerProfileSourceItemSchema,
    receipt: CustomerProfileSourceReceiptSchema,
  }),
]);
type StoredSourceResponse = typeof storedSourceResponseSchema.Type;

const OWNER_MODULE_KEY = 'commerce.customer-context';
const DATABASE_SCHEMA = 'commerce_customer_context';
const SOURCE_READ_ROUTINE_KEY = 'customer-profile-source.read';
const sourcePartyRequirement = 'commerce.customer-context.requirement.customer-profile-source-party';
const sourcePrivacyRequirement = 'commerce.customer-context.requirement.customer-profile-source-privacy';

const sourceReadRoutine = defineScopedRoutine({
  name: 'read_customer_profile_source',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ outcome: Schema.String, result: Schema.Unknown }),
  routineKey: SOURCE_READ_ROUTINE_KEY,
  schema: DATABASE_SCHEMA,
});
const organizationReceiptResultSchema = Schema.Struct({
  current: Schema.Struct({
    counterpartyRef: OrganizationProfileSourceCreateSchema.fields.subject.fields.counterpartyRef,
    partyRef: OrganizationProfileSourceCurrentSchema.fields.partyRef,
    profileRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  receipt: OrganizationProfileSourceReceiptSchema,
});
const organizationReceiptRoutine = defineScopedRoutine({
  name: 'read_organization_customer_profile_source_receipt',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ outcome: Schema.String, result: Schema.Unknown }),
  routineKey: 'customer-profile-source.organization-receipt',
  schema: DATABASE_SCHEMA,
});
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Current source Profile evidence is unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );
export interface CustomerProfileSourceReadServices {
  readonly readSource: (
    input: CustomerProfileSourceRequest,
  ) => Effect.Effect<
    CustomerProfileSourceResponse,
    ReadHandlerNotFound | ReadHandlerUnavailable | ReadPermissionDenied
  >;
}

export const customerProfileSourceReadServices: ReadServiceFactory<
  CustomerProfileSourceReadServices,
  CommerceSourceProcessingEligibility | CommerceSourceProfileOwnerProof
> = Effect.fn('CustomerProfileSourceRead.services')(function* sourceProfileReadServices(
  transaction: Parameters<ReadServiceFactory<CustomerProfileSourceReadServices>>[0],
  scope: Parameters<ReadServiceFactory<CustomerProfileSourceReadServices>>[1],
) {
  const privacy = yield* CommerceSourceProcessingEligibility;
  const proof = yield* CommerceSourceProfileOwnerProof;
  const organizationBusiness = yield* Effect.serviceOption(CommerceOrganizationBusinessEligibility);
  if (scope.legalEntityId === undefined) {
    return yield* new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Source Profile reads require a trusted Legal Entity',
    });
  }
  const privacyCheck = (source: CustomerProfileSourceAssertion, item: CustomerProfileSourceItem, operation: string) =>
    privacy
      .check(
        scope,
        {
          operation,
          source: {
            issuer: source.issuer,
            namespace: source.namespace,
            occurrenceId: source.occurrenceId,
            recordId: source.recordId,
            recordType: source.recordType,
            routeRef: source.route.id,
          },
          target: {
            kind:
              item.profile.profileRef.kind === 'RETAIL' ? 'RETAIL_CUSTOMER_PROFILE' : 'COUNTERPARTY_PURCHASING_PROFILE',
            resourceId: item.profile.profileRef.resourceId,
          },
        },
        sourcePrivacyRequirement,
      )
      .pipe(Effect.mapError(unavailable));
  const currentAdmissionForItem = Effect.fn('CustomerProfileSourceRead.currentAdmission')(
    function* currentAdmissionForItem(item: CustomerProfileSourceItem) {
      if (item.profile.subject.kind === 'RETAIL') {
        yield* requireModuleOperation(sourcePartyRequirement).pipe(Effect.mapError(unavailable));
        if (
          item.profile.subject.partyRef.resourceId !== item.partyRef.resourceId ||
          item.profile.subject.sellingLegalEntityRef.resourceId !== scope.legalEntityId
        ) {
          return yield* unavailable();
        }
        const result = yield* proof
          .retail(scope, item.partyRef, item.source, item.partySourceReference, sourcePartyRequirement)
          .pipe(Effect.mapError(unavailable));
        if (result.outcome !== 'CURRENT_PARTY_RESOLVED' || result.partyResourceId !== item.partyRef.resourceId) {
          return yield* unavailable();
        }
        return result.currentAdmission;
      }
      yield* requireModuleOperation('commerce.customer-context.requirement.customer-profile-source-counterparty').pipe(
        Effect.mapError(unavailable),
      );
      const result = yield* proof
        .counterparty(
          scope,
          item.profile.subject.counterpartyRef.resourceId,
          item.source,
          item.partySourceReference,
          'commerce.customer-context.requirement.customer-profile-source-counterparty',
        )
        .pipe(Effect.mapError(unavailable));
      if (result.outcome !== 'ELIGIBLE' || result.partyResourceId !== item.partyRef.resourceId) {
        return yield* unavailable();
      }
      const personKey = 'commerce.customer-context.requirement.customer-profile-source-counterparty-person';
      yield* requireModuleOperation(personKey).pipe(Effect.mapError(unavailable));
      const person = yield* proof
        .retail(scope, item.partyRef, item.source, item.partySourceReference, personKey)
        .pipe(Effect.mapError(unavailable));
      if (person.outcome !== 'CURRENT_PARTY_RESOLVED' || person.partyResourceId !== item.partyRef.resourceId) {
        return yield* unavailable();
      }
      return result.currentAdmission;
    },
  );
  const checkItem = Effect.fn('CustomerProfileSourceRead.checkItem')(function* checkItem(
    item: CustomerProfileSourceItem,
  ) {
    yield* requireModuleOperation(sourcePrivacyRequirement).pipe(Effect.mapError(unavailable));
    if (
      item.profile.profileRef.tenantId !== scope.tenantId ||
      item.partyRef.tenantId !== scope.tenantId ||
      item.profile.subject.kind !== item.profile.profileRef.kind
    ) {
      return yield* unavailable();
    }
    const currentAdmission = yield* currentAdmissionForItem(item);
    if (
      currentAdmission.partyRef.resourceId !== item.partyRef.resourceId ||
      currentAdmission.partyRef.tenantId !== scope.tenantId ||
      computeCanonicalValueHash(currentAdmission.sourceReference) !==
        computeCanonicalValueHash(item.partySourceReference)
    ) {
      return yield* unavailable();
    }
    yield* privacyCheck(item.source, item, 'customer-profile-source.read');
    return currentAdmission;
  });
  const checkOriginalRecovery = Effect.fn('CustomerProfileSourceRead.checkOriginalRecovery')(
    function* checkOriginalRecovery(
      receipt: {
        readonly actionInvocationId: string;
        readonly actorPrincipalId: string;
      },
      expectedActionKey: string,
    ) {
      const sourceReadAdmitted = yield* readScopedAdmittedWorkload(
        transaction,
        scope,
        'commerce.customer-context.source-read',
      ).pipe(Effect.mapError(unavailable));
      const recovery = readVerifiedGatewayRecovery(scope);
      if (
        ((sourceReadAdmitted || scope.authMethod === 'system') && recovery === undefined) ||
        (recovery?.originalPrincipalId ?? scope.principalId) !== receipt.actorPrincipalId ||
        (recovery !== undefined &&
          (recovery.originalActionInvocationId !== receipt.actionInvocationId ||
            recovery.originalActionKey !== expectedActionKey))
      ) {
        return yield* unavailable();
      }
      return yield* Effect.void;
    },
  );
  const recoverMinimalReceipt = Effect.fn('CustomerProfileSourceRead.recoverMinimal')(function* recoverMinimalReceipt(
    result: StoredSourceResponse,
  ) {
    const receipt = Match.value(result).pipe(
      Match.tag('RECEIPT', (value) => value.receipt),
      Match.orElse(() => null),
    );
    if (receipt === null || receipt.profileKind !== 'RETAIL') {
      return yield* unavailable();
    }
    yield* checkOriginalRecovery(receipt, 'commerce.customer-context.ensure-retail-customer-profile');
    const original = receipt.intent.source;
    const originalPartyReference = receipt.intent.partySourceReference;
    if (
      original === undefined ||
      originalPartyReference === undefined ||
      receipt.result.outcome !== 'PROFILE_CREATED' ||
      receipt.result.sourceEffect?.effectId !== original.effectId ||
      receipt.result.profileRef.tenantId !== scope.tenantId ||
      receipt.intent.subject.partyRef.tenantId !== scope.tenantId ||
      receipt.intent.subject.sellingLegalEntityRef.resourceId !== scope.legalEntityId
    ) {
      return yield* unavailable();
    }
    yield* requireModuleOperation(sourcePartyRequirement).pipe(Effect.mapError(unavailable));
    const admission = yield* proof
      .retail(scope, receipt.intent.subject.partyRef, original, originalPartyReference, sourcePartyRequirement)
      .pipe(Effect.mapError(unavailable));
    if (
      admission.outcome !== 'CURRENT_PARTY_RESOLVED' ||
      admission.partyResourceId !== receipt.intent.subject.partyRef.resourceId ||
      admission.currentAdmission.partyRef.resourceId !== receipt.intent.subject.partyRef.resourceId ||
      admission.currentAdmission.partyRef.tenantId !== scope.tenantId ||
      computeCanonicalValueHash(admission.currentAdmission.sourceReference) !==
        computeCanonicalValueHash(originalPartyReference)
    ) {
      return yield* unavailable();
    }
    yield* requireModuleOperation(sourcePrivacyRequirement).pipe(Effect.mapError(unavailable));
    yield* privacy
      .check(
        scope,
        {
          operation: 'PROFILE_CREATE',
          partySourceReference: originalPartyReference,
          source: {
            issuer: original.issuer,
            namespace: original.namespace,
            occurrenceId: original.occurrenceId,
            recordId: original.recordId,
            recordType: original.recordType,
            routeRef: original.route.id,
          },
          target: { kind: 'PARTY', resourceId: receipt.intent.subject.partyRef.resourceId },
        },
        sourcePrivacyRequirement,
      )
      .pipe(Effect.mapError(unavailable));
    return { _tag: 'MINIMAL_RECEIPT' as const, currentAdmission: admission.currentAdmission, receipt };
  });
  const projectOrganizationItem = Effect.fn('CustomerProfileSourceRead.organizationCurrent')(
    function* organizationCurrent(item: CustomerProfileSourceItem) {
      if (
        Option.isNone(organizationBusiness) ||
        item.profile.subject.kind !== 'COUNTERPARTY' ||
        item.profile.profileRef.kind !== 'COUNTERPARTY'
      ) {
        return yield* unavailable();
      }
      const safe = yield* Schema.decodeUnknownEffect(OrganizationProfileSourceCurrentSchema)({
        partyRef: item.partyRef,
        partySourceReference: item.partySourceReference,
        profile: {
          profileRef: item.profile.profileRef,
          revision: item.profile.revision,
          state: item.profile.state,
          subject: { counterpartyRef: item.profile.subject.counterpartyRef, kind: 'COUNTERPARTY' },
        },
        source: item.source,
      }).pipe(Effect.mapError(unavailable));
      const profileRef = {
        moduleId: safe.profile.profileRef.moduleId,
        resourceId: safe.profile.profileRef.resourceId,
        resourceType: safe.profile.profileRef.resourceType,
        tenantId: safe.profile.profileRef.tenantId,
      };
      const authority = yield* organizationBusiness.value
        .check(
          scope,
          {
            consumerModuleId: OWNER_MODULE_KEY,
            expectedProfileRevision: safe.profile.revision,
            fields: ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
            inputDigest: computeCanonicalValueHash(
              yield* Schema.encodeEffect(OrganizationProfileSourceCurrentSchema)(safe).pipe(
                Effect.mapError(unavailable),
              ),
            ),
            kind: 'COUNTERPARTY_PROFILE',
            operation: SOURCE_READ_ROUTINE_KEY,
            profileRef,
            profileSource: safe.source,
            projectionVersion: ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
            sourceReference: safe.partySourceReference,
          },
          'commerce.customer-context.requirement.customer-profile-source-organization',
        )
        .pipe(Effect.mapError(unavailable));
      if (
        authority.liveProof.kind !== 'COUNTERPARTY_PROFILE' ||
        authority.liveProof.profile.partyRef.resourceId !== safe.partyRef.resourceId ||
        authority.liveProof.profile.counterpartyRef.resourceId !== safe.profile.subject.counterpartyRef.resourceId
      ) {
        return yield* unavailable();
      }
      return { ...safe, icoAuthority: 'ORGANIZATION' as const };
    },
  );
  const projectCurrentItem = Effect.fn('CustomerProfileSourceRead.projectCurrent')(function* projectCurrent(
    item: CustomerProfileSourceItem,
  ) {
    if (item.profile.subject.kind === 'RETAIL') {
      yield* checkItem(item);
      return { ...item, icoAuthority: 'PERSONAL' as const };
    }
    return yield* projectOrganizationItem(item).pipe(
      Effect.catch((error) =>
        checkItem(item).pipe(
          Effect.mapError((personFailure) => unavailable({ organization: error, person: personFailure })),
          Effect.as({ ...item, icoAuthority: 'PERSONAL' as const }),
        ),
      ),
    );
  });
  const organizationRecoveryIdentity = Effect.fn('CustomerProfileSourceRead.organizationRecoveryIdentity')(
    function* organizationRecoveryIdentity() {
      const admitted = yield* readScopedAdmittedWorkload(
        transaction,
        scope,
        'commerce.customer-context.source-read',
      ).pipe(Effect.mapError(unavailable));
      const recovery = readVerifiedGatewayRecovery(scope);
      if (
        ((admitted || scope.authMethod === 'system') && recovery === undefined) ||
        (recovery !== undefined &&
          recovery.originalActionKey !== 'commerce.customer-context.create-counterparty-purchasing-profile')
      ) {
        return yield* unavailable();
      }
      return recovery;
    },
  );
  const recoverOrganizationReceipt = Effect.fn('CustomerProfileSourceRead.organizationReceipt')(
    function* organizationReceipt(input: CustomerProfileSourceRequest) {
      if (Option.isNone(organizationBusiness) || input.mode !== 'ORG_RECEIPT') {
        return yield* unavailable();
      }
      const recovery = yield* organizationRecoveryIdentity();
      const [row] = yield* transaction
        .invoke(organizationReceiptRoutine, [
          recovery?.originalPrincipalId ?? scope.principalId,
          recovery?.originalActionInvocationId ?? null,
          input,
        ])
        .pipe(Effect.mapError(unavailable));
      if (row?.outcome === 'NOT_FOUND') {
        return yield* new ReadHandlerNotFound({
          code: 'read_handler_not_found',
          reason: 'The exact original Organization Profile effect is unavailable',
        });
      }
      if (row?.outcome === 'SOURCE_AUTHORITY_DENIED') {
        return yield* new ReadPermissionDenied({
          code: 'read_permission_denied',
          reason: 'Current source authority does not admit this Organization Profile receipt',
        });
      }
      if (row?.outcome !== 'AVAILABLE') {
        return yield* unavailable();
      }
      const { current, receipt: safe } = yield* Schema.decodeUnknownEffect(organizationReceiptResultSchema, {
        onExcessProperty: 'error',
      })(row.result).pipe(Effect.mapError(unavailable));
      const authority = yield* organizationBusiness.value
        .check(
          scope,
          {
            consumerModuleId: OWNER_MODULE_KEY,
            expectedProfileRevision: current.profileRevision,
            fields: ORGANIZATION_PROFILE_SOURCE_RECEIPT_FIELDS,
            inputDigest: computeCanonicalValueHash(
              yield* Schema.encodeEffect(OrganizationProfileSourceReceiptSchema)(safe).pipe(
                Effect.mapError(unavailable),
              ),
            ),
            kind: 'COUNTERPARTY_PROFILE',
            operation: 'customer-profile-source.recover',
            profileRef: safe.result.profileRef,
            profileSource: safe.intent.source,
            projectionVersion: ORGANIZATION_PROFILE_SOURCE_RECEIPT_VERSION,
            sourceReference: safe.intent.partySourceReference,
          },
          'commerce.customer-context.requirement.customer-profile-source-organization',
        )
        .pipe(Effect.mapError(unavailable));
      if (
        authority.liveProof.kind !== 'COUNTERPARTY_PROFILE' ||
        authority.liveProof.profile.partyRef.resourceId !== current.partyRef.resourceId ||
        authority.liveProof.profile.counterpartyRef.resourceId !== safe.intent.subject.counterpartyRef.resourceId ||
        current.counterpartyRef.resourceId !== safe.intent.subject.counterpartyRef.resourceId
      ) {
        return yield* unavailable();
      }
      return { _tag: 'ORG_RECEIPT' as const, receipt: safe };
    },
  );
  return {
    readSource: Effect.fn('CustomerProfileSourceRead.read')(function* readSource(input) {
      if (input.mode === 'ORG_RECEIPT') {
        return yield* recoverOrganizationReceipt(input);
      }
      const [row] = yield* transaction
        .invoke(sourceReadRoutine, [
          scope.principalId,
          input.mode === 'MINIMAL_RECEIPT' ? { ...input, mode: 'RECEIPT' } : input,
        ])
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* unavailable();
      }
      if (row.outcome === 'SOURCE_AUTHORITY_DENIED') {
        return yield* new ReadPermissionDenied({
          code: 'read_permission_denied',
          reason: 'The current route does not authorize this source Profile read',
        });
      }
      if (row.outcome === 'NOT_FOUND') {
        return yield* new ReadHandlerNotFound({
          code: 'read_handler_not_found',
          reason: 'The source effect is unavailable in the trusted scope',
        });
      }
      if (row.outcome !== 'AVAILABLE') {
        return yield* unavailable();
      }
      const result = yield* Schema.decodeUnknownEffect(storedSourceResponseSchema, {
        onExcessProperty: 'error',
      })(row.result).pipe(Effect.mapError(unavailable));
      if (input.mode === 'MINIMAL_RECEIPT') {
        return yield* recoverMinimalReceipt(result);
      }
      return yield* Match.value(result).pipe(
        Match.tagsExhaustive({
          ABSENT: (value) =>
            requireModuleOperation(sourcePrivacyRequirement).pipe(Effect.mapError(unavailable), Effect.as(value)),
          CURRENT: (value) =>
            projectCurrentItem(value.item).pipe(Effect.map((item) => ({ _tag: 'CURRENT' as const, item }))),
          PAGE: (value) =>
            (value.items.length === 0
              ? requireModuleOperation(sourcePrivacyRequirement).pipe(Effect.mapError(unavailable), Effect.as([]))
              : Effect.forEach(value.items, projectCurrentItem, { concurrency: 1 })
            ).pipe(Effect.map((items) => ({ ...value, items }))),
          RECEIPT: Effect.fn('CustomerProfileSourceRead.recover')(function* checkReceipt({
            current,
            receipt,
          }: Extract<StoredSourceResponse, { readonly _tag: 'RECEIPT' }>) {
            yield* checkItem(current);
            const original = receipt.intent.source;
            const originalPartyReference = receipt.intent.partySourceReference;
            if (
              original === undefined ||
              originalPartyReference === undefined ||
              receipt.result.sourceEffect?.effectId !== original.effectId
            ) {
              return yield* unavailable();
            }
            const currentAdmission = yield* checkItem({
              ...current,
              partySourceReference: originalPartyReference,
              source: original,
            });
            yield* privacyCheck(original, current, 'customer-profile-source.recover');
            return { _tag: 'RECEIPT' as const, current, currentAdmission, receipt };
          }),
        }),
      );
    }),
  };
});
