import { Context, Option, Schema } from 'effect';
import type { Effect } from 'effect';

import type { GatewayDelegationError } from './gateway-delegation-errors.ts';
import { WorkloadCredentialAttestationJson } from './module-credential-attestation.ts';
import type { ModuleCredentialRelease } from './module-credential-attestation.ts';
import { isPlatformKeyOwner } from './platform-key-owner.ts';

/** One verified API key and the principal it resolved to, about to act. */
export interface PlatformWorkloadKeyInput {
  /** The company the key's caller asks to act in, or null when it names none. */
  readonly legalEntityId: string | null;
  readonly principalId: string;
  readonly providerKeyId: string;
  readonly tenantId: string;
}

/**
 * Whether a verified key may act for its principal when that principal is a module's internal workload. A workload
 * principal acts only with the key the platform issued it: its metadata attests exactly that principal, tenant and
 * company, the release the Shell serves now and the module's build in it. Any other key of such a principal, issued
 * by a tenant administrator or left from before, is refused, whatever the principal's bindings admit. A principal
 * that is no internal workload passes unchanged.
 */
export class PlatformWorkloadKeyAdmission extends Context.Service<
  PlatformWorkloadKeyAdmission,
  { readonly admit: (input: PlatformWorkloadKeyInput) => Effect.Effect<void, GatewayDelegationError> }
>()('@app/shell-super-app/api/auth/platform-workload-key-admission/PlatformWorkloadKeyAdmission') {}

/** The provider record of one key: what its metadata says and which provider user owns it. */
export interface WorkloadKeyRecord {
  readonly metadata: null | string;
  readonly referenceId: string;
}

/**
 * Whether a key is the one the platform issued this workload principal for the release served now. The attestation
 * counts only on a key the platform key owner holds: metadata copied onto a key someone else owns attests nothing.
 */
export const admitsWorkloadKey = (
  record: WorkloadKeyRecord | undefined,
  input: PlatformWorkloadKeyInput,
  release: ModuleCredentialRelease,
): boolean =>
  record !== undefined &&
  isPlatformKeyOwner(record.referenceId) &&
  Option.exists(
    Option.flatMap(Option.fromNullishOr(record.metadata), (metadata) =>
      Schema.decodeOption(WorkloadCredentialAttestationJson)(metadata),
    ),
    (attestation) =>
      attestation.principalId === input.principalId &&
      attestation.tenantId === input.tenantId &&
      (input.legalEntityId === null || attestation.legalEntityId === input.legalEntityId) &&
      attestation.compositionRevision === release.compositionRevision &&
      release.buildMarkers[attestation.appId] !== undefined &&
      attestation.buildMarker === release.buildMarkers[attestation.appId],
  );
