import { loadModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';
import type { ModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { Context, Effect, Layer } from 'effect';

import { GatewayDelegationPolicyUnavailable } from './gateway-delegation-policy-unavailable.ts';

/** Which module each platform-issued module credential belongs to, read from the platform's own enrolment. */
export class ModuleCredentialEnrolmentSource extends Context.Service<
  ModuleCredentialEnrolmentSource,
  { readonly load: Effect.Effect<readonly ModuleCredentialEnrolment[], GatewayDelegationPolicyUnavailable> }
>()('@app/shell-super-app/api/auth/module-credential-enrolment-source/ModuleCredentialEnrolmentSource') {}

export const ModuleCredentialEnrolmentSourceLive = Layer.effect(
  ModuleCredentialEnrolmentSource,
  Effect.gen(function* makeModuleCredentialEnrolmentSource() {
    const database = yield* CoreDatabase;
    return {
      load: loadModuleCredentialEnrolment(database.executor).pipe(
        Effect.mapError((cause) => new GatewayDelegationPolicyUnavailable({ cause })),
      ),
    };
  }),
);
