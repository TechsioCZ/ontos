import { stableUuid } from '../access/catalog/stable-id.ts';

/**
 * The ids Core gives the rows an Action creates for a principal. The caller never chooses them: Core derives them in
 * their own namespace from the tenant and a reference of the creation (the creating client's request reference, or
 * Core's own invocation id), so a retry names the same principal, and no reference reaches an id outside that
 * namespace: no tenant can place a principal at an id the platform derives for itself (a module's internal workload,
 * the release actor, a module credential's principal), nor at another tenant's.
 */
export const actionCreatedPrincipalId = (input: {
  readonly kind: 'agent' | 'demo-account';
  readonly reference: string;
  readonly tenantId: string;
}): string => stableUuid(`ontos.identity/${input.kind}-principal:${input.tenantId}:${input.reference}`);

/** The id of the staff authentication binding an Action creates beside such a principal. */
export const actionCreatedAuthBindingId = (input: {
  readonly actionInvocationId: string;
  readonly tenantId: string;
}): string => stableUuid(`ontos.identity/demo-account-binding:${input.tenantId}:${input.actionInvocationId}`);
