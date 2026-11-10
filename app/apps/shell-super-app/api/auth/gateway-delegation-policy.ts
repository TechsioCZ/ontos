import type { ModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';
import { GatewayAudienceSchema } from '@app/shared-contracts';
import { Effect, Schema } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { GatewayDelegationPolicyUnavailable } from './gateway-delegation-policy-unavailable.ts';
import { ModuleCredentialEnrolmentSource } from './module-credential-enrolment.service.ts';

export { GatewayDelegationPolicyUnavailable } from './gateway-delegation-policy-unavailable.ts';
export {
  ModuleCredentialEnrolmentSource,
  ModuleCredentialEnrolmentSourceLive,
} from './module-credential-enrolment.service.ts';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

/**
 * One module credential's binding: the key's provider id, the module it belongs to, and the build and release that
 * module runs. The platform derives it from its own enrolment and the installed release; nothing configures it.
 */
export const GatewayModuleBindingSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  providerKeyId: nonEmpty.pipe(Schema.brand('GatewayModuleCredentialId')),
  sourceAppId: GatewayAudienceSchema,
  sourceBuildMarker: nonEmpty,
});
export type GatewayModuleBinding = typeof GatewayModuleBindingSchema.Type;

const bindingsSchema = Schema.Array(GatewayModuleBindingSchema).check(
  Schema.makeFilter((bindings) =>
    new Set(bindings.map((binding) => binding.providerKeyId)).size === bindings.length
      ? undefined
      : 'Module credentials must have one deployment binding',
  ),
);

/**
 * The bindings of the installed release: each enrolled credential of an installed module, pinned to that module's
 * build and the release's composition revision. A credential of a module this release does not install binds nothing.
 */
export const deriveGatewayModuleBindings = (
  enrolment: readonly Pick<ModuleCredentialEnrolment, 'appId' | 'providerKeyId'>[],
  installed: {
    readonly composition: { readonly revision: string };
    readonly contracts: readonly { readonly deployment: { readonly appId: string; readonly buildMarker: string } }[];
  },
) =>
  Schema.decodeUnknownEffect(bindingsSchema)(
    enrolment.flatMap((credential) => {
      const contract = installed.contracts.find((candidate) => candidate.deployment.appId === credential.appId);
      return contract === undefined
        ? []
        : [
            {
              compositionRevision: installed.composition.revision,
              providerKeyId: credential.providerKeyId,
              sourceAppId: credential.appId,
              sourceBuildMarker: contract.deployment.buildMarker,
            },
          ];
    }),
  ).pipe(Effect.mapError((cause) => new GatewayDelegationPolicyUnavailable({ cause })));

/**
 * The bindings for this request, derived from the platform's enrolment and the installed release, so they always
 * name the release that is live now. An unreadable enrolment or release fails the load; it is never read as "none".
 */
export const loadGatewayModuleBindings = Effect.gen(function* loadDerivedGatewayModuleBindings() {
  const enrolment = yield* (yield* ModuleCredentialEnrolmentSource).load;
  const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(
    Effect.mapError((cause) => new GatewayDelegationPolicyUnavailable({ cause })),
  );
  return yield* deriveGatewayModuleBindings(enrolment, installed);
});

/** Whether the verified credential is a module credential, which may never issue a subject's context. */
export const isGatewayModuleCredential = (
  enrolment: readonly Pick<ModuleCredentialEnrolment, 'providerKeyId'>[],
  providerKeyId: string,
): boolean => enrolment.some((credential) => credential.providerKeyId === providerKeyId);

/**
 * Refuses a verified key that is any enrolled module credential, installed module or not: it may only issue through
 * the delegated endpoint. An unreadable enrolment fails as unavailable; it is never read as "no module key".
 */
export const admitIntegrationCredential = Effect.fn('GatewayDelegationPolicy.admitIntegrationCredential')(
  function* admitIntegrationCredential(providerKeyId: string) {
    const enrolment = yield* (yield* ModuleCredentialEnrolmentSource).load.pipe(Effect.mapError(delegationUnavailable));
    if (isGatewayModuleCredential(enrolment, providerKeyId)) {
      return yield* delegationForbidden();
    }
    return yield* Effect.void;
  },
);

/** The module binding attests exactly the source token's app, build and release, and the request names the same release. */
export const bindingAttestsSource = (
  binding: GatewayModuleBinding,
  source: { readonly aud: string; readonly compositionRevision: string; readonly targetBuildMarker: string },
  requestedCompositionRevision: string,
): boolean =>
  binding.sourceAppId === source.aud &&
  binding.sourceBuildMarker === source.targetBuildMarker &&
  binding.compositionRevision === source.compositionRevision &&
  requestedCompositionRevision === source.compositionRevision;
