import { SellingLegalEntityRefSchema } from '../../shared/market-contracts.ts';
import { Effect, FileSystem, Path, Schema, Stream } from 'effect';
import type { Socket } from 'effect/socket';
import { ActiveApplicationCompositionSnapshotSchema, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { CreateMarketResultSchema, ReviseMarketDefinitionResultSchema } from '../../shared/action-contracts.ts';
import { MarketRefSchema } from '../../shared/resources/market.ts';

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
export const MarketRevisionNativeIssueSchema = Schema.Struct({
  audience: Schema.Literal('commerce-market-catalog'),
  compositionRevision: text,
  legalEntityId: SellingLegalEntityRefSchema.fields.resourceId,
  requestCorrelation: text,
});
export const MarketRevisionNativeCommandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literals(['CREATE_R1', 'REVISE_R2', 'STOP']) }),
  Schema.Struct({ input: MarketRevisionNativeIssueSchema, type: Schema.Literal('ISSUE') }),
]);
export const MarketRevisionNativeReadySchema = Schema.Struct({
  after: Schema.DateTimeUtcFromString,
  baseUrl: Schema.URLFromString,
  before: Schema.DateTimeUtcFromString,
  compositionRevision: text,
  legalEntityId: SellingLegalEntityRefSchema.fields.resourceId,
  marketRef: MarketRefSchema,
  now: Schema.DateTimeUtcFromString,
  principal: TrustedPrincipalContextSchema,
  revisedAt: Schema.DateTimeUtcFromString,
  sellerRef: SellingLegalEntityRefSchema,
  snapshot: ActiveApplicationCompositionSnapshotSchema,
  tenantId: MarketRefSchema.fields.tenantId,
  type: Schema.Literal('READY'),
});
export const MarketRevisionNativeIssueFailureStageSchema = Schema.Literals([
  'INPUT_SCOPE_INVALID',
  'SHELL_GATEWAY_UNAVAILABLE',
  'ADMISSION_MISMATCH',
]);
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
  Schema.Struct({ type: Schema.Literals(['STOPPED', 'UNAVAILABLE']) }),
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
