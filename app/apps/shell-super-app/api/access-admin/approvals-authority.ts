import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { AccessDeclaration, OperationalScope } from '@app/core-runtime';

import type { ApprovalPortUnavailable, ApprovalScopeView } from './approvals-contract.ts';

/**
 * What the published catalog and the identity directory answer about one proposal. The declaration
 * itself is returned, not re-typed here: the gate is asked with the entry the deployment published,
 * so the BFF can never widen a capability by describing it itself. Every tenant fact is read inside
 * the request's own scope, so a person or scope of another tenant answers like one that does not exist.
 */
export interface AccessApprovalsAuthority {
  readonly capability: (
    capabilityKey: string,
  ) => Effect.Effect<
    Option.Option<{ readonly declaration: AccessDeclaration; readonly label: string; readonly moduleKey: string }>,
    ApprovalPortUnavailable
  >;
  readonly isAdministrator: (input: {
    readonly principalId: string;
    readonly scope: OperationalScope;
    readonly scopeId: string;
    readonly tenantId: string;
  }) => Effect.Effect<boolean, ApprovalPortUnavailable>;
  readonly person: (
    principalId: string,
    scope: OperationalScope,
  ) => Effect.Effect<Option.Option<{ readonly displayName: string }>, ApprovalPortUnavailable>;
  readonly principalKind: (
    principalId: string,
    scope: OperationalScope,
  ) => Effect.Effect<Option.Option<'agent' | 'human'>, ApprovalPortUnavailable>;
  readonly scope: (
    scopeId: string,
    scope: OperationalScope,
  ) => Effect.Effect<Option.Option<ApprovalScopeView>, ApprovalPortUnavailable>;
}

export class AccessApprovalsAuthoritySource extends Context.Service<
  AccessApprovalsAuthoritySource,
  AccessApprovalsAuthority
>()('@app/shell-super-app/api/access-admin/approvals-authority/AccessApprovalsAuthoritySource') {}
