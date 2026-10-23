import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted } from 'effect';
import { CustomerOwnProfileReadApi, CustomerOwnProfileUpdateApi } from '../../shared/portal-auth/profile-api.ts';
import type { UpdateCustomerOwnProfile } from '../../shared/portal-auth/profile-api.ts';

export interface CustomerOwnProfileClientContext {
  readonly baseUrl: string | URL;
  readonly compositionRevision: string;
  readonly cookie: Redacted.Redacted;
  readonly credential: Redacted.Redacted;
  readonly origin: string;
  readonly requestCorrelation: string;
}
const transportHeaders = (context: CustomerOwnProfileClientContext) => ({
  authorization: Redacted.value(context.credential),
  cookie: Redacted.value(context.cookie),
  origin: context.origin,
  'x-correlation-id': context.requestCorrelation,
  'x-ontos-composition-revision': context.compositionRevision,
});
export const readCustomerOwnProfileWithAuthorization = (context: CustomerOwnProfileClientContext) =>
  makeEffectBffClient({
    api: CustomerOwnProfileReadApi,
    baseUrl: context.baseUrl,
    defaultApiPrefix: '/commerce-customer-context-api',
    transportHeaders: transportHeaders(context),
  }).pipe(Effect.flatMap((client) => client.customerOwnProfileRead.execute()));
export const updateCustomerOwnProfileWithAuthorization = (
  payload: UpdateCustomerOwnProfile,
  context: CustomerOwnProfileClientContext,
) =>
  makeEffectBffClient({
    api: CustomerOwnProfileUpdateApi,
    baseUrl: context.baseUrl,
    defaultApiPrefix: '/commerce-customer-context-api',
    transportHeaders: transportHeaders(context),
  }).pipe(Effect.flatMap((client) => client.customerOwnProfileUpdate.execute({ payload })));
