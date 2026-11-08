import { Context, Effect, Option } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import { externalIdentityFailure } from './errors.ts';
import type { ExternalIdentityFailure } from './errors.ts';

type NamespaceScope = Pick<OperationalScope, 'authMethod' | 'authenticationNamespaceId'>;

export interface GrantedProvisioningNamespacesService {
  readonly authenticationNamespaceIds: readonly string[];
}

/**
 * The exact authentication namespaces a trusted composition has already granted the current API-key
 * workload for this one request (O29, O59, O67-Q4).
 *
 * A workload authenticates in its own namespace (the Shell's staff namespace) yet provisions another
 * one (Commerce customers). The deployment grant that connects the two is the Shell's data, so the
 * Shell provides this service only after its grant check has passed, naming only the namespaces that
 * grant covers. It is never read from a request payload.
 */
export class GrantedProvisioningNamespaces extends Context.Service<
  GrantedProvisioningNamespaces,
  GrantedProvisioningNamespacesService
>()('@app/core-runtime/auth/external-identity/namespace-authority/GrantedProvisioningNamespaces') {}

export interface NamespaceAuthorityInput {
  readonly authenticationNamespaceId: string;
  readonly granted: Option.Option<GrantedProvisioningNamespacesService>;
  readonly scope: NamespaceScope;
}

const isGrantedNamespace = (input: NamespaceAuthorityInput): boolean =>
  input.scope.authMethod === 'api_key' &&
  Option.exists(input.granted, (granted) =>
    granted.authenticationNamespaceIds.includes(input.authenticationNamespaceId),
  );

/**
 * The authentication namespace a provisioning workload may act in (O29, O36, O59, O67-Q4).
 *
 * `identity_namespace#provision` is deleted with the legacy schema (O62), so the namespace
 * qualification no longer comes from a SpiceDB grant. It comes from data Core already trusts:
 *
 * - the namespace the workload authenticated in (`core.principal_auth_bindings` names it, and the
 *   trusted context carries it);
 * - for an API-key workload, an exact namespace that the trusted composition granted it for this
 *   request (`GrantedProvisioningNamespaces`), which is how the Shell's staff-namespace workload
 *   provisions Commerce bindings;
 * - for a trusted system job context, which carries no namespace of its own, its registration is
 *   deployment data (`registerSystemWorkload`) and its commencement is revalidated against
 *   `core.principals` and `core.tenants`.
 *
 * Nothing here is a human or agent capability: the carrier that admits the caller is
 * `accessWorkload`, and the gate refuses every human on it.
 */
export const authorizeProvisioningNamespace = (
  input: NamespaceAuthorityInput,
): Effect.Effect<void, ExternalIdentityFailure> => {
  const { authenticationNamespaceId, scope } = input;
  if (scope.authenticationNamespaceId !== undefined) {
    return scope.authenticationNamespaceId === authenticationNamespaceId || isGrantedNamespace(input)
      ? Effect.void
      : Effect.fail(
          externalIdentityFailure('identity_forbidden', 'The workload is not registered for this identity namespace'),
        );
  }
  return scope.authMethod === 'system'
    ? Effect.void
    : Effect.fail(
        externalIdentityFailure('identity_forbidden', 'The workload carries no identity namespace registration'),
      );
};

/**
 * A person's own authentication namespace is not a boundary: the gate decided the person through the
 * read's declaration, and only the owner's own authority rules apply (O64). Only a machine actor is
 * qualified by the namespace it authenticated in.
 */
const isPersonScope = (scope: NamespaceScope): boolean =>
  scope.authMethod === 'session' || scope.authMethod === 'support_impersonation';

/**
 * The namespace authority of the dual `core.identity.read-principal-binding` read (O67-Q4, O72).
 *
 * The legacy read required the exact namespace provision **or** the tenant administration permission
 * (`classification/core-runtime.json`), and both halves survive the cutover: a machine actor bound to
 * an authentication namespace may read only there or in a namespace the composition granted it
 * (`authorizeProvisioningNamespace`), while a person reaches the read through its
 * declaration (`core.identity.principal-binding.read`), which the gate has already decided. The owner
 * never re-decides a person; it only qualifies the namespace of a machine.
 */
export const authorizeReadNamespace = (input: NamespaceAuthorityInput): Effect.Effect<void, ExternalIdentityFailure> =>
  isPersonScope(input.scope) ? Effect.void : authorizeProvisioningNamespace(input);
