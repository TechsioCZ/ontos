import { ApiKeyGatewayContextRequestSchema } from '@app/shared-contracts';
import { Effect, Option, Schema, SchemaGetter } from 'effect';
import { BadRequest } from 'effect/http-api/HttpApiError';

/**
 * Private decoding of the proxy's existing JSON envelope, not an owner DTO contract. Only fixed
 * metadata is validated here. Query validation and reserialization stay after API-key authorization.
 */
const ApiKeyGatewayReadMetadataSchema = Schema.Struct({
  audience: ApiKeyGatewayContextRequestSchema.fields.audience,
  legalEntityId: ApiKeyGatewayContextRequestSchema.fields.legalEntityId,
  readName: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u), Schema.isMaxLength(200)),
});

// Input comes only from the native JSON parser. Validate the required query's outer JSON kind,
// without traversing containers or rejecting parsed non-finite numbers before authorization.
const ApiKeyGatewayReadEnvelopeSchema = Schema.Struct({
  ...ApiKeyGatewayReadMetadataSchema.fields,
  query: Schema.Union([Schema.Null, Schema.Boolean, Schema.Number, Schema.String, Schema.ObjectKeyword]),
});

export type ApiKeyGatewayReadRequest = typeof ApiKeyGatewayReadMetadataSchema.Type & {
  readonly ownerBody: Effect.Effect<string, Schema.SchemaError>;
};

const decodeEnvelope = Schema.decodeUnknownEffect(ApiKeyGatewayReadEnvelopeSchema);
const stringifyJson = SchemaGetter.stringifyJson();
const parseJson = SchemaGetter.parseJson();

/**
 * Decode UTF-8 and JSON once, with the same replacement/BOM and duplicate-key behavior as the native
 * JSON request decoder. Payload failures retain native HTTP 400 handling.
 */
export const decodeApiKeyGatewayReadRequest = Effect.fn('ApiKeyGatewayReadTransport.decodeApiKeyGatewayReadRequest')(
  function* decodeGatewayReadTransport(
    payloadBytes: Uint8Array,
  ): Effect.fn.Return<ApiKeyGatewayReadRequest, BadRequest | Schema.SchemaError> {
    const parsed = yield* SchemaGetter.run(parseJson, Option.some(new TextDecoder().decode(payloadBytes)), {}).pipe(
      Effect.mapError((issue) => new Schema.SchemaError(issue)),
    );
    if (Option.isNone(parsed)) {
      return yield* BadRequest.singleton;
    }
    const { query, ...metadata } = yield* decodeEnvelope(parsed.value);
    return {
      ...metadata,
      ownerBody: Effect.suspend(() =>
        SchemaGetter.run(stringifyJson, Option.some(query), {}).pipe(
          Effect.mapError((issue) => new Schema.SchemaError(issue)),
          Effect.flatMap((encoded) => Schema.decodeUnknownEffect(Schema.String)(Option.getOrUndefined(encoded))),
        ),
      ),
    };
  },
  Effect.catchTag('SchemaError', () => Effect.fail(BadRequest.singleton)),
);
