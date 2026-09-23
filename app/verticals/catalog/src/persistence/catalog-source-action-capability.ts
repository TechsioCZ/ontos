import type { OperationalScope } from '@app/core-runtime';
import { Context } from 'effect';
import type { Schema } from 'effect';

import type { CatalogLocalOverrideOperation } from '../domain/catalog-local-override.ts';
import type { CatalogResolvedCurrentEventPorts } from './catalog-source-resolution-ports.ts';
import type { CatalogImportAcceptanceOperations } from './catalog-import-acceptance-service.ts';
import type { CatalogLocalOverrideOperations } from './catalog-local-override-service.ts';

export interface CatalogSourceActionOperationContext {
  readonly actionInvocationId: string;
  readonly at: Date;
  readonly events: CatalogResolvedCurrentEventPorts<Schema.Json>;
  readonly principalId: string;
}

export interface CatalogLocalOverrideActionPersistence {
  readonly localOverrideAt: (
    context: CatalogSourceActionOperationContext,
  ) => CatalogLocalOverrideOperations<Schema.Json>;
}

export interface CatalogImportSourceActionPersistence {
  readonly importAcceptanceAt: (
    context: CatalogSourceActionOperationContext,
  ) => CatalogImportAcceptanceOperations<Schema.Json>;
}

export interface CatalogLocalOverrideActionFactoryInput {
  readonly allowedOverrideOperation: CatalogLocalOverrideOperation;
  readonly scope: OperationalScope;
}

export interface CatalogSourceActionPersistenceFactoryService {
  readonly makeImport: <Transaction>(
    transaction: Transaction,
    scope: OperationalScope,
  ) => CatalogImportSourceActionPersistence;
  readonly makeLocalOverride: <Transaction>(
    transaction: Transaction,
    input: CatalogLocalOverrideActionFactoryInput,
  ) => CatalogLocalOverrideActionPersistence;
}

export class CatalogSourceActionPersistenceFactory extends Context.Service<
  CatalogSourceActionPersistenceFactory,
  CatalogSourceActionPersistenceFactoryService
>()('@app/catalog/persistence/catalog-source-action-capability/CatalogSourceActionPersistenceFactory') {}
