import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

import { appRoot, collectCases, effectNativeRule, virtualFile } from './rule-tester.mts';

const rule = 'no-dependency-parameters';
const boundaryPath = 'packages/core-runtime/src/actions/owner-proof-preflight.ts';
const boundary = `import { Context, Effect } from 'effect';
import type { ReadServiceFactory } from '../reads/definition.ts';
export interface ActionAuthorizationPreflightDatabaseService {
  readonly read: <Services, Value, Failure, Requirements = never>(
    scope: OperationalScope,
    serviceFactory: ReadServiceFactory<Services, Requirements>,
    read: (services: Services) => Effect.Effect<Value, Failure, Requirements>,
    compositionRevision?: string,
  ) => Effect.Effect<Value, Failure | OperationContextUnavailable, Requirements>;
}
export class ActionAuthorizationPreflightDatabase extends Context.Service<
  ActionAuthorizationPreflightDatabase,
  ActionAuthorizationPreflightDatabaseService
>()('ActionAuthorizationPreflightDatabase') {}
`;

const { accept, register, reject } = collectCases(
  effectNativeRule(rule),
  'Core scoped-read construction is not product dependency threading',
  { filename: virtualFile(boundaryPath) },
);

accept(boundary);
accept(
  boundary
    .replaceAll('ReadServiceFactory', 'OwnerServiceFactory')
    .replace('import type { OwnerServiceFactory }', 'import type { ReadServiceFactory as OwnerServiceFactory }'),
);
const actualBoundary = readFileSync(nodePath.join(appRoot, boundaryPath), 'utf-8');
accept(actualBoundary.slice(0, actualBoundary.indexOf('const transactionFailure')));

reject(1, boundary, { filename: virtualFile('verticals/orders/src/owner-proof-preflight.ts') });
reject(1, boundary, { filename: virtualFile('packages/core-runtime/src/actions/product-port.ts') });
reject(1, boundary.replace("'../reads/definition.ts'", "'./product-port.ts'"));
reject(1, boundary.replace('readonly read:', 'readonly prepare:'));
reject(1, boundary.replaceAll('ActionAuthorizationPreflightDatabaseService', 'ProductDatabaseService'));
reject(1, boundary.replace("import { Context, Effect } from 'effect';", "import { Effect } from 'effect';"));
reject(
  1,
  boundary.replace('compositionRevision?: string,', 'compositionRevision?: string, product?: ProductRepository,'),
);
reject(
  1,
  `${boundary}
export const prepareProduct = (serviceFactory: ReadServiceFactory<unknown>) => Effect.succeed(serviceFactory);`,
);

register();
