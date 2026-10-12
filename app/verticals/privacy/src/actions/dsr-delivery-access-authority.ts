import { Context, Effect, Layer } from 'effect';

import type { DsrDeliveryAccessAuthorityResult } from '../../shared/domain/dsr-delivery-access.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';

interface DsrDeliveryAccessAuthorityContext {
  readonly actionInvocationId: string;
  readonly asOf: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface DsrDeliveryAccessAuthorityService {
  readonly resolve: (
    requestRef: string,
    context: DsrDeliveryAccessAuthorityContext,
  ) => Effect.Effect<DsrDeliveryAccessAuthorityResult, PrivacyOperationPersistenceError>;
}

export class DsrDeliveryAccessAuthority extends Context.Service<
  DsrDeliveryAccessAuthority,
  DsrDeliveryAccessAuthorityService
>()('@app/privacy/actions/dsr-delivery-access-authority/DsrDeliveryAccessAuthority') {}

export const dsrDeliveryAccessAuthorityUnavailable = Object.freeze({
  resolve: (..._args: readonly unknown[]) =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'DSR Delivery Access authority is not configured',
      }),
    ),
}) satisfies DsrDeliveryAccessAuthorityService;

export const DsrDeliveryAccessAuthorityUnavailableLive = Layer.succeed(
  DsrDeliveryAccessAuthority,
  dsrDeliveryAccessAuthorityUnavailable,
);
