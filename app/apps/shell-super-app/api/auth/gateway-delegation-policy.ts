import { GatewayAudienceSchema } from '@app/shared-contracts';
import { Config, Effect, Schema } from 'effect';

import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

/**
 * One deployment credential per calling module. `sourceAppId` is any topology app; the installed
 * catalog check at issuance decides whether that app is actually part of the admitted composition.
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
export class GatewayDelegationPolicyUnavailable extends Schema.TaggedError<GatewayDelegationPolicyUnavailable>()(
  'GatewayDelegationPolicyUnavailable',
  { cause: Schema.Defect() },
) {}

/**
 * Issuer-owned deployment credential enrollment; request headers cannot supply this mapping. The variable is
 * required: an absent or malformed value fails the load, so no module key can be served as a subject's key.
 * A deployment with no module enrolled sets it to `[]`.
 */
export const loadGatewayModuleBindings = Config.schema(
  Schema.fromJsonString(bindingsSchema),
  'ONTOS_GATEWAY_MODULE_BINDINGS',
).pipe(Effect.mapError((cause) => new GatewayDelegationPolicyUnavailable({ cause })));

/** Whether the verified credential is a module deployment credential, which may never issue a subject's context. */
export const isGatewayModuleCredential = (bindings: readonly GatewayModuleBinding[], providerKeyId: string): boolean =>
  bindings.some((binding) => binding.providerKeyId === providerKeyId);

/**
 * Refuses a verified key that is a module deployment credential, which may only issue through the delegated
 * endpoint. An unreadable enrolment fails as unavailable; it is never read as "no module key".
 */
export const admitIntegrationCredential = Effect.fn('GatewayDelegationPolicy.admitIntegrationCredential')(
  function* admitIntegrationCredential(providerKeyId: string) {
    const bindings = yield* loadGatewayModuleBindings.pipe(Effect.mapError(delegationUnavailable));
    if (isGatewayModuleCredential(bindings, providerKeyId)) {
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
