import type { executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import { Context } from 'effect';

export type RetailPartyResolutionExecutor = (
  payload: Parameters<typeof executePartyDetailWithAuthorization>[0],
  requestCorrelation: string,
) => ReturnType<typeof executePartyDetailWithAuthorization>;

/** Owner-composition transport seam. Production uses the audience-bound Party client. */
export class RetailPartyDetailExecutor extends Context.Service<
  RetailPartyDetailExecutor,
  { readonly execute: RetailPartyResolutionExecutor }
>()('@app/commerce-customer-context/integrations/retail-party-detail-executor/RetailPartyDetailExecutor') {}
