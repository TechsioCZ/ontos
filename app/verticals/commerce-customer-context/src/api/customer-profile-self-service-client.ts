import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Context, Effect, Layer, Redacted } from 'effect';
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
const makeCustomerOwnProfileClient = Effect.fn('CustomerOwnProfileClient.make')(function* makeClient(
  context: CustomerOwnProfileClientContext,
) {
  const options = yield* makeEffectBffClientOptions({
    baseUrl: context.baseUrl,
    defaultApiPrefix: '/commerce-customer-context-api',
    transportHeaders: transportHeaders(context),
  });
  const readClient = yield* makeEffectHttpApiClient(CustomerOwnProfileReadApi, options);
  const updateClient = yield* makeEffectHttpApiClient(CustomerOwnProfileUpdateApi, options);
  return {
    read: () => readClient.customerOwnProfileRead.execute(),
    update: (payload: UpdateCustomerOwnProfile) => updateClient.customerOwnProfileUpdate.execute({ payload }),
  };
});

export class CustomerOwnProfileClient extends Context.Service<
  CustomerOwnProfileClient,
  Effect.Success<ReturnType<typeof makeCustomerOwnProfileClient>>
>()('@app/commerce-customer-context/api/customer-profile-self-service-client/CustomerOwnProfileClient') {}

/** Build once for the supplied authenticated context; never share the layer between customer contexts. */
export const makeCustomerOwnProfileClientLayer = (context: CustomerOwnProfileClientContext) =>
  Layer.effect(CustomerOwnProfileClient, makeCustomerOwnProfileClient(context));

export const readCustomerOwnProfileWithAuthorization = () =>
  CustomerOwnProfileClient.pipe(Effect.flatMap((client) => client.read()));

export const updateCustomerOwnProfileWithAuthorization = (payload: UpdateCustomerOwnProfile) =>
  CustomerOwnProfileClient.pipe(Effect.flatMap((client) => client.update(payload)));
