import { ReadHandlerUnavailable, defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import {
  DemoCatalogRevisionRequestSchema,
  DemoCatalogRevisionResponseSchema,
  SYMMY_DEMO_CATALOG_IMPORT_WORKLOAD,
} from '../../shared/apis/demo-catalog-revision.ts';
import { loadHead } from '../services/merchandise-store.ts';

const unavailable = () =>
  new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'The company catalog revision is temporarily unavailable',
  });

interface RevisionServices {
  readonly read: Effect.Effect<typeof DemoCatalogRevisionResponseSchema.Type, ReadHandlerUnavailable>;
}

const services: ReadServiceFactory<RevisionServices> = (transaction, scope) =>
  Effect.succeed({
    read: Effect.gen(function* revision() {
      if (scope.legalEntityId === undefined) {
        return yield* unavailable();
      }
      const store = { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId };
      const head = yield* loadHead(transaction, store).pipe(Effect.mapError(unavailable));
      return yield* Schema.decodeUnknownEffect(Schema.toType(DemoCatalogRevisionResponseSchema))({
        ...store,
        revision: head?.revision ?? 0,
      }).pipe(Effect.mapError(unavailable));
    }),
  });

export const demoCatalogRevisionRead = defineRead(
  {
    accessDeclaration: {
      key: 'demo.merchandise.demo-catalog-revision.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'merchandise', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessKind: 'list',
    accessWorkload: {
      reason: 'The enrolled Symmy catalog importer reads its selected company head before a versioned import',
      workloads: [SYMMY_DEMO_CATALOG_IMPORT_WORKLOAD],
    },
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'demo.merchandise.api.demo-catalog-revision',
      moduleKey: 'demo.merchandise',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'demo.merchandise.api.demo-catalog-revision.evidence.v1',
    },
    inputSchema: DemoCatalogRevisionRequestSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'demo.merchandise',
    policies: [],
    readKey: 'demo.merchandise.api.demo-catalog-revision',
    resultSchema: DemoCatalogRevisionResponseSchema,
    schemaVersion: '1',
  },
  (_input, context) => context.services.read.pipe(Effect.map((result) => ({ evidence: { resultCount: 1 }, result }))),
  services,
);
