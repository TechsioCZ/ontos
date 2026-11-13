import type { OperationalScope } from '@app/core-runtime';
import { Context } from 'effect';
import type { Effect } from 'effect';

import {
  ACCESS_ADMIN_HTTP_STATUS,
  AccessAdminAuthenticationRequiredProblemSchema,
  AccessAdminConflictProblemSchema,
  AccessAdminForbiddenProblemSchema,
  AccessAdminInternalProblemSchema,
  AccessAdminUnavailableProblemSchema,
  AccessAdminUnprocessableProblemSchema,
} from '../../shared/access-admin-api.ts';
import type { AccessAdminProblem } from '../../shared/access-admin-api.ts';

/**
 * The authenticated tenant context of one access-administration request, as P1's session
 * integration provides it: the person and their tenant, with **no** company selection (O28). The
 * administration surface is tenant work, so it must be reachable from a session that has not chosen
 * a legal entity — and it must never reach a business route, so the context it hands over is the
 * tenant one and the gate decides every surface separately.
 *
 * A request that cannot be authenticated is a problem, never a scope carrying a guessed tenant:
 * 401 for an absent session, 403 for a blocked identity, 503 when the session store is unreachable.
 */
export interface AccessAdminSessionService {
  readonly requireTenantContext: (headers: Headers) => Effect.Effect<OperationalScope, AccessAdminProblem>;
}

export class AccessAdminSession extends Context.Service<AccessAdminSession, AccessAdminSessionService>()(
  '@app/shell-super-app/api/access-admin/session/AccessAdminSession',
) {}

/** Problem factories the session integration and the Novinky handlers share (one vocabulary). */
export const accessAdminAuthenticationRequiredProblem = (): AccessAdminProblem =>
  AccessAdminAuthenticationRequiredProblemSchema.make({
    _tag: 'AccessAdminAuthenticationRequired',
    detail: 'A valid Shell session with a tenant context is required.',
    status: ACCESS_ADMIN_HTTP_STATUS.authenticationRequired,
    title: 'Access administration requires a session',
    type: 'https://ontos.dev/problems/access-admin-authentication-required',
  });

export const accessAdminForbiddenProblem = (detail: string): AccessAdminProblem =>
  AccessAdminForbiddenProblemSchema.make({
    _tag: 'AccessAdminForbidden',
    detail,
    status: ACCESS_ADMIN_HTTP_STATUS.forbidden,
    title: 'Access administration is forbidden',
    type: 'https://ontos.dev/problems/access-admin-forbidden',
  });

export const accessAdminConflictProblem = (detail: string): AccessAdminProblem =>
  AccessAdminConflictProblemSchema.make({
    _tag: 'AccessAdminConflict',
    detail,
    status: ACCESS_ADMIN_HTTP_STATUS.conflict,
    title: 'Access administration conflict',
    type: 'https://ontos.dev/problems/access-admin-conflict',
  });

export const accessAdminUnprocessableProblem = (detail: string): AccessAdminProblem =>
  AccessAdminUnprocessableProblemSchema.make({
    _tag: 'AccessAdminUnprocessable',
    detail,
    status: ACCESS_ADMIN_HTTP_STATUS.unprocessable,
    title: 'Access administration request refused',
    type: 'https://ontos.dev/problems/access-admin-unprocessable',
  });

export const accessAdminInternalProblem = (detail: string): AccessAdminProblem =>
  AccessAdminInternalProblemSchema.make({
    _tag: 'AccessAdminInternal',
    detail,
    status: ACCESS_ADMIN_HTTP_STATUS.internal,
    title: 'Access administration failed',
    type: 'https://ontos.dev/problems/access-admin-internal',
  });

/**
 * A change the store saved whose projection did not complete: the Action's write is committed, and the tenant's
 * permissions are still being applied (a retry, the fence sweep or the next reconcile finishes them). A retry of the
 * same request is safe: the saved change is found and only its projection runs again.
 */
export const accessAdminSavedPendingProblem = (): AccessAdminProblem =>
  AccessAdminUnavailableProblemSchema.make({
    _tag: 'AccessAdminUnavailable',
    detail:
      'The change is saved; its permissions are still being applied. Retry in a moment to finish them; nothing is saved twice.',
    retryable: true,
    status: ACCESS_ADMIN_HTTP_STATUS.unavailable,
    title: 'Change saved, permissions still being applied',
    type: 'https://ontos.dev/problems/access-admin-saved-permissions-pending',
  });

export const accessAdminUnavailableProblem = (): AccessAdminProblem =>
  AccessAdminUnavailableProblemSchema.make({
    _tag: 'AccessAdminUnavailable',
    detail: 'Access administration is temporarily unavailable. Please retry.',
    retryable: true,
    status: ACCESS_ADMIN_HTTP_STATUS.unavailable,
    title: 'Access administration unavailable',
    type: 'https://ontos.dev/problems/access-admin-unavailable',
  });
