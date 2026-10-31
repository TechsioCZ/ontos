import { ActionAuthorizationPreflight, ActionRuntime, makeActionRuntimeLive } from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { Effect, Layer } from '@modern-js/bff-effect/effect-edge';
import { Context } from 'effect';

import {
  CommerceConsentAuthorityLookup,
  commerceConsentAuthorityLookup,
  preparedCommerceConsentExecution,
} from '../src/actions/commerce-consent-authority.ts';
import { ConsentSelfServiceAuthority } from '../src/actions/consent-self-service.action.ts';
import { NoticeChannelDeliveryAuthority } from '../src/actions/record-notice-provision.action.ts';
import { ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';

/** Build the native runtime with fresh pre-transaction evidence for each invocation. */
const privacyConsentAuthorityActionRuntimeLive: Layer.Layer<
  ActionRuntime,
  never,
  ActionRuntime | CommerceConsentAuthorityLookup | Layer.Services<ReturnType<typeof makeActionRuntimeLive>>
> = Layer.effect(
  ActionRuntime,
  Effect.gen(function* privacyConsentAuthorityActionRuntime() {
    const existing = yield* ActionRuntime;
    const lookup = yield* CommerceConsentAuthorityLookup;
    const dependencies = yield* Effect.context<Layer.Services<ReturnType<typeof makeActionRuntimeLive>>>();
    const runAction: ActionRuntimeService['runAction'] = (input) =>
      Effect.scoped(
        Effect.gen(function* runConsentAwareAction() {
          const execution = yield* preparedCommerceConsentExecution.pipe(
            Effect.provideService(CommerceConsentAuthorityLookup, lookup),
          );
          const scope = yield* Effect.scope;
          const runtimeContext = yield* Layer.buildWithScope(
            makeActionRuntimeLive(ultramodernDeliveryUnit),
            scope,
          ).pipe(Effect.provideContext(Context.add(dependencies, ActionAuthorizationPreflight, execution.preflight)));
          return yield* Context.get(runtimeContext, ActionRuntime)
            .runAction(input)
            .pipe(
              Effect.provideService(ConsentSelfServiceAuthority, execution.authority),
              Effect.provideService(NoticeChannelDeliveryAuthority, execution.noticeAuthority),
            );
        }),
      );
    return { ...existing, runAction };
  }),
);

/**
 * The Privacy Action runtime whose consent Actions see fresh Commerce consent authority. The API root composes it
 * like the native runtime: it provides only the native runtime dependencies.
 */
export const privacyConsentAwareActionRuntimeLive: Layer.Layer<
  ActionRuntime,
  Layer.Error<ReturnType<typeof makeActionRuntimeLive>>,
  Layer.Services<ReturnType<typeof makeActionRuntimeLive>> | Effect.Services<typeof commerceConsentAuthorityLookup>
> = privacyConsentAuthorityActionRuntimeLive.pipe(
  Layer.provideMerge(makeActionRuntimeLive(ultramodernDeliveryUnit)),
  Layer.provide(Layer.effect(CommerceConsentAuthorityLookup, commerceConsentAuthorityLookup)),
);
