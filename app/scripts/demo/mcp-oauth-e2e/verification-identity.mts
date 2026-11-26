// The identity the MCP OAuth proof's `--verification` run signs in as and expects back from `ontos_whoami`: the
// canonical CI verification tenant, or, configured as a whole, another deployment's own verification tenant.
import { Config, Effect, Option, Schema } from 'effect';

import { LegalEntityIdSchema, PrincipalIdSchema } from '@app/core-runtime/access/ids';

import { verificationAccount, verificationLegalEntityId } from '../verification-context.mts';

const VerificationIdentitySchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
  persona: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/u)),
  principalId: PrincipalIdSchema,
});

/** Who `--verification` signs in as, and the exact principal and company its whoami must report. */
export type VerificationIdentity = typeof VerificationIdentitySchema.Type;

/** The isolated CI verification tenant (verification-context.mts): the identity when none is configured. */
export const CANONICAL_VERIFICATION_IDENTITY = {
  legalEntityId: verificationLegalEntityId,
  persona: verificationAccount.email,
  principalId: verificationAccount.principalId,
} as const satisfies typeof VerificationIdentitySchema.Encoded;

const VERIFICATION_KEYS = {
  legalEntityId: 'E2E_VERIFICATION_LEGAL_ENTITY_ID',
  persona: 'E2E_VERIFICATION_PERSONA',
  principalId: 'E2E_VERIFICATION_PRINCIPAL_ID',
} as const;

export class VerificationIdentityInvalid extends Schema.TaggedError<VerificationIdentityInvalid>()(
  'VerificationIdentityInvalid',
  { message: Schema.String },
) {}

/**
 * The verification identity of another deployment (the stable environment seeds its own verification tenant). The
 * three settings come together or not at all: a persona with the canonical principal, or the reverse, would prove a
 * mixed identity. Without any of them it is the canonical CI verification identity.
 */
export const loadVerificationIdentity = Effect.gen(function* loadVerificationIdentityEffect() {
  const configured = yield* Config.all({
    legalEntityId: Config.option(
      Config.schema(VerificationIdentitySchema.fields.legalEntityId, VERIFICATION_KEYS.legalEntityId),
    ),
    persona: Config.option(Config.schema(VerificationIdentitySchema.fields.persona, VERIFICATION_KEYS.persona)),
    principalId: Config.option(
      Config.schema(VerificationIdentitySchema.fields.principalId, VERIFICATION_KEYS.principalId),
    ),
  });
  const { legalEntityId, persona, principalId } = configured;
  if (Option.isSome(legalEntityId) && Option.isSome(persona) && Option.isSome(principalId)) {
    return {
      legalEntityId: legalEntityId.value,
      persona: persona.value,
      principalId: principalId.value,
    } satisfies VerificationIdentity;
  }
  if (Option.isNone(legalEntityId) && Option.isNone(persona) && Option.isNone(principalId)) {
    return yield* Schema.decodeEffect(VerificationIdentitySchema)(CANONICAL_VERIFICATION_IDENTITY);
  }
  return yield* new VerificationIdentityInvalid({
    message: `${Object.values(VERIFICATION_KEYS).join(', ')} must be set together or not at all`,
  });
});

/** The parts of `ontos_whoami` the verification run judges. */
export interface VerificationWhoami {
  readonly actingKind: unknown;
  readonly legalEntityId: unknown;
  readonly moduleIds: readonly string[];
  readonly principalId: unknown;
  readonly writePolicy: unknown;
}

/**
 * The verification persona acts as itself (a human), writes only through approval, is exactly the configured principal
 * in the configured company, and sees `work.tasks` and nothing else.
 */
export const verificationWhoamiHolds = (whoami: VerificationWhoami, identity: VerificationIdentity): boolean =>
  whoami.actingKind === 'human' &&
  whoami.writePolicy === 'approval' &&
  whoami.principalId === identity.principalId &&
  whoami.legalEntityId === identity.legalEntityId &&
  whoami.moduleIds.length === 1 &&
  whoami.moduleIds[0] === 'work.tasks';
