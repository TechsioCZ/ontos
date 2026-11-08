import { Effect, Option, Result } from 'effect';

import type { AnyActionRegistration } from '../../actions/definition.ts';
import { getRegisteredActionCommandReader } from '../../actions/definition.ts';
import { getActionGoverningRead } from '../../actions/governing-read.ts';
import { computeCanonicalValueHash } from '../../actions/repository.ts';
import type { ActiveApplicationCompositionServiceContract } from '../../modules/active-application-composition.ts';
import type { OntosDeploymentIdentitySchema } from '../../modules/manifest.ts';
import { loadModuleOperationAdmission, validateBoundOperationOwner } from '../../modules/module-operation-execution.ts';
import { getVerticalRuntimeActions, getVerticalRuntimeReads } from '../../modules/runtime-registration.ts';
import type { VerticalRuntimeRegistration } from '../../modules/runtime-registration.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { projectPublishedCatalog } from '../changes/publication.ts';
import type { CatalogSnapshot } from '../model.ts';
import { CapabilityKeySchema } from '../ids.ts';
import type { ActionCommandV2 } from './action-command-v2.ts';
import { rebindRegisteredActionCommandV2 } from './action-command-v2.ts';
import { ApprovalAuthorityUnavailableError, ApprovalRefusedError } from './errors.ts';
import { publishedCapabilityOf } from './live-catalog.ts';

/** Actual executable owner and its receiving release, never a descriptor copied from a catalog. */
interface RegisteredActionReleaseV2 {
  readonly applicationComposition: ActiveApplicationCompositionServiceContract;
  readonly expectedDeployment: typeof OntosDeploymentIdentitySchema.Type;
}
export type RegisteredActionOwnerV2 = RegisteredActionReleaseV2 &
  (
    | { readonly ownerRegistration: VerticalRuntimeRegistration; readonly registration?: never }
    | { readonly ownerRegistration?: never; readonly registration: AnyActionRegistration }
  );

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ApprovalAuthorityUnavailableError({
      code: 'approval_authority_unavailable',
      reason: 'The original Action and governing Read are not admitted by the current owner release',
    }),
    'cause',
    { value: cause },
  );

/**
 * Resolve only the original executable registration. Its private frozen-command reader proves the
 * full payload/targets/fields, and ordinary module admission proves both Action and governing Read.
 */
export const resolveRegisteredActionSourceV2 = Effect.fn('ActionApproval.resolveRegisteredSourceV2')(
  function* resolveRegisteredActionSourceV2(input: {
    readonly command: ActionCommandV2;
    readonly owners: readonly RegisteredActionOwnerV2[];
    readonly scope: OperationalScope;
  }) {
    const matches = yield* Effect.try({
      catch: unavailable,
      try: () =>
        input.owners.flatMap((owner) =>
          (owner.registration === undefined
            ? getVerticalRuntimeActions(owner.ownerRegistration)
            : [owner.registration]
          ).flatMap((registration) =>
            registration.descriptor.actionKey === input.command.actionKey ? [{ owner, registration }] : [],
          ),
        ),
    });
    const [selected] = matches;
    if (matches.length !== 1 || selected === undefined) {
      return yield* unavailable();
    }
    const { owner, registration } = selected;
    const admission = yield* loadModuleOperationAdmission(
      owner.applicationComposition,
      owner.expectedDeployment,
      registration,
      input.scope,
      owner.ownerRegistration,
    ).pipe(Effect.mapError(unavailable));
    if (admission.catalog !== undefined) {
      yield* validateBoundOperationOwner(registration, admission.catalog, owner.ownerRegistration).pipe(
        Effect.mapError(unavailable),
      );
    }
    const reader = getRegisteredActionCommandReader(registration);
    if (reader === undefined) {
      return yield* unavailable();
    }
    const read = getActionGoverningRead(reader.descriptor.accessGoverningRead);
    if (read !== undefined) {
      if (owner.ownerRegistration !== undefined) {
        const registered = yield* Effect.try({
          catch: unavailable,
          try: () => getVerticalRuntimeReads(owner.ownerRegistration).includes(read),
        });
        if (!registered) {
          return yield* unavailable();
        }
      }
      const readAdmission = yield* loadModuleOperationAdmission(
        owner.applicationComposition,
        owner.expectedDeployment,
        read,
        input.scope,
        owner.ownerRegistration,
      ).pipe(Effect.mapError(unavailable));
      if (readAdmission.revision !== admission.revision) {
        return yield* unavailable();
      }
      if (readAdmission.catalog !== undefined) {
        yield* validateBoundOperationOwner(read, readAdmission.catalog, owner.ownerRegistration).pipe(
          Effect.mapError(unavailable),
        );
      }
    }
    yield* rebindRegisteredActionCommandV2({
      command: input.command,
      registration,
      scope: input.scope,
    }).pipe(Effect.mapError(unavailable));
    return Object.freeze({ registration, revision: admission.revision });
  },
);

/** Match every real declaration, including independent Read fields, against the published release. */
const unpublished = () =>
  new ApprovalRefusedError({
    code: 'capability_not_approvable',
    reason: 'Every original Action, field and governing Read declaration must remain published unchanged',
  });

export const requirePublishedActionCommandV2 = (input: {
  readonly command: ActionCommandV2;
  readonly release: Option.Option<CatalogSnapshot>;
}) => {
  const { command, release } = input;
  const read = command.governingRead;
  const projected = projectPublishedCatalog([
    { declaration: command.declaration, moduleId: command.owningModuleKey, published: true },
    ...command.fieldGroups.map((declaration) => ({
      declaration,
      moduleId: command.owningModuleKey,
      parentKey: command.declaration.key,
      published: true,
    })),
    ...(read === undefined
      ? []
      : [
          { declaration: read.declaration, moduleId: command.owningModuleKey, published: true },
          ...read.fieldGroups.map((declaration) => ({
            declaration,
            moduleId: command.owningModuleKey,
            parentKey: read.declaration.key,
            published: true,
          })),
        ]),
  ]);
  if (Option.isNone(release) || Result.isFailure(projected)) {
    return Effect.fail(unpublished());
  }
  const byKey = new Map(release.value.entries.map((entry) => [entry.key, entry]));
  for (const expected of projected.success.entries) {
    const published = byKey.get(expected.key);
    if (published === undefined || computeCanonicalValueHash(published) !== computeCanonicalValueHash(expected)) {
      return Effect.fail(unpublished());
    }
  }
  const primary = byKey.get(CapabilityKeySchema.make(command.declaration.key));
  return primary === undefined ? Effect.fail(unpublished()) : Effect.succeed(publishedCapabilityOf(primary));
};

export interface ResolvedRegisteredActionSourceV2 {
  readonly registration: AnyActionRegistration;
  readonly revision: string;
}
