import { Effect, Layer } from 'effect';

import {
  GatewayDelegationPolicyUnavailable,
  ModuleCredentialEnrolmentSource,
} from '../../api/auth/gateway-delegation-policy.ts';

/** The platform's enrolment as these tests need it: each module's credential by provider key id. */
export const enrolledModuleCredentials = (
  credentials: readonly { readonly appId: string; readonly providerKeyId: string }[],
): Layer.Layer<ModuleCredentialEnrolmentSource> =>
  Layer.succeed(ModuleCredentialEnrolmentSource, {
    load: Effect.succeed(
      credentials.map((credential, index) => ({
        ...credential,
        authBindingId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        boundAt: new Date(0),
        principalId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      })),
    ),
  });

/** An enrolment the Shell cannot read, which it answers as unavailable. */
export const unreadableModuleCredentialEnrolment: Layer.Layer<ModuleCredentialEnrolmentSource> = Layer.succeed(
  ModuleCredentialEnrolmentSource,
  { load: Effect.fail(new GatewayDelegationPolicyUnavailable({ cause: 'The enrolment is unreadable in this test' })) },
);
