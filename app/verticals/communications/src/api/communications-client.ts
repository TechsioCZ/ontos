import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import type { EffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { Context, Layer } from 'effect';
import type { HttpApiClient } from 'effect/http-api';
import { communicationsApi, communicationsApiContract } from '../../shared/api.ts';

// <generated-action-http-client-exports>
export {
  executeActivateTemplateRevision,
  executeActivateTemplateRevisionWithAuthorization,
} from './activate-template-revision-action-client.ts';
export type { ActivateTemplateRevisionActionClientOptions } from './activate-template-revision-action-client.ts';
export {
  executeDeactivateTemplateRevision,
  executeDeactivateTemplateRevisionWithAuthorization,
} from './deactivate-template-revision-action-client.ts';
export type { DeactivateTemplateRevisionActionClientOptions } from './deactivate-template-revision-action-client.ts';
export {
  executeInvalidateTemplateRevision,
  executeInvalidateTemplateRevisionWithAuthorization,
} from './invalidate-template-revision-action-client.ts';
export type { InvalidateTemplateRevisionActionClientOptions } from './invalidate-template-revision-action-client.ts';
export {
  executePrepareTemplateRevision,
  executePrepareTemplateRevisionWithAuthorization,
} from './prepare-template-revision-action-client.ts';
export type { PrepareTemplateRevisionActionClientOptions } from './prepare-template-revision-action-client.ts';
export {
  executeSetLanguagePolicy,
  executeSetLanguagePolicyWithAuthorization,
} from './set-language-policy-action-client.ts';
export type { SetLanguagePolicyActionClientOptions } from './set-language-policy-action-client.ts';
// </generated-action-http-client-exports>

export class CommunicationsApiClient extends Context.Service<
  CommunicationsApiClient,
  HttpApiClient.ForApi<typeof communicationsApi>
>()('@app/communications/api/communications-client/CommunicationsApiClient') {}

/** Trusted transport configuration is supplied once by the application or test composition. */
export const CommunicationsClientConfiguration = Context.Reference<EffectBffClientOptions>(
  '@app/communications/api/communications-client/CommunicationsClientConfiguration',
  { defaultValue: () => ({}) },
);
export const CommunicationsApiClientLive = Layer.effect(
  CommunicationsApiClient,
  Effect.gen(function* makeCommunicationsClient() {
    const options = yield* CommunicationsClientConfiguration;
    const clientOptions = yield* makeEffectBffClientOptions({
      ...options,
      defaultApiPrefix: communicationsApiContract.apiPrefix,
    });
    return yield* makeEffectHttpApiClient(communicationsApi, clientOptions);
  }),
);
export const getCommunicationsReadiness = CommunicationsApiClient.pipe(
  Effect.flatMap((client) => client.foundation.readiness({})),
);
