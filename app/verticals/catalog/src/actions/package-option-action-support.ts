import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';

import type { ActivatePackageOptionPayload } from '../../shared/actions/activate-package-option.ts';
import { PackageOptionActionError } from '../../shared/actions/package-option-contract.ts';
import { PackageDefinitionSelectionRevisionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { PackageDefinitionRefSchema } from '../../shared/resources/package-definition.ts';
import {
  packageOptionPersistenceForScope,
  PackageOptionPersistenceUnavailable,
} from '../persistence/package-option-persistence.ts';
import type {
  PackageOptionPersistence,
  PackageOptionRoleBasis,
  PackageOptionSelectionImpact,
} from '../persistence/package-option-persistence.ts';

const moduleId = 'commerce.catalog';
const error = (
  code: 'package_option_invalid' | 'package_option_not_found' | 'package_option_stale' | 'package_option_unavailable',
  reason: string,
) => new PackageOptionActionError({ code, reason });
const unavailable = (cause: unknown, reason: string) => {
  const failure = error('package_option_unavailable', reason);
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};
const unproven = () =>
  new PackageOptionPersistenceUnavailable({
    code: 'package_option_persistence_unavailable',
    reason: 'Trusted Package Option proof is unavailable',
  });

/** Required proof ports are deliberately unavailable until their owners wire real authorities. */
const roleBasis: PackageOptionRoleBasis = { verify: () => Effect.fail(unproven()) };
const selectionImpact: PackageOptionSelectionImpact = { verify: () => Effect.fail(unproven()) };

export const packageOptionActionPersistenceServiceFactory = (
  transaction: Parameters<typeof packageOptionPersistenceForScope>[0],
  scope: Parameters<typeof packageOptionPersistenceForScope>[1],
) => Effect.succeed(packageOptionPersistenceForScope(transaction, scope, roleBasis, selectionImpact));

export const runPackageOptionTransition = Effect.fn('PackageOptionAction.transition')(
  function* runPackageOptionTransition(
    kind: 'ACTIVATE' | 'RETIRE',
    payload: ActivatePackageOptionPayload,
    context: ActionHandlerContext<Readonly<Record<string, never>>, PackageOptionPersistence>,
  ) {
    const expected = payload.expectedContent;
    if (expected.resourceRef.tenantId !== context.scope.tenantId || expected.revisionId !== undefined) {
      return yield* error(
        'package_option_invalid',
        'Package Option must reference Current content in the trusted Tenant',
      );
    }
    const input = {
      actionInvocationId: context.actionInvocationId,
      expectedContentRevision: expected.revision,
      expectedOptionRevision: payload.expectedOptionRevision,
      packageDefinitionId: expected.resourceRef.resourceId,
    };
    const outcome = yield* (
      kind === 'ACTIVATE' ? context.services.activate(input) : context.services.retire(input)
    ).pipe(Effect.mapError((cause) => unavailable(cause, 'Authoritative Package Option proof is unavailable')));
    const changed = yield* Match.value(outcome).pipe(
      Match.tag('changed', (value) => Effect.succeed(value)),
      Match.tag('invalid', ({ reason }) => Effect.fail(error('package_option_invalid', reason))),
      Match.tag('not_found', () => Effect.fail(error('package_option_not_found', 'Package Definition was not found'))),
      Match.tag('stale', () =>
        Effect.fail(error('package_option_stale', 'Package Option or content revision changed')),
      ),
      Match.exhaustive,
    );
    const definitionRef = yield* Schema.decodeEffect(PackageDefinitionRefSchema)({
      moduleId,
      resourceId: expected.resourceRef.resourceId,
      resourceType: 'commerce.catalog.package-definition',
      tenantId: context.scope.tenantId,
    }).pipe(Effect.mapError((cause) => unavailable(cause, 'Package Option result is unavailable')));
    const contentRevision = yield* Schema.decodeEffect(PackageDefinitionSelectionRevisionSchema)({
      resourceRef: definitionRef,
      revision: changed.contentRevision,
    }).pipe(Effect.mapError((cause) => unavailable(cause, 'Package Option result is unavailable')));
    yield* context.recordDataAccess({
      accessKind: 'read',
      queryHash: `catalog-package-option:${definitionRef.resourceId}`,
      resultCount: 1,
      servingModuleKey: moduleId,
      targetModuleKey: moduleId,
      targetResourceId: definitionRef.resourceId,
      targetResourceType: 'commerce.catalog.package-definition',
    });
    return { contentRevision, definitionRef, optionRevision: changed.optionRevision, state: changed.state };
  },
);
