import type { ReadServiceFactory } from '@app/core-runtime';
import { defineScopedRoutine, requireModuleOperation } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { Effect, Option, Schema } from 'effect';
import type { ApplyCustomerGroupMembershipSourcePayload } from '../../shared/actions/apply-customer-group-membership-source.ts';
import {
  ApplyCustomerGroupMembershipSourceResultSchema,
  CustomerGroupMembershipSourceRejected,
} from '../../shared/actions/apply-customer-group-membership-source.ts';
import type { CustomerGroupMembershipSourceReceiptRequest } from '../../shared/apis/customer-group-membership-source-receipt.ts';
import { AdmitCustomerGroupMembershipSnapshotResultSchema } from '../../shared/domain/customer-group-membership-snapshot.ts';
import type {
  AdmitCustomerGroupMembershipSnapshotPayload,
  AdmitCustomerGroupMembershipSnapshotResult,
} from '../../shared/domain/customer-group-membership-snapshot.ts';
import { ReactivationProfileFactsSchema } from '../integrations/profile-reconfirmation-policy.ts';
import { CommerceSourceProcessingEligibility } from '../integrations/source-processing-eligibility.ts';
import type { CommerceSourceProcessingRejected } from '../integrations/source-processing-rejected.ts';
import { CommerceOrganizationBusinessEligibility } from '../integrations/organization-business-eligibility.ts';
import {
  ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
  ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
  ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
} from '../../shared/domain/organization-membership-source.ts';

const OWNER = 'commerce.customer-context';
const WRITE_PRIVACY_OPERATION = 'customer-group-membership.write';
const RECOVER_PRIVACY_OPERATION = 'customer-group-membership.recover';
const ADMIT_PRIVACY_REQUIREMENT = 'commerce.customer-context.requirement.membership-snapshot-admit-privacy';
const WRITE_PRIVACY_REQUIREMENT = 'commerce.customer-context.requirement.membership-source-write-privacy';
const RECOVER_PRIVACY_REQUIREMENT = 'commerce.customer-context.requirement.membership-source-recover-privacy';
const ORG_ADMIT_PRIVACY_REQUIREMENT = 'commerce.customer-context.requirement.org-membership-snapshot-admit-privacy';
const ORG_WRITE_PRIVACY_REQUIREMENT = 'commerce.customer-context.requirement.org-membership-write-privacy';
const ORG_RECOVER_PRIVACY_REQUIREMENT = 'commerce.customer-context.requirement.org-membership-recovery-privacy';

const membershipSourceProfileRoutine = defineScopedRoutine({
  name: 'read_customer_profile',
  ownerModuleKey: OWNER,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({
    outcome: Schema.String,
    payload: Schema.toEncoded(Schema.OptionFromNullOr(ReactivationProfileFactsSchema)),
  }),
  routineKey: 'customer-group.source-profile',
  schema: 'commerce_customer_context',
});

const MembershipSourceRoutineRowSchema = Schema.Struct({
  outcome: Schema.Literals([
    'APPLIED',
    'REPLAY',
    'SOURCE_AUTHORITY_DENIED',
    'SOURCE_CONFLICT',
    'SOURCE_STALE',
    'TARGET_INELIGIBLE',
    'TARGET_NOT_FOUND',
  ]),
  result: Schema.toEncoded(Schema.OptionFromNullOr(Schema.Record(Schema.String, Schema.Unknown))),
});

const applyMembershipSourceRoutine = defineScopedRoutine({
  name: 'apply_customer_group_membership_source',
  ownerModuleKey: OWNER,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: MembershipSourceRoutineRowSchema,
  routineKey: 'customer-group.apply-membership-source',
  schema: 'commerce_customer_context',
});

const admitMembershipSnapshotRoutine = defineScopedRoutine({
  name: 'admit_customer_group_membership_snapshot',
  ownerModuleKey: OWNER,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: MembershipSourceRoutineRowSchema,
  routineKey: 'customer-group.admit-membership-snapshot',
  schema: 'commerce_customer_context',
});

const decodeResult = Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourceResultSchema, {
  onExcessProperty: 'error',
});

