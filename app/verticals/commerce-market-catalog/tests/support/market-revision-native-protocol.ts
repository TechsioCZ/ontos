import { SellingLegalEntityRefSchema, StorefrontRefSchema } from '../../shared/market-contracts.ts';
import { Effect, FileSystem, Path, Schema, Stream } from 'effect';
import type { Socket } from 'effect/socket';
import { ActiveApplicationCompositionSnapshotSchema, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { CreateMarketResultSchema, ReviseMarketDefinitionResultSchema } from '../../shared/action-contracts.ts';
import { MarketRefSchema } from '../../shared/resources/market.ts';
import { StorefrontAssociationRefSchema } from '../../shared/resources/storefront-association.ts';

const InvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ActionInvocationId'),
  Schema.decodeTo(Schema.String),
);
const ActionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'), Schema.decodeTo(Schema.String));
const ServingModuleKeySchema = Schema.String.pipe(Schema.brand('ServingModuleKey'), Schema.decodeTo(Schema.String));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
export const MarketRevisionNativeIssueSchema = Schema.Struct({
  audience: Schema.Literal('commerce-market-catalog'),
  compositionRevision: text,
  legalEntityId: SellingLegalEntityRefSchema.fields.resourceId,
  requestCorrelation: text,
});
const customerContextStateSchema = Schema.Literals(['active', 'suspended']);
export type MarketRevisionNativeCustomerContextState = typeof customerContextStateSchema.Type;
export const MarketRevisionNativeCommandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literals(['CLOSE_STOREFRONT', 'CREATE_R1', 'REVISE_R2', 'STOP']) }),
  Schema.Struct({ type: Schema.Literal('EVIDENCE') }),
  Schema.Struct({ input: MarketRevisionNativeIssueSchema, type: Schema.Literal('ISSUE') }),
  Schema.Struct({ state: customerContextStateSchema, type: Schema.Literal('SET_CCC_STATE') }),
]);
export const MarketRevisionNativeReadySchema = Schema.Struct({
  after: Schema.DateTimeUtcFromString,
  associationRef: StorefrontAssociationRefSchema,
  baseUrl: Schema.URLFromString,
  before: Schema.DateTimeUtcFromString,
  compositionRevision: text,
  legalEntityId: SellingLegalEntityRefSchema.fields.resourceId,
  marketRef: MarketRefSchema,
  now: Schema.DateTimeUtcFromString,
  principal: TrustedPrincipalContextSchema,
  relaySourcePrincipalId: TrustedPrincipalContextSchema.fields.principalId,
  revisedAt: Schema.DateTimeUtcFromString,
  sellerRef: SellingLegalEntityRefSchema,
  snapshot: ActiveApplicationCompositionSnapshotSchema,
  storefrontRef: StorefrontRefSchema,
  tenantId: MarketRefSchema.fields.tenantId,
  type: Schema.Literal('READY'),
});
export const MarketRevisionNativeIssueFailureStageSchema = Schema.Literals([
  'INPUT_SCOPE_INVALID',
  'SHELL_GATEWAY_UNAVAILABLE',
  'ADMISSION_MISMATCH',
]);
export const MarketRevisionNativeRetirementReservationSchema = Schema.Struct({
  lifecycle: Schema.Literals(['RESERVED', 'COMMITTED', 'RELEASED']),
  reservationVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export const MarketRevisionNativeEvidenceSchema = Schema.Struct({
  accesses: Schema.Array(
    Schema.Struct({
      outcome: text,
      outcomeCode: text,
      outcomeStage: text,
      principalId: TrustedPrincipalContextSchema.fields.principalId,
      servingModuleKey: ServingModuleKeySchema,
    }),
  ).check(Schema.isMaxLength(512)),
  admissions: Schema.Array(Schema.Struct({ status: Schema.Literals(['PENDING', 'COMMITTED', 'ABORTED']) })).check(
    Schema.isMaxLength(16),
  ),
  audits: Schema.Array(
    Schema.Struct({
      actionInvocationId: Schema.OptionFromNullOr(InvocationIdSchema),
      outcome: text,
      outcomeCode: text,
      outcomeStage: text,
      principalId: Schema.OptionFromNullOr(TrustedPrincipalContextSchema.fields.principalId),
      retirementReservation: Schema.OptionFromNullOr(MarketRevisionNativeRetirementReservationSchema),
    }),
  ).check(Schema.isMaxLength(512)),
  invocations: Schema.Array(
    Schema.Struct({
      actionInvocationId: InvocationIdSchema,
      actionKey: ActionKeySchema,
      principalId: Schema.OptionFromNullOr(TrustedPrincipalContextSchema.fields.principalId),
      status: text,
    }),
  ).check(Schema.isMaxLength(512)),
  outboxCount: Schema.Int,
  type: Schema.Literal('EVIDENCE'),
});
export const MarketRevisionNativeResponseSchema = Schema.Union([
  MarketRevisionNativeReadySchema,
  Schema.Struct({ result: CreateMarketResultSchema, type: Schema.Literal('CREATED') }),
  Schema.Struct({ result: ReviseMarketDefinitionResultSchema, type: Schema.Literal('REVISED') }),
  Schema.Struct({
    baseUrl: Schema.URLFromString,
    credential: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384))),
    type: Schema.Literal('ISSUED'),
  }),
  Schema.Struct({ stage: MarketRevisionNativeIssueFailureStageSchema, type: Schema.Literal('FAILED') }),
  Schema.Struct({ type: Schema.Literals(['STOREFRONT_CLOSED', 'STOPPED', 'UNAVAILABLE']) }),
  MarketRevisionNativeEvidenceSchema,
  Schema.Struct({ state: customerContextStateSchema, type: Schema.Literal('CCC_STATE_SET') }),
]);

