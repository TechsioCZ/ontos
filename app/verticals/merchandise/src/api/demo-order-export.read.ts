import { ReadHandlerUnavailable, defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import {
  DemoOrderExportRequestSchema,
  DemoOrderExportResponseSchema,
  SYMMY_DEMO_ORDER_EXPORT_WORKLOAD,
} from '../../shared/apis/demo-order-export.ts';
import type { DemoOrderExportRequest } from '../../shared/apis/demo-order-export.ts';
import { orderPage } from '../services/merchandise-queries.ts';
import { assertMerchandiseSearchPublished } from '../services/catalog-publication.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'The persisted order export is temporarily unavailable',
    }),
    'cause',
    { configurable: false, enumerable: false, value: cause, writable: false },
  );

interface OrderExportServices {
  readonly read: (
    input: DemoOrderExportRequest,
  ) => Effect.Effect<typeof DemoOrderExportResponseSchema.Type, ReadHandlerUnavailable>;
}

const services: ReadServiceFactory<OrderExportServices> = (transaction, scope) =>
  Effect.succeed({
    read: Effect.fn('DemoOrderExport.read')(function* read(input: DemoOrderExportRequest) {
      if (scope.legalEntityId === undefined) {
        return yield* unavailable();
      }
      // Same company publication boundary as Merchandise search, with no Tax refresh or other write.
      yield* assertMerchandiseSearchPublished(transaction, scope).pipe(Effect.mapError(unavailable));
      const store = { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId };
      const page = { ordersLimit: input.limit, ordersOffset: input.offset };
      const view = input.orderId === undefined ? page : { ...page, orderId: input.orderId };
      // Reuse the owner query: explicit tenant + company predicates, RLS, removed-row exclusion and stable paging.
      const result = yield* orderPage(transaction, store, view).pipe(Effect.mapError(unavailable));
      return yield* Schema.decodeUnknownEffect(Schema.toType(DemoOrderExportResponseSchema))({
        ...store,
        count: result.total,
        orders: result.orders,
      }).pipe(Effect.mapError(unavailable));
    }),
  });

const demoOrderExportEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'demo.merchandise.api.demo-order-export',
  moduleKey: 'demo.merchandise',
  role: 'api',
});

export const demoOrderExportRead = defineRead(
  {
    accessDeclaration: {
      key: 'demo.merchandise.demo-order-export.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'merchandise', level: 'basic' },
      risk: 'sensitive',
      selectors: [],
    },
    accessKind: 'list',
    accessWorkload: {
      reason: 'The authenticated Symmy integration exports persisted orders for its enrolled selling company',
      workloads: [SYMMY_DEMO_ORDER_EXPORT_WORKLOAD],
    },
    entrypoint: demoOrderExportEntrypoint,
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'demo.merchandise.api.demo-order-export.evidence.v1',
    },
    inputSchema: DemoOrderExportRequestSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'demo.merchandise',
    policies: [],
    readKey: 'demo.merchandise.api.demo-order-export',
    resultSchema: DemoOrderExportResponseSchema,
    schemaVersion: '1',
  },
  (input, context) =>
    context.services
      .read(input)
      .pipe(Effect.map((result) => ({ evidence: { resultCount: result.orders.length }, result }))),
  services,
);
