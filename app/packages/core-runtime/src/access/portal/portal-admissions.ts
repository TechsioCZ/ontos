import { Context, Effect, Layer } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { accessPortalRefusal, accessPortalWritesForTransaction } from './portal-access.ts';
import type {
  AccessPortalError,
  AccessPortalGrantInput,
  AccessPortalReceipt,
  AccessPortalWrites,
} from './portal-access.ts';

/*
 * A portal write for an owner fact that is not an Action. A redeemed invitation is one: its owner proves the
 * recipient holds the invitation's secret in a transaction of its own, before the recipient can run any
 * Action at all, because running one already needs the membership this write gives. Core then writes the
 * recipient's access in one transaction of its own, under the request's scope, exactly as an owner Action's
 * transaction would (`portal-access.ts`), and the caller reconciles the projection afterwards.
 */

export interface AccessPortalAdmissionsService {
  /** The owner fact is ACTIVE: one Core transaction writes the person's portal access. */
  readonly grant: (
    scope: OperationalScope,
    input: AccessPortalGrantInput,
  ) => Effect.Effect<AccessPortalReceipt, AccessPortalError>;
  /** The owner fact ended: one Core transaction ends the portal access it stood for. */
  readonly revoke: (
    scope: OperationalScope,
    input: AccessPortalGrantInput,
  ) => Effect.Effect<AccessPortalReceipt, AccessPortalError>;
}

export class AccessPortalAdmissions extends Context.Service<AccessPortalAdmissions, AccessPortalAdmissionsService>()(
  '@app/core-runtime/access/portal/portal-admissions/AccessPortalAdmissions',
) {}

type PortalOperation = keyof AccessPortalWrites;

/** One portal write inside a Core transaction with the request's scope installed (O66). */
const writeUnderScope = (
  transaction: CoreTransaction,
  scope: OperationalScope,
  enrollment: DatabaseIdentityEnrollment,
  operation: PortalOperation,
  input: AccessPortalGrantInput,
) =>
  installOperationalScope(transaction, scope, enrollment).pipe(
    Effect.mapError((cause) =>
      accessPortalRefusal('access_portal_unavailable', 'The request scope could not be installed', cause),
    ),
    Effect.flatMap((scoped) => accessPortalWritesForTransaction(scoped, scope)[operation](input)),
  );

export const AccessPortalAdmissionsLive: Layer.Layer<
  AccessPortalAdmissions,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessPortalAdmissions,
  Effect.gen(function* accessPortalAdmissionsLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const commit = (
      operation: PortalOperation,
      scope: OperationalScope,
      input: AccessPortalGrantInput,
    ): Effect.Effect<AccessPortalReceipt, AccessPortalError> =>
      database.executor
        .transaction((transaction) => writeUnderScope(transaction, scope, enrollment, operation, input))
        .pipe(
          Effect.catchTag('SqlError', (cause) =>
            Effect.fail(
              accessPortalRefusal('access_portal_unavailable', 'The portal access could not be committed', cause),
            ),
          ),
        );
    return Object.freeze({
      grant: (scope: OperationalScope, input: AccessPortalGrantInput) => commit('grant', scope, input),
      revoke: (scope: OperationalScope, input: AccessPortalGrantInput) => commit('revoke', scope, input),
    });
  }),
);
