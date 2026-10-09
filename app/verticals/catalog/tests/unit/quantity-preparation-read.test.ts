import { ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  QuantityPreparationRequestSchema,
  QuantityPreparationResponseSchema,
} from '../../shared/apis/quantity-preparation.ts';
import type { QuantityPreparationRequest } from '../../shared/apis/quantity-preparation.ts';
import { readQuantityPreparation, quantityPreparationRead } from '../../src/api/quantity-preparation.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const selection = {
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
} as const;
const request = Schema.decodeUnknownSync(QuantityPreparationRequestSchema)({
  amount: '2.537',
  purpose: 'PURCHASE_ACCEPTANCE',
  selection,
});

describe('Catalog governed Quantity preparation', () => {
  it.effect('publishes the generated client wrapper for the owner-governed read', () =>
    Effect.gen(function* loadsGeneratedClient() {
      const client = yield* Effect.promise(() => import('../../src/api/catalog-client.ts'));
      expect(client.executeQuantityPreparation).toBeTypeOf('function');
      expect(client.executeQuantityPreparationWithAuthorization).toBeTypeOf('function');
    }),
  );

  it.effect('returns the purpose-scoped Catalog handoff without claiming a commercial verdict', () =>
    Effect.gen(function* preparesHandoff() {
      const observed: unknown[] = [];
      const services = {
        prepare: (input: QuantityPreparationRequest) => {
          observed.push(input);
          return Effect.succeed({
            reason: 'Exact Current quantity basis is unavailable',
            status: 'UNVERIFIABLE',
          } as const);
        },
      };
      // @ts-expect-error The fake supplies the one owner-local service exercised by this read.
      const result = yield* readQuantityPreparation(request, tenantId, services);
      expect(observed).toEqual([request]);
      expect(result.status).toBe('UNVERIFIABLE');
      expect(() => Schema.encodeSync(QuantityPreparationResponseSchema)(result)).not.toThrow();
      expect(JSON.stringify(result)).not.toMatch(/allowed|approved|customer/iu);
    }),
  );

  it.effect('rejects a foreign Product before owner-local persistence', () =>
    Effect.gen(function* rejectsForeignProduct() {
      const services = { prepare: () => Effect.die('must not read') };
      const failure = yield* readQuantityPreparation(request, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', services).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
      expect(quantityPreparationRead.descriptor.permissionTarget).toBe('resource');
    }),
  );
});
