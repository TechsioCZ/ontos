import { SavedAddressSourceReceiptRequestSchema } from '@app/commerce-customer-context/api/saved-address-source-receipt';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { issueDelegatedGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Effect, Redacted, Schema } from 'effect';

import { customerFixtureUuid } from './symmy-c14-customer-native-authority.mts';
import { customerWorkerKey } from './symmy-c14-customer-rules.mts';

const fixtureIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerFixtureReferenceId'),
  Schema.decodeTo(Schema.String),
);
const digestSchema = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u));
const idempotencyKeySchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('NativeIdempotencyKey'),
  Schema.decodeTo(Schema.String),
);
const operationRequirementKeySchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('OperationRequirementKey'),
  Schema.decodeTo(Schema.String),
);
export const SavedAddressNativeInvocationSchema = Schema.Struct({
  actionInvocationId: fixtureIdSchema,
  actionKey: Schema.Literals([
    'commerce.customer-context.add-saved-address',
    'commerce.customer-context.update-saved-address',
    'commerce.customer-context.remove-saved-address',
  ]),
  authContextRef: Schema.String,
  idempotencyKey: idempotencyKeySchema,
  principalId: TrustedPrincipalContextSchema.fields.principalId,
  requestHash: digestSchema,
});
const InputSchema = Schema.Struct({
  compositionRevision: digestSchema,
  deliveryId: fixtureIdSchema,
  expectedReadPrincipalId: TrustedPrincipalContextSchema.fields.principalId,
  legalEntityId: fixtureIdSchema,
  moduleApiKey: Schema.Redacted(Schema.String),
  nativeAction: SavedAddressNativeInvocationSchema,
  operationRequirementKey: operationRequirementKeySchema,
  request: Schema.toEncoded(SavedAddressSourceReceiptRequestSchema),
  shellGatewayBaseUrl: Schema.String,
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
});

class SavedAddressFixtureRecoveryUnavailable extends Schema.TaggedError<SavedAddressFixtureRecoveryUnavailable>()(
  'SavedAddressFixtureRecoveryUnavailable',
  { reason: Schema.String },
) {}
const unavailable = () =>
  new SavedAddressFixtureRecoveryUnavailable({
    reason: 'The real Shell did not return the exact original SavedAddress recovery authority',
  });

/** Uses real retained delivery/Core evidence; the issuer independently verifies every tuple. */
export const issueSavedAddressFixtureRecovery = Effect.fn('SymmyC14SavedAddress.issueRecovery')(
  function* issueSavedAddressFixtureRecovery(input: typeof InputSchema.Type) {
    const request = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)(input.request);
    if (
      request.mode !== 'RECEIPT' ||
      input.nativeAction.authContextRef !== `job:${customerWorkerKey}:run:${input.deliveryId}`
    ) {
      return yield* unavailable();
    }
    const requestCorrelation = yield* customerFixtureUuid;
    const requestHash = yield* Effect.try({
      catch: unavailable,
      try: () => computeCanonicalValueHash(request),
    });
    const issued = yield* issueDelegatedGatewayContext(
      {
        audience: 'commerce-customer-context',
        compositionRevision: input.compositionRevision,
        exchangeId: yield* customerFixtureUuid,
        legalEntityScope: 'subject',
        subject: {
          _tag: 'RegisteredRecovery',
          declarationKey: 'commerce.customer-context.saved-address-source-receipt.read',
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
      {
        apiKey: input.moduleApiKey,
        baseUrl: input.shellGatewayBaseUrl,
        requestCorrelation,
      },
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
