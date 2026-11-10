import { ModuleAppIdSchema } from '@app/core-runtime/auth/hosted-module-credentials';
import { Effect, Layer, Option } from 'effect';

import {
  GatewayDelegationPolicyUnavailable,
  ModuleCredentialEnrolmentSource,
} from '../../api/auth/gateway-delegation-policy.ts';

/** What a test credential's issuing host attested: the module build and the release revision. */
export interface TestModuleCredentialRelease {
  readonly buildMarker: string;
  readonly compositionRevision: string;
}

/**
 * The platform's enrolment as these tests need it: each module's credential by provider key id, attested for the
 * given build and release when the test derives bindings from it.
 */
export const enrolledModuleCredentials = (
  credentials: readonly {
    readonly appId: string;
    readonly providerKeyId: string;
    readonly release?: TestModuleCredentialRelease;
  }[],
): Layer.Layer<ModuleCredentialEnrolmentSource> => {
  const enrolment = credentials.map(({ appId, providerKeyId }, index) => ({
    appId,
    authBindingId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    boundAt: new Date(0),
    principalId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    providerKeyId,
  }));
  return Layer.succeed(ModuleCredentialEnrolmentSource, {
    load: Effect.succeed(enrolment),
    loadAttested: Effect.succeed(
      enrolment.map((credential, index) => {
        const release = credentials[index]?.release;
        return {
          ...credential,
          attestation:
            release === undefined
              ? Option.none()
              : Option.some({
                  appId: ModuleAppIdSchema.make(credential.appId),
                  buildMarker: release.buildMarker,
                  compositionRevision: release.compositionRevision,
                  ontosModuleCredential: 'attested_v1' as const,
                }),
        };
      }),
    ),
  });
};

const unreadable = Effect.fail(
  new GatewayDelegationPolicyUnavailable({ cause: 'The enrolment is unreadable in this test' }),
);

/** An enrolment the Shell cannot read, which it answers as unavailable. */
export const unreadableModuleCredentialEnrolment: Layer.Layer<ModuleCredentialEnrolmentSource> = Layer.succeed(
  ModuleCredentialEnrolmentSource,
  { load: unreadable, loadAttested: unreadable },
);
