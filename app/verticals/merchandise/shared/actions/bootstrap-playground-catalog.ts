import { Schema } from 'effect';
import {
  BootstrapBatchSchema,
  BootstrapManifestSchema,
  PLAYGROUND_SOURCE_FINGERPRINT,
} from '../domain/playground-catalog-bootstrap.ts';

export { PlaygroundBootstrapRejected } from '../domain/playground-catalog-bootstrap.ts';
export const BootstrapPlaygroundCatalogPayloadSchema = Schema.Union([
  Schema.TaggedStruct('Begin', {
    confirmation: Schema.Literal('Initialize empty AKROS playground from the approved frozen source'),
    manifest: BootstrapManifestSchema,
  }),
  Schema.TaggedStruct('Batch', {
    batch: BootstrapBatchSchema,
    index: Schema.Int.check(Schema.isBetween({ maximum: 999, minimum: 0 })),
    sourceFingerprint: Schema.Literal(PLAYGROUND_SOURCE_FINGERPRINT),
  }),
  Schema.TaggedStruct('Verify', { sourceFingerprint: Schema.Literal(PLAYGROUND_SOURCE_FINGERPRINT) }),
]);
export const BootstrapPlaygroundCatalogResultSchema = Schema.Struct({
  nextBatch: Schema.Int,
  sourceFingerprint: Schema.Literal(PLAYGROUND_SOURCE_FINGERPRINT),
  status: Schema.Literals(['IMPORTING', 'VERIFIED']),
});
export type BootstrapPlaygroundCatalogPayload = typeof BootstrapPlaygroundCatalogPayloadSchema.Type;
export type BootstrapPlaygroundCatalogResult = typeof BootstrapPlaygroundCatalogResultSchema.Type;
