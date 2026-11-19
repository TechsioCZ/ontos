import { Schema } from 'effect';

/**
 * Tenant language mode contract (#1399, L-13). The mode decides one thing only: whether a trusted `en` recipient may
 * receive an approved EN revision when no approved usable CS revision exists in the exact type and scope.
 * - B (platform default): a usable approved CS revision is required even for a trusted `en`.
 * - A (chosen by the Tenant): the trusted `en` with an approved usable EN revision is allowed without CS.
 * Neither mode switches on optional message types, user preferences or marketing, and neither changes who receives
 * the message, its Market, its currency or its legal basis.
 */
const uuid = Schema.String.check(Schema.isUUID());
export const LanguagePolicyVersionIdSchema = uuid.pipe(Schema.brand('LanguagePolicyVersionId'));
export const LanguageModeSchema = Schema.Literals(['A', 'B']);
export type LanguageMode = typeof LanguageModeSchema.Type;

/** The mode of a Tenant that never made an own choice, and the version of that platform default. */
export const PLATFORM_DEFAULT_LANGUAGE_MODE: LanguageMode = 'B';
export const PLATFORM_DEFAULT_LANGUAGE_POLICY_VERSION = 1;

/**
 * Safe, opaque reference to the policy version a decision used: an identifier and a number, never a principal, a
 * reason or any tenant data. The platform default is a version too, so a decision made without an own choice still
 * pins which default applied.
 */
export const LanguagePolicyRefSchema = Schema.Union([
  Schema.Struct({
    platformDefaultVersion: Schema.Literal(PLATFORM_DEFAULT_LANGUAGE_POLICY_VERSION),
    source: Schema.Literal('platform-default'),
  }),
  Schema.Struct({
    policyVersionId: LanguagePolicyVersionIdSchema,
    source: Schema.Literal('tenant'),
    versionNumber: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  }),
]);
export type LanguagePolicyRef = typeof LanguagePolicyRefSchema.Type;

/** The effective mode of one Tenant: what the public Read returns and what a new decision pins. */
export const EffectiveLanguagePolicySchema = Schema.Struct({
  mode: LanguageModeSchema,
  policy: LanguagePolicyRefSchema,
});
export type EffectiveLanguagePolicy = typeof EffectiveLanguagePolicySchema.Type;

/** Only `A` or `B` is a value: anything else fails payload decoding before any state is read or written. */
export const SetLanguagePolicyPayloadSchema = Schema.Struct({ mode: LanguageModeSchema });
export const SetLanguagePolicyResultSchema = Schema.Struct({
  /** False when the Tenant's own latest choice already was the requested mode: no new version is appended. */
  changed: Schema.Boolean,
  effective: EffectiveLanguagePolicySchema,
});
