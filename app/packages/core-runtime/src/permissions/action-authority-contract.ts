import { Context } from 'effect';
import type { Effect } from 'effect';

import type { ActionPermissionCheckError } from '../actions/errors.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { ActionPermissionDecision } from './service.ts';

/**
 * The canonical Action-authority seam, as a pure contract (CUTOVER-PLAN §4.3). Both questions an
 * Action caller asks — may this Action execute, and may it be proposed — are answered by one
 * `AccessDecisionGate.decide` over the Action's own declared carrier. There is no separate
 * `action#execute`/`action#propose` engine; a caller passes the trusted `OperationalScope` it already
 * resolved, never loose ids.
 *
 * This module deliberately imports nothing from the Action catalog or the access runtime: a caller
 * that only needs the tag (an owner Action's own preparation, for instance) must not pull the whole
 * installed catalog in with it. That is what keeps `modules/actions/catalog.ts` from cycling through
 * its own Actions. The live implementation and its catalog-backed index live in
 * `./action-authority.ts`.
 */
export interface ScopedActionAuthority {
  readonly actionKey: string;
  readonly execute: ActionPermissionDecision;
  readonly propose: ActionPermissionDecision;
}

export interface ActionAuthorityQuery {
  readonly actionKeys: readonly string[];
  /** The trusted principal, tenant and optional legal entity of this request (O66). */
  readonly scope: OperationalScope;
}

export interface ActionAuthorityService {
  readonly checkActionAuthorities: (
    input: ActionAuthorityQuery,
  ) => Effect.Effect<readonly ScopedActionAuthority[], ActionPermissionCheckError>;
  readonly checkActionProposalPermission: (input: {
    readonly actionKey: string;
    readonly scope: OperationalScope;
  }) => Effect.Effect<ActionPermissionDecision, ActionPermissionCheckError>;
}

export class ActionAuthority extends Context.Service<ActionAuthority, ActionAuthorityService>()(
  '@app/core-runtime/permissions/action-authority-contract/ActionAuthority',
) {}
