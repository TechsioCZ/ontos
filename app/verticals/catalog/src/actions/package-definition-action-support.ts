import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect, Match } from 'effect';

import { PackageDefinitionActionError } from '../../shared/actions/package-definition-contract.ts';
import type { PackageMutationOutcome, PackagePersistence } from '../persistence/package-persistence.ts';
import { packagePersistenceForScope } from '../persistence/package-persistence.ts';
import { packageContentBasisForTransaction } from '../persistence/package-content-basis.ts';

export { packageContentBasisForTransaction } from '../persistence/package-content-basis.ts';

type ScopedTransaction = Parameters<typeof packagePersistenceForScope>[0];
const moduleId = 'commerce.catalog';

export const packageDefinitionPersistenceServiceFactory = (
  transaction: ScopedTransaction,
  scope: Parameters<typeof packagePersistenceForScope>[1],
) =>
  Effect.succeed(packagePersistenceForScope(transaction, scope, packageContentBasisForTransaction(transaction, scope)));

const packageDefinitionUnavailable = () =>
  new PackageDefinitionActionError({
    code: 'package_definition_unavailable',
    reason: 'Authoritative Package Definition persistence or Current basis is unavailable',
  });

export const mapPackagePersistenceError = () => packageDefinitionUnavailable();

export const recordPackageDefinitionAccess = (
  context: ActionHandlerContext<Readonly<Record<string, never>>, PackagePersistence>,
  definitionId: string,
) =>
  context.recordDataAccess({
    accessKind: 'read',
    queryHash: `catalog-package-definition:${definitionId}`,
    resultCount: 1,
    servingModuleKey: moduleId,
    targetModuleKey: moduleId,
    targetResourceId: definitionId,
    targetResourceType: 'commerce.catalog.package-definition',
  });

export const resolvePackageMutation = (outcome: PackageMutationOutcome) =>
  Match.value(outcome).pipe(
    Match.tags({
      created: ({ contentRevision, definitionRef }) => Effect.succeed({ contentRevision, definitionRef }),
      retired: ({ contentRevision, definitionRef }) => Effect.succeed({ contentRevision, definitionRef }),
      revised: ({ contentRevision, definitionRef }) => Effect.succeed({ contentRevision, definitionRef }),
    }),
    Match.tag('stale', () =>
      Effect.fail(
        new PackageDefinitionActionError({
          code: 'package_definition_stale',
          reason: 'Package Definition Current revision changed',
        }),
      ),
    ),
    Match.tag('invalid', ({ reason }) =>
      Effect.fail(new PackageDefinitionActionError({ code: 'package_definition_invalid', reason })),
    ),
    Match.tag('not_found', () =>
      Effect.fail(
        new PackageDefinitionActionError({
          code: 'package_definition_invalid',
          reason: 'Package Definition was not found in the trusted Tenant',
        }),
      ),
    ),
    Match.exhaustive,
  );
