import { Effect, Schema } from 'effect';

import { BindInitialVariantSourcePayloadSchema } from '../actions/bind-initial-variant-source.ts';
import { CorrectProductPayloadSchema } from '../actions/correct-product.ts';
import { CreateProductPayloadSchema } from '../actions/create-product.ts';
import { CreateVariantPayloadSchema } from '../actions/create-variant.ts';
import { SetVariantLocalizedFactsPayloadSchema } from '../actions/set-variant-localized-facts.ts';
import { UpdateProductPayloadSchema } from '../actions/update-product.ts';

/** These scope-wide native Actions declare no resource or owner permission target. Core hashes {}.
 * Product/Variant references in their business payload must never be promoted into that target.
 * This is request metadata, not permission or a settlement receipt. */
const requestIdentity = <Decoded, Encoded, ActionKey extends string, Version extends '1' | '2'>(
  schema: Schema.Codec<Decoded, Encoded>,
  payload: Schema.Json,
  actionKey: ActionKey,
  schemaVersion: Version,
) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(payload).pipe(
    Effect.flatMap(Schema.encodeEffect(schema)),
    Effect.map((normalizedPayload) => ({
      actionKey,
      normalizedPayload,
      owningModuleKey: 'commerce.catalog' as const,
      schemaVersion,
      target: {},
    })),
  );

export const createProductRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(CreateProductPayloadSchema, payload, 'commerce.catalog.create-product', '2');

export const createVariantRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(CreateVariantPayloadSchema, payload, 'commerce.catalog.create-variant', '2');

export const updateProductRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(UpdateProductPayloadSchema, payload, 'commerce.catalog.update-product', '1');

export const correctProductRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(CorrectProductPayloadSchema, payload, 'commerce.catalog.correct-product', '1');

export const bindInitialVariantSourceRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(BindInitialVariantSourcePayloadSchema, payload, 'commerce.catalog.bind-initial-variant-source', '1');

export const setVariantLocalizedFactsRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(SetVariantLocalizedFactsPayloadSchema, payload, 'commerce.catalog.set-variant-localized-facts', '1');
