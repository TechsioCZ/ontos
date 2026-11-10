import { loadModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';
import type { ModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { inArray } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import type { Option } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { apikey } from './db/schema.ts';
import { GatewayDelegationPolicyUnavailable } from './gateway-delegation-policy-unavailable.ts';
import { attestationOf } from './module-credential-attestation.ts';
import type { ModuleCredentialAttestation } from './module-credential-attestation.ts';

/** An enrolled module credential and what its issuing host attested for it, if anything. */
export interface AttestedModuleCredential extends ModuleCredentialEnrolment {
  readonly attestation: Option.Option<ModuleCredentialAttestation>;
}

/** Which module each platform-issued module credential belongs to, read from the platform's own enrolment. */
export class ModuleCredentialEnrolmentSource extends Context.Service<
  ModuleCredentialEnrolmentSource,
  {
    /** Every active module credential; enough to refuse a module key as an ordinary key. */
    readonly load: Effect.Effect<readonly ModuleCredentialEnrolment[], GatewayDelegationPolicyUnavailable>;
    /** The same, each with the build and release its issuing host attested, to derive bindings from. */
    readonly loadAttested: Effect.Effect<readonly AttestedModuleCredential[], GatewayDelegationPolicyUnavailable>;
  }
>()('@app/shell-super-app/api/auth/module-credential-enrolment.service/ModuleCredentialEnrolmentSource') {}

const unavailable = (cause: unknown) => new GatewayDelegationPolicyUnavailable({ cause });

export const ModuleCredentialEnrolmentSourceLive = Layer.effect(
  ModuleCredentialEnrolmentSource,
  Effect.gen(function* makeModuleCredentialEnrolmentSource() {
    const database = yield* CoreDatabase;
    const { executor: auth } = yield* AuthDatabase;
    const load = loadModuleCredentialEnrolment(database.executor).pipe(Effect.mapError(unavailable));
    const loadAttested = Effect.gen(function* loadAttestedEnrolment() {
      const enrolment = yield* load;
      if (enrolment.length === 0) {
        return [];
      }
      const records = yield* auth
        .select({ id: apikey.id, metadata: apikey.metadata })
        .from(apikey)
        .where(
          inArray(
            apikey.id,
            enrolment.map((credential) => credential.providerKeyId),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      const metadata = new Map(records.map((record) => [record.id, record.metadata]));
      return enrolment.map((credential): AttestedModuleCredential => ({
        ...credential,
        attestation: attestationOf(metadata.get(credential.providerKeyId) ?? null),
      }));
    });
    return { load, loadAttested };
  }),
);
