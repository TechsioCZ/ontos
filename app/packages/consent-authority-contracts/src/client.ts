import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect } from 'effect';
import type { Redacted } from 'effect';
import { CommerceConsentAuthorityApi, CommerceConsentNoticeAuthorityApi } from './api.ts';
import type { RecordNoticeProvisionPayload } from './index.ts';
import type { CommerceConsentAuthorityPayload } from './api.ts';

export interface CommerceConsentAuthorityClientContext {
  readonly baseUrl: string | URL;
  readonly compositionRevision: string;
  readonly credential: Redacted.Redacted;
  readonly requestCorrelation: string;
}
export const resolveCommerceConsentAuthorityWithAuthorization = (
  payload: CommerceConsentAuthorityPayload,
  context: CommerceConsentAuthorityClientContext,
) =>
  makeGovernedEffectBffClient(
    {
      api: CommerceConsentAuthorityApi,
      credential: context.credential,
      defaultApiPrefix: '/commerce-customer-context-api',
      requestCorrelation: context.requestCorrelation,
    },
    { baseUrl: context.baseUrl, compositionRevision: context.compositionRevision },
  ).pipe(Effect.flatMap((client) => client.commerceConsentAuthority.execute({ payload })));

export const resolveCommerceConsentNoticeAuthorityWithAuthorization = (
  payload: RecordNoticeProvisionPayload,
  context: CommerceConsentAuthorityClientContext,
) =>
  makeGovernedEffectBffClient(
    {
      api: CommerceConsentNoticeAuthorityApi,
      credential: context.credential,
      defaultApiPrefix: '/commerce-customer-context-api',
      requestCorrelation: context.requestCorrelation,
    },
    { baseUrl: context.baseUrl, compositionRevision: context.compositionRevision },
  ).pipe(Effect.flatMap((client) => client.commerceConsentNoticeAuthority.execute({ payload })));
