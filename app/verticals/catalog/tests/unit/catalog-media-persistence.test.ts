import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogDocumentResourceRefSchema } from '../../shared/domain/catalog-media-assignment.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { catalogMediaPersistenceForScope } from '../../src/persistence/catalog-media-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000005';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:media-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'media-test',
};
const subjectRef = Schema.decodeUnknownSync(ProductRefSchema)({
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
});
const resourceRef = Schema.decodeUnknownSync(CatalogDocumentResourceRefSchema)({
  moduleId: 'commerce.documents',
  resourceId: '00000000-0000-4000-8000-000000000007',
  resourceType: 'commerce.documents.document',
  tenantId,
});
const input = {
  actionInvocationId: '00000000-0000-4000-8000-000000000006',
  assignmentId: '00000000-0000-4000-8000-000000000003',
  evidenceRefs: ['catalog:media-test'],
  expectedSetRevision: 0,
  order: 1,
  principalId,
  purpose: 'Photograph',
  reason: 'Verified assignment',
  resourceKind: 'MEDIA' as const,
  resourceRef,
  subjectRef,
};
const forbiddenTransaction = new Proxy(
  {},
  {
    get: () => {
      throw new Error('transaction touched');
    },
  },
);

describe('Catalog media persistence', () => {
  it.effect('rejects a cross-tenant Resource without touching storage', () =>
    Effect.gen(function* crossTenant() {
      // @ts-expect-error No database operation is allowed in this path.
      const service = catalogMediaPersistenceForScope(forbiddenTransaction, scope);
      const result = yield* service.assign({
        ...input,
        resourceRef: {
          ...resourceRef,
          tenantId: '00000000-0000-4000-8000-000000000099',
        },
      });
      expect(
        Match.value(result).pipe(
          Match.tag('invalid_change', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('rejects an invalid order without touching storage', () =>
    Effect.gen(function* invalidOrder() {
      // @ts-expect-error No database operation is allowed in this path.
      const service = catalogMediaPersistenceForScope(forbiddenTransaction, scope);
      const result = yield* service.assign({ ...input, order: 0 });
      expect(
        Match.value(result).pipe(
          Match.tag('invalid_change', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );
});
