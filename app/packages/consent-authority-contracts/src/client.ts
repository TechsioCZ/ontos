import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted } from 'effect';
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
  makeEffectBffClient({
    api: CommerceConsentAuthorityApi,
    baseUrl: context.baseUrl,
    defaultApiPrefix: '/commerce-customer-context-api',
    transportHeaders: {
      authorization: Redacted.value(context.credential),
      'x-correlation-id': context.requestCorrelation,
      'x-ontos-composition-revision': context.compositionRevision,
    },
  }).pipe(Effect.flatMap((client) => client.commerceConsentAuthority.execute({ payload })));

export const resolveCommerceConsentNoticeAuthorityWithAuthorization = (
  payload: RecordNoticeProvisionPayload,
  context: CommerceConsentAuthorityClientContext,
) =>
  makeEffectBffClient({
    api: CommerceConsentNoticeAuthorityApi,
    baseUrl: context.baseUrl,
    defaultApiPrefix: '/commerce-customer-context-api',
    transportHeaders: {
      authorization: Redacted.value(context.credential),
      'x-correlation-id': context.requestCorrelation,
      'x-ontos-composition-revision': context.compositionRevision,
    },
  }).pipe(Effect.flatMap((client) => client.commerceConsentNoticeAuthority.execute({ payload })));