const readMembershipSourceReceiptRoutine = defineScopedRoutine({
  name: 'read_customer_group_membership_source_receipt',
  ownerModuleKey: OWNER,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({
    outcome: Schema.Literals(['FOUND', 'SOURCE_AUTHORITY_DENIED', 'TARGET_NOT_FOUND']),
    result: Schema.toEncoded(Schema.OptionFromNullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
  routineKey: 'customer-group.read-membership-source-receipt',
  schema: 'commerce_customer_context',
});

const unavailable = (cause?: unknown) => {
  const failure = new CustomerGroupMembershipSourceRejected({
    code: 'PERSISTENCE_UNAVAILABLE',
    reason: 'Customer Group source Membership evidence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
const privacyRejected = (cause: CommerceSourceProcessingRejected) =>
  Object.defineProperty(
    new CustomerGroupMembershipSourceRejected({
      code: cause.code === 'DENIED' ? 'SOURCE_AUTHORITY_DENIED' : 'PERSISTENCE_UNAVAILABLE',
      reason: cause.reason,
    }),
    'cause',
    { configurable: true, value: cause },
  );

const rejectionReasons = {
  SOURCE_AUTHORITY_DENIED: 'The current route and actor are not authorized for this Membership source',
  SOURCE_CONFLICT: 'The effect or source order conflicts with an accepted Membership operation',
  SOURCE_STALE: 'A newer Membership operation has already been accepted for this source and Profile',
  TARGET_INELIGIBLE: 'The exact Profile or Group cannot receive the requested Membership operation',
  TARGET_NOT_FOUND: 'A required Customer Group Membership target is absent',
} as const;

export interface CustomerGroupMembershipSourceOperations {
  readonly admitSnapshot: (
    payload: AdmitCustomerGroupMembershipSnapshotPayload,
    invocationId: string,
    recordedAt: string,
  ) => Effect.Effect<
    Readonly<{ replayed: boolean; result: AdmitCustomerGroupMembershipSnapshotResult }>,
    CustomerGroupMembershipSourceRejected
  >;
  readonly apply: (
    payload: ApplyCustomerGroupMembershipSourcePayload,
    invocationId: string,
    recordedAt: string,
  ) => Effect.Effect<
    Readonly<{ replayed: boolean; result: typeof ApplyCustomerGroupMembershipSourceResultSchema.Type }>,
    CustomerGroupMembershipSourceRejected
  >;
  readonly recover: (
    input: CustomerGroupMembershipSourceReceiptRequest,
  ) => Effect.Effect<typeof ApplyCustomerGroupMembershipSourceResultSchema.Type, CustomerGroupMembershipSourceRejected>;
}

export const customerGroupMembershipSourceServiceFactory: ReadServiceFactory<
  CustomerGroupMembershipSourceOperations,
  CommerceSourceProcessingEligibility
> = Effect.fn('customerGroupMembershipSourceServiceFactory')(function* membershipSourceServices(transaction, scope) {
  const privacy = yield* CommerceSourceProcessingEligibility;
  const checkPrivacy = Effect.fn('CustomerGroupMembershipSource.checkPrivacy')(function* checkPrivacy(
    input: Pick<CustomerGroupMembershipSourceReceiptRequest, 'manager' | 'profile' | 'route' | 'processingKind'>,
    source: (typeof ApplyCustomerGroupMembershipSourceResultSchema.Type)['source'],
    operation: typeof WRITE_PRIVACY_OPERATION | typeof RECOVER_PRIVACY_OPERATION,
    operationRequirementKey:
      | typeof ADMIT_PRIVACY_REQUIREMENT
      | typeof WRITE_PRIVACY_REQUIREMENT
      | typeof RECOVER_PRIVACY_REQUIREMENT
      | typeof ORG_ADMIT_PRIVACY_REQUIREMENT
      | typeof ORG_WRITE_PRIVACY_REQUIREMENT
      | typeof ORG_RECOVER_PRIVACY_REQUIREMENT,
    ownerIntent:
      | ApplyCustomerGroupMembershipSourcePayload
      | CustomerGroupMembershipSourceReceiptRequest
      | AdmitCustomerGroupMembershipSnapshotPayload,
  ) {
    if (input.manager.tenantId !== scope.tenantId || input.profile.profileRef.tenantId !== scope.tenantId) {
      return yield* new CustomerGroupMembershipSourceRejected({
        code: 'SOURCE_SCOPE_MISMATCH',
        reason: 'Customer Group source Membership must belong to the trusted Tenant',
      });
    }
    const [row] = yield* transaction
      .invoke(membershipSourceProfileRoutine, [input.profile.profileRef.resourceId, input.profile.profileKind])
      .pipe(Effect.mapError(unavailable));
    const profile = row?.payload;
    if (
      row?.outcome !== 'PROFILE_AVAILABLE' ||
      profile === null ||
      profile === undefined ||
      profile.profileId !== input.profile.profileRef.resourceId ||
      profile.profileKind !== input.profile.profileKind ||
      (operation === WRITE_PRIVACY_OPERATION && profile.state !== 'ACTIVE')
    ) {
      return yield* new CustomerGroupMembershipSourceRejected({
        code: 'TARGET_INELIGIBLE',
        reason: 'The exact Customer Profile is not Current and eligible',
      });
    }
    if (input.processingKind === 'ORG_BUSINESS_REFERENCE') {
      const organization = yield* Effect.serviceOption(CommerceOrganizationBusinessEligibility);
      if (Option.isNone(organization) || input.profile.profileKind !== 'COUNTERPARTY') {
        return yield* unavailable();
      }
      const intent = {
        consumerModuleId: 'commerce.customer-context',
        expectedProfileRevision: profile.revision,
        inputDigest: computeCanonicalValueHash(ownerIntent),
        kind: 'COUNTERPARTY_PROFILE',
        profileRef: input.profile.profileRef,
        projectionVersion: ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
      } as const;
      const recoveryIntent = {
        ...intent,
        fields: ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
        operation: RECOVER_PRIVACY_OPERATION,
      } as const;
      const recoveryRequest =
        profile.state === 'ACTIVE' ? recoveryIntent : ({ ...recoveryIntent, identityState: 'HISTORICAL' } as const);
      const request =
        operation === WRITE_PRIVACY_OPERATION
          ? ({ ...intent, fields: ORGANIZATION_MEMBERSHIP_WRITE_FIELDS, operation: WRITE_PRIVACY_OPERATION } as const)
          : recoveryRequest;
      yield* organization.value.check(scope, request, operationRequirementKey).pipe(Effect.mapError(privacyRejected));
      return yield* Effect.void;
    }
    yield* privacy
      .check(
        scope,
        {
          operation,
          source: {
            issuer: input.manager.issuer,
            namespace: input.manager.sourceNamespace,
            occurrenceId: source.assertionId,
            recordId: source.sourceRecordId,
            recordType: input.manager.factFamily,
            routeRef: input.route.id,
          },
          target: {
            kind: profile.profileKind === 'RETAIL' ? 'RETAIL_CUSTOMER_PROFILE' : 'COUNTERPARTY_PURCHASING_PROFILE',
            resourceId: profile.profileId,
          },
        },
        operationRequirementKey,
      )
      .pipe(Effect.mapError(privacyRejected));
    return yield* Effect.void;
  });
  return {
    admitSnapshot: Effect.fn('CustomerGroupMembershipSource.admitSnapshot')(
      function* admitSnapshot(payload, invocationId, recordedAt) {
        const requirement =
          payload.snapshot.processingKind === 'ORG_BUSINESS_REFERENCE'
            ? ORG_ADMIT_PRIVACY_REQUIREMENT
            : ADMIT_PRIVACY_REQUIREMENT;
        yield* requireModuleOperation(requirement).pipe(Effect.mapError(unavailable));
        yield* checkPrivacy(payload.snapshot, payload.snapshot.source, WRITE_PRIVACY_OPERATION, requirement, payload);
        const [row] = yield* transaction
          .invoke(admitMembershipSnapshotRoutine, [scope.principalId, invocationId, recordedAt, payload])
          .pipe(Effect.mapError(unavailable));
        if (row === undefined) {
          return yield* unavailable();
        }
        if (row.outcome !== 'APPLIED' && row.outcome !== 'REPLAY') {
          return yield* new CustomerGroupMembershipSourceRejected({
            code: row.outcome,
            reason: rejectionReasons[row.outcome],
          });
        }
        const result = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotResultSchema, {
          onExcessProperty: 'error',
        })(row.result).pipe(Effect.mapError(unavailable));
        return { replayed: row.outcome === 'REPLAY', result };
      },
    ),
    apply: Effect.fn('CustomerGroupMembershipSource.apply')(
      function* applyMembershipSource(payload, invocationId, recordedAt) {
        const requirement =
          payload.processingKind === 'ORG_BUSINESS_REFERENCE'
            ? ORG_WRITE_PRIVACY_REQUIREMENT
            : WRITE_PRIVACY_REQUIREMENT;
        yield* requireModuleOperation(requirement).pipe(Effect.mapError(unavailable));
        yield* checkPrivacy(payload, payload.source, WRITE_PRIVACY_OPERATION, requirement, payload);
        const [row] = yield* transaction
          .invoke(applyMembershipSourceRoutine, [scope.principalId, invocationId, recordedAt, payload])
          .pipe(Effect.mapError(unavailable));
        if (row === undefined) {
          return yield* unavailable();
        }
        if (row.outcome !== 'APPLIED' && row.outcome !== 'REPLAY') {
          return yield* new CustomerGroupMembershipSourceRejected({
            code: row.outcome,
            reason: rejectionReasons[row.outcome],
          });
        }
        const result = yield* decodeResult(row.result).pipe(Effect.mapError(unavailable));
        if (row.outcome === 'REPLAY') {
          yield* checkPrivacy(payload, result.source, RECOVER_PRIVACY_OPERATION, requirement, payload);
        }
        return { replayed: row.outcome === 'REPLAY', result };
      },
    ),
    recover: Effect.fn('CustomerGroupMembershipSource.recover')(function* recoverMembershipSource(input) {
      const requirement =
        input.processingKind === 'ORG_BUSINESS_REFERENCE'
          ? ORG_RECOVER_PRIVACY_REQUIREMENT
          : RECOVER_PRIVACY_REQUIREMENT;
      yield* requireModuleOperation(requirement).pipe(Effect.mapError(unavailable));
      const [row] = yield* transaction
        .invoke(readMembershipSourceReceiptRoutine, [scope.principalId, input])
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* unavailable();
      }
      if (row.outcome !== 'FOUND') {
        return yield* new CustomerGroupMembershipSourceRejected({
          code: row.outcome,
          reason: rejectionReasons[row.outcome],
        });
      }
      const result = yield* decodeResult(row.result).pipe(Effect.mapError(unavailable));
      // The recovery source comes from the original owner receipt, never caller-supplied evidence.
      yield* checkPrivacy(input, result.source, RECOVER_PRIVACY_OPERATION, requirement, input);
      return result;
    }),
  };
});
