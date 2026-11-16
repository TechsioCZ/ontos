import { CustomerGroupMembershipSourceReceiptRequestSchema } from '@app/commerce-customer-context/api/customer-group-membership-source-receipt';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { issueDelegatedGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Effect, Redacted, Schema } from 'effect';

import { customerFixtureUuid } from './symmy-c14-customer-native-authority.mts';
import { customerWorkerKey } from './symmy-c14-customer-rules.mts';
import { membershipActionKey } from './symmy-c14-membership-rules.mts';

const uuid = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('MembershipFixtureId'),
  Schema.decodeTo(Schema.String),
);
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const text = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('MembershipFixtureText'),
  Schema.decodeTo(Schema.String),
);
export const MembershipNativeInvocationSchema = Schema.Struct({
  actionInvocationId: uuid,
  actionKey: Schema.Literal(membershipActionKey),
  authContextRef: Schema.String,
  idempotencyKey: text,
  principalId: TrustedPrincipalContextSchema.fields.principalId,
  requestHash: digest,
});
const inputSchema = Schema.Struct({
  compositionRevision: digest,
  deliveryId: uuid,
  expectedReadPrincipalId: TrustedPrincipalContextSchema.fields.principalId,
  legalEntityId: uuid,
  moduleApiKey: Schema.Redacted(Schema.String),
  nativeAction: MembershipNativeInvocationSchema,
  operationRequirementKey: text,
  request: CustomerGroupMembershipSourceReceiptRequestSchema,
  shellGatewayBaseUrl: Schema.String,
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
});
class MembershipFixtureRecoveryUnavailable extends Schema.TaggedError<MembershipFixtureRecoveryUnavailable>()(
  'MembershipFixtureRecoveryUnavailable',
  { reason: Schema.String },
) {}
const unavailable = () =>
  new MembershipFixtureRecoveryUnavailable({ reason: 'Exact native Membership recovery authority was not issued' });

/** Shell verifies the original actual delivery and full Core invocation tuple; no authority is invented here. */
export const issueMembershipFixtureRecovery = Effect.fn('SymmyC14Membership.issueRecovery')(
  function* issueMembershipFixtureRecovery(input: typeof inputSchema.Type) {
    if (input.nativeAction.authContextRef !== `job:${customerWorkerKey}:run:${input.deliveryId}`) {
      return yield* unavailable();
    }
    const request = yield* Schema.decodeUnknownEffect(CustomerGroupMembershipSourceReceiptRequestSchema)(input.request);
    const requestHash = yield* Effect.try({ catch: unavailable, try: () => computeCanonicalValueHash(request) });
    const requestCorrelation = yield* customerFixtureUuid;
    const issued = yield* issueDelegatedGatewayContext(
      {
        audience: 'commerce-customer-context',
        compositionRevision: input.compositionRevision,
        exchangeId: yield* customerFixtureUuid,
        legalEntityScope: 'subject',
        subject: {
          _tag: 'RegisteredRecovery',
          declarationKey: 'commerce.customer-context.customer-group-membership-source-receipt.read',
          expectedPrincipalId: input.expectedReadPrincipalId,
          operationRequirementKey: input.operationRequirementKey,
          originalActionKey: input.nativeAction.actionKey,
          originalIdempotencyKey: input.nativeAction.idempotencyKey,
          originalPrincipalId: input.nativeAction.principalId,
          originalRequestHash: input.nativeAction.requestHash,
          requestHash,
          source: {
            _tag: 'HistoricalDelivery',
            deliveryId: input.deliveryId,
            legalEntityId: input.legalEntityId,
            tenantId: input.tenantId,
            workerKey: customerWorkerKey,
          },
        },
      },
      { apiKey: input.moduleApiKey, baseUrl: input.shellGatewayBaseUrl, requestCorrelation },
    );
    if (
      issued.recovery?.originalActionInvocationId !== input.nativeAction.actionInvocationId ||
      issued.machineContext?.principalId !== input.expectedReadPrincipalId
    ) {
      return yield* unavailable();
    }
    return {
      authorization: Redacted.make(`Bearer ${issued.token}`),
      baseUrl: new URL(issued.apiBaseUrl, input.shellGatewayBaseUrl).href,
      compositionRevision: issued.compositionRevision,
      request,
      requestCorrelation,
    };
  },
);
