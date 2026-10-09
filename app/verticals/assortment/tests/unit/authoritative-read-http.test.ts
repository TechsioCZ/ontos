import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PurchaseApi, PurchaseRequestSchema, PurchaseUnavailableProblemSchema } from '../../shared/apis/purchase.ts';
import {
  VisibilityApi,
  VisibilityRequestSchema,
  VisibilityUnavailableProblemSchema,
} from '../../shared/apis/visibility.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});

const visibilityPayload = Schema.decodeUnknownSync(VisibilityRequestSchema)({
  decisionPurpose: 'VISIBILITY',
  productRef: ref('catalog.owner', 'catalog.product', 'product-1'),
  subject: {
    guestEvidence: {
      evidenceRef: ref('party.registry', 'party.registry.guest-evidence', 'guest-1'),
      ownerModuleId: 'party.registry',
    },
    kind: 'GUEST_PURCHASE_CONTEXT',
  },
  trustedContextRef: ref('commerce.gateway', 'commerce.gateway.trusted-context', 'context-1'),
});

const purchasePayload = Schema.decodeUnknownSync(PurchaseRequestSchema)({
  constituent: {
    catalogSelection: {
      configuration: { kind: 'NONE' },
      productRef: ref('catalog.owner', 'catalog.product', 'product-1'),
      variantKind: 'ATOMIC',
      variantRef: ref('catalog.owner', 'catalog.variant', 'variant-1'),
    },
    role: 'TOP_LEVEL',
  },
  decisionPurpose: 'PURCHASE',
  subject: visibilityPayload.subject,
  trustedContextRef: visibilityPayload.trustedContextRef,
});

it('declares retryable 503 problems for Visibility and Purchase', () => {
  for (const problemSchema of [VisibilityUnavailableProblemSchema, PurchaseUnavailableProblemSchema]) {
    expect(problemSchema.ast.annotations?.httpApiStatus).toBe(503);
  }
});

it.live('serves and decodes the generated Visibility retryable problem', () =>
  Effect.gen(function* visibilityHttpProblem() {
    const problem = VisibilityUnavailableProblemSchema.make({
      detail: 'The owner decision source is unavailable.',
      retryable: true,
      status: 503,
      title: 'Visibility unavailable',
      type: 'https://ontos.dev/problems/visibility-unavailable',
    });
    const handlers = HttpApiBuilder.group(VisibilityApi, 'visibility', (builder) =>
      builder.handle('execute', () => Effect.fail(problem)),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(VisibilityApi).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
          { disableLogger: true },
        ),
      ),
      (webHandler) => Effect.promise(() => webHandler.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(
        new Request('https://assortment-read.ontos.test/reads/visibility', {
          body: JSON.stringify(visibilityPayload),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        Context.empty(),
      ),
    );
    expect(response.status).toBe(503);
    const body = yield* Effect.promise(() => response.json());
    expect(Schema.decodeUnknownSync(VisibilityUnavailableProblemSchema)(body)).toEqual(problem);
  }),
);

it.live('serves and decodes the generated Purchase retryable problem', () =>
  Effect.gen(function* purchaseHttpProblem() {
    const problem = PurchaseUnavailableProblemSchema.make({
      detail: 'The owner decision source is unavailable.',
      retryable: true,
      status: 503,
      title: 'Purchase unavailable',
      type: 'https://ontos.dev/problems/purchase-unavailable',
    });
    const handlers = HttpApiBuilder.group(PurchaseApi, 'purchase', (builder) =>
      builder.handle('execute', () => Effect.fail(problem)),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(PurchaseApi).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
          { disableLogger: true },
        ),
      ),
      (webHandler) => Effect.promise(() => webHandler.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(
        new Request('https://assortment-read.ontos.test/reads/purchase', {
          body: JSON.stringify(purchasePayload),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        Context.empty(),
      ),
    );
    expect(response.status).toBe(503);
    const body = yield* Effect.promise(() => response.json());
    expect(Schema.decodeUnknownSync(PurchaseUnavailableProblemSchema)(body)).toEqual(problem);
  }),
);