// Closed TEST transport for the owning Market process. No business facts are produced here.
export class MarketRevisionNativeTransportError extends Schema.TaggedError<MarketRevisionNativeTransportError>()(
  'MarketRevisionNativeTransportError',
  { reason: Schema.String },
) {}
export const marketRevisionNativeSocketEnvironment = 'ONTOS_MARKET_REVISION_NATIVE_SOCKET';
export const marketRevisionNativeFrameLimit = 262_144;

export const validateMarketRevisionNativeSocket = Effect.fn('MarketRevisionNativeTransport.validateSocket')(
  function* validateMarketRevisionNativeSocket(socketPath: string) {
    const path = yield* Path.Path;
    const fail = () => new MarketRevisionNativeTransportError({ reason: 'Private Market socket is unavailable' });
    if (
      !path.isAbsolute(socketPath) ||
      socketPath.includes('\0') ||
      new TextEncoder().encode(socketPath).length > 96 ||
      path.basename(socketPath) !== 'market.sock'
    ) {
      return yield* fail();
    }
    const fs = yield* FileSystem.FileSystem;
    const directory = path.dirname(socketPath);
    const info = yield* fs.stat(directory).pipe(Effect.mapError(fail));
    if (info.type !== 'Directory' || info.mode % 0o1000 !== 0o700 || (yield* fs.realPath(directory)) !== directory) {
      return yield* fail();
    }
    const socket = yield* fs.stat(socketPath).pipe(Effect.mapError(fail));
    if (socket.type !== 'Socket') {
      return yield* fail();
    }
    return socketPath;
  },
);

/** Bound each newline-delimited frame before decoding or buffering a complete JSON record. */
export const marketRevisionNativeLines = (pull: Effect.Success<ReturnType<typeof Socket.readerBytes>>) => {
  let pending = 0;
  return Stream.fromPull(Effect.succeed(pull)).pipe(
    Stream.mapEffect((bytes) =>
      Effect.suspend(() => {
        for (const byte of bytes) {
          pending = byte === 10 ? 0 : pending + 1;
          if (pending > marketRevisionNativeFrameLimit) {
            return Effect.fail(
              new MarketRevisionNativeTransportError({ reason: 'Private Market frame exceeds its bound' }),
            );
          }
        }
        return Effect.succeed(bytes);
      }),
    ),
    Stream.decodeText(),
    Stream.splitLines,
  );
};
