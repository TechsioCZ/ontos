import { ModuleAppIdSchema } from '@app/core-runtime/auth/hosted-module-credentials';
import { Option, Schema } from 'effect';

/**
 * What a module credential was issued for, recorded with the key (its provider metadata) when the issuing host bound
 * it: the module, that module's build marker and the composition revision of the release the issuing host serves.
 * The Shell binds the key only while the installed release has exactly that module build and that revision.
 */
export const ModuleCredentialAttestationSchema = Schema.Struct({
  appId: ModuleAppIdSchema,
  buildMarker: Schema.String.check(Schema.isMinLength(1)),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  ontosModuleCredential: Schema.Literal('attested_v1'),
});
export type ModuleCredentialAttestation = typeof ModuleCredentialAttestationSchema.Type;

/** The provider metadata form of an attestation. */
export const ModuleCredentialAttestationJson = Schema.fromJsonString(ModuleCredentialAttestationSchema);

/** The attestation stored with a key, if its metadata holds one; anything else attests nothing. */
export const attestationOf = (metadata: null | string): Option.Option<ModuleCredentialAttestation> =>
  metadata === null ? Option.none() : Schema.decodeOption(ModuleCredentialAttestationJson)(metadata);

/** What one issuing host attests: the release revision it serves and each hosted module's build marker. */
export interface ModuleCredentialRelease {
  readonly buildMarkers: Readonly<Record<string, string>>;
  readonly compositionRevision: string;
}

/** The release an installed catalog describes, as module credentials are attested for it. */
export const moduleCredentialReleaseOf = (installed: {
  readonly composition: { readonly revision: string };
  readonly contracts: readonly { readonly deployment: { readonly appId: string; readonly buildMarker: string } }[];
}): ModuleCredentialRelease => ({
  buildMarkers: Object.fromEntries(
    installed.contracts.map(({ deployment }) => [deployment.appId, deployment.buildMarker] as const),
  ),
  compositionRevision: installed.composition.revision,
});
