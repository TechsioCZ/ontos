import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Schema, Struct } from 'effect';
import { encode as encodeHex } from 'effect/encoding/Hex';

import { CreateProductPayloadSchema } from '../../shared/actions/create-product.ts';
import type { catalogSourceCorrelations } from '../../src/database/schema.ts';

export const sourceProductIntentFixture = Effect.fn('sourceProductIntentFixture')(
  function* sourceProductIntentFixture(input: {
    readonly principalId: string;
    readonly productId: string;
    readonly tenantId: string;
    readonly variantId: string;
  }) {
    const sourceCorrelation = {
      initialVariantRecordId: 'variant:SKU:ready',
      issuerId: 'readiness-source',
      mappingRevision: 'mapping-1',
      recordId: 'product:SKU:ready',
      recordNamespace: 'products',
      routeScope: 'source-route',
      sourceOccurrenceId: 'new-batch-occurrence',
    };
    const sourceProduct = Schema.decodeUnknownSync(CreateProductPayloadSchema)({
      classification: { kind: 'INDEPENDENT_PRODUCT' },
      name: 'Ready product',
      reason: 'Symmy product import',
      sourceCorrelation,
      variantId: input.variantId,
    });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CreateProductPayloadSchema))({
      ...sourceProduct,
      sourceCorrelation: Struct.omit(sourceCorrelation, ['sourceOccurrenceId']),
    });
    const correlation = {
      actingPrincipalId: input.principalId,
      actionInvocationId: '99999999-9999-4999-8999-999999999998',
      entityKind: 'PRODUCT',
      intentFingerprint: encodeHex(sha256(utf8ToBytes(encoded))),
      issuerId: sourceCorrelation.issuerId,
      mappingRevision: sourceCorrelation.mappingRevision,
      productId: input.productId,
      recordId: sourceCorrelation.recordId,
      recordNamespace: sourceCorrelation.recordNamespace,
      routeScope: sourceCorrelation.routeScope,
      tenantId: input.tenantId,
      variantId: input.variantId,
    } satisfies typeof catalogSourceCorrelations.$inferInsert;
    return { correlation, sourceProduct };
  },
);
