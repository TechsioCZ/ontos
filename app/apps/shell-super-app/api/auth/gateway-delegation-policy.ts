import type { ModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';
import { GatewayAudienceSchema } from '@app/shared-contracts';
import { Effect, Option, Schema } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { GatewayDelegationPolicyUnavailable } from './gateway-delegation-policy-unavailable.ts';
import { ModuleCredentialEnrolmentSource } from './module-credential-enrolment.service.ts';
import type { AttestedModuleCredential } from './module-credential-enrolment.service.ts';

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
 * The bindings of the installed release. A credential binds only what its issuing host attested with the key: its
 * module, that module's build marker and the composition revision of the issuing host's release. It binds while the
 * installed release has exactly that build of that module at exactly that revision, and nothing otherwise, so during a
 * deploy overlap only the keys issued for the release that holds the authority bind; an older or newer host's keys,
 * a key without an attestation and a key of a module this release does not install all bind nothing.
 */
export const deriveGatewayModuleBindings = (
  enrolment: readonly Pick<AttestedModuleCredential, 'appId' | 'attestation' | 'providerKeyId'>[],
  installed: {
    readonly composition: { readonly revision: string };
    readonly contracts: readonly { readonly deployment: { readonly appId: string; readonly buildMarker: string } }[];
  },
) =>
  Schema.decodeUnknownEffect(bindingsSchema)(
    enrolment.flatMap((credential) => {
      if (Option.isNone(credential.attestation)) {
        return [];
      }
      const attested = credential.attestation.value;
      const contract = installed.contracts.find((candidate) => candidate.deployment.appId === credential.appId);
      return contract === undefined ||
        attested.appId !== credential.appId ||
        attested.buildMarker !== contract.deployment.buildMarker ||
        attested.compositionRevision !== installed.composition.revision
        ? []
        : [
            {
              compositionRevision: attested.compositionRevision,
              providerKeyId: credential.providerKeyId,
              sourceAppId: credential.appId,
              sourceBuildMarker: attested.buildMarker,
            },
          ];
    }),
  ).pipe(Effect.mapError((cause) => new GatewayDelegationPolicyUnavailable({ cause })));

/**
 * The bindings for this request, derived from the platform's attested enrolment and the installed release, so they
 * always name the release that is live now. An unreadable enrolment or release fails the load; it is never "none".
 */
export const loadGatewayModuleBindings = Effect.gen(function* loadDerivedGatewayModuleBindings() {
  const enrolment = yield* (yield* ModuleCredentialEnrolmentSource).loadAttested;
  // An unreadable release keeps its own failure, so a refusal names which of the two it could not read.
  const installed = yield* (yield* ShellInstalledModuleCatalog).load;
  return yield* deriveGatewayModuleBindings(enrolment, installed);
});

/** Whether the verified credential is a module credential, which may never issue a subject's context. */
export const isGatewayModuleCredential = (
  enrolment: readonly Pick<ModuleCredentialEnrolment, 'providerKeyId'>[],
  providerKeyId: string,
): boolean => enrolment.some((credential) => credential.providerKeyId === providerKeyId);

/**
 * Refuses a verified key that is any enrolled module credential, installed module or not: it may only issue through
 * the delegated endpoint. An unreadable enrolment fails as unavailable; it is never read as "no module key". Every
 * API-key entry point other than the delegated endpoint admits its verified key through this check.
 */
export const admitIntegrationCredentialFrom = (source: typeof ModuleCredentialEnrolmentSource.Service) =>
  Effect.fn('GatewayDelegationPolicy.admitIntegrationCredential')(function* admitIntegrationCredential(
    providerKeyId: string,
  ) {
    const enrolment = yield* source.load.pipe(Effect.mapError(delegationUnavailable('module_enrolment_unavailable')));
    if (isGatewayModuleCredential(enrolment, providerKeyId)) {
      return yield* delegationForbidden('module_credential_not_admitted')();
    }
    return yield* Effect.void;
  });

/** The same check against the enrolment source of the current context. */
export const admitIntegrationCredential = Effect.fn('GatewayDelegationPolicy.admitIntegrationCredentialInContext')(
  function* admitIntegrationCredentialInContext(providerKeyId: string) {
    return yield* admitIntegrationCredentialFrom(yield* ModuleCredentialEnrolmentSource)(providerKeyId);
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
