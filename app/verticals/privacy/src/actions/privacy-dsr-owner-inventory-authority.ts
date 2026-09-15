import { Context, Effect, Layer } from 'effect';

import type { DsrOwnerInventoryAuthorityResult } from '../../shared/domain/privacy-dsr.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';

interface DsrOwnerInventoryAuthorityContext {
  readonly actionInvocationId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/**
 * Private DSR owner inventory boundary. Closure may use only the complete,
 * tenant/legal-entity-scoped owner mapping returned by this service.
 */
export interface DsrOwnerInventoryAuthorityService {
  readonly resolve: (
    caseRef: string,
    context: DsrOwnerInventoryAuthorityContext,
  ) => Effect.Effect<DsrOwnerInventoryAuthorityResult, PrivacyOperationPersistenceError>;
}

export class DsrOwnerInventoryAuthority extends Context.Service<
  DsrOwnerInventoryAuthority,
  DsrOwnerInventoryAuthorityService
>()('@app/privacy/actions/privacy-dsr-owner-inventory-authority/DsrOwnerInventoryAuthority') {}

export const dsrOwnerInventoryAuthorityUnavailable = Object.freeze({
  resolve: () =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'DSR Owner Inventory authority is not configured',
      }),
    ),
}) satisfies DsrOwnerInventoryAuthorityService;

export const DsrOwnerInventoryAuthorityUnavailableLive = Layer.succeed(
  DsrOwnerInventoryAuthority,
  dsrOwnerInventoryAuthorityUnavailable,
);
