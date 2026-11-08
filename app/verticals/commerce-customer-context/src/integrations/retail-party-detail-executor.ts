import type { executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import type { OperationalScope } from '@app/core-runtime';
import type { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';
import { Context } from 'effect';
import type { Effect } from 'effect';

export type RetailPartyResolutionExecutor = (
  payload: Parameters<typeof executePartyDetailWithAuthorization>[0],
  requestCorrelation: string,
) => Effect.Effect<
  Effect.Success<ReturnType<typeof executePartyDetailWithAuthorization>>,
  Effect.Error<ReturnType<typeof executePartyDetailWithAuthorization>> | ProfilePersistenceDependencyFailure
>;

/** Owner-composition transport seam. Production uses the audience-bound Party client. */
export class RetailPartyDetailExecutor extends Context.Service<
  RetailPartyDetailExecutor,
  {
    readonly execute: (
      payload: Parameters<RetailPartyResolutionExecutor>[0],
      requestCorrelation: string,
      authority: {
        readonly actionInvocationId: string;
        readonly compositionRevision: string;
        readonly scope: OperationalScope;
      },
    ) => ReturnType<RetailPartyResolutionExecutor>;
  }
>()('@app/commerce-customer-context/integrations/retail-party-detail-executor/RetailPartyDetailExecutor') {}
