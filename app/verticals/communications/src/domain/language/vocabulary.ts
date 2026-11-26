import { Option, Schema } from 'effect';
import { TemplateLanguageSchema, TemplatePinSchema } from '../../../shared/template-revision.ts';
import type { TemplatePin } from '../../../shared/template-revision.ts';
import { LanguageModeSchema, LanguagePolicyRefSchema } from '../../../shared/language-policy.ts';
import type { LanguageMode, LanguagePolicyRef } from '../../../shared/language-policy.ts';

/**
 * Message language vocabulary (#1399). The first stage supports `cs` and `en` only; `cs` is the default and the one
 * fallback. Nothing here knows an address, an IP, a host name or an e-mail domain: the language of a message is decided
 * from a trusted recipient or flow language context, never guessed from where a message goes.
 */
const SupportedLanguageSchema = TemplateLanguageSchema;
export type SupportedLanguage = typeof SupportedLanguageSchema.Type;
export const isSupportedLanguage = Schema.is(SupportedLanguageSchema);

/**
 * The recipient or flow language as the real owner authority supplied it. `not-established` is the absence of any
 * trustworthy language, and a source locale hint is deliberately a different field of the selection input that selection
 * never reads: the source owner informs, Communications decides.
 */
const RecipientLanguageContextSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('trusted'), language: Schema.String.check(Schema.isMaxLength(35)) }),
  Schema.Struct({ kind: Schema.Literal('not-established') }),
]);
export type RecipientLanguageContext = typeof RecipientLanguageContextSchema.Type;

const languageTag = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u;
/**
 * The primary language subtag of a trusted language tag (`en-GB` is `en`, `CS` is `cs`), or none when the value is no
 * well-formed tag. A malformed value is no evidence of a language, so it never selects one.
 */
export const primaryLanguageSubtag = (tag: string): Option.Option<string> =>
  languageTag.test(tag) ? Option.some((tag.split(/[-_]/u)[0] ?? '').toLowerCase()) : Option.none();

/** What the language policy snapshot says right now: an effective mode, or that it cannot be read (fail closed). */
export type LanguagePolicySnapshot =
  | { readonly kind: 'effective'; readonly mode: LanguageMode; readonly policy: LanguagePolicyRef }
  | { readonly kind: 'unreadable' };

/**
 * The state of the approved revision of one language in the exact type and scope. `usable` is approved, active and not
 * invalidated as unsafe; `ambiguous` means more than one revision is active, which is never resolved by a guess.
 */
export type RevisionAvailability =
  | { readonly kind: 'usable'; readonly pin: TemplatePin }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' };
export interface LanguageAvailability {
  readonly cs: RevisionAvailability;
  readonly en: RevisionAvailability;
}

const NotSentReasonSchema = Schema.Literals([
  // A Czech default or fallback is needed and no approved usable Czech revision exists in the exact type and scope.
  'czech_revision_unavailable',
  // Mode B: the trusted English recipient has a usable EN revision but the Czech revision B requires is not usable.
  'czech_revision_required_by_mode_b',
  // The owner permits one language only (or no permitted language is usable) and no usable revision of it exists.
  'owner_required_language_unavailable',
  // More than one revision of the language that is needed is active: no revision is chosen at random.
  'template_revision_ambiguous',
  // The Tenant mode could not be read: a new handoff is not allowed.
  'language_policy_unreadable',
]);
export type NotSentReason = typeof NotSentReasonSchema.Type;

/** Why the language is what it is; the evidence of the original context next to the language actually used. */
const LanguageBasisSchema = Schema.Literals([
  'trusted-context',
  'default-no-trusted-language',
  'fallback-unsupported-language',
  'fallback-revision-missing',
  'owner-required-language',
]);
export type LanguageBasis = typeof LanguageBasisSchema.Type;

const requestedLanguageSchema = Schema.String.check(Schema.isMaxLength(35));
const decisionEvidence = {
  mode: LanguageModeSchema,
  policy: LanguagePolicyRefSchema,
  requestedLanguage: Schema.optionalKey(requestedLanguageSchema),
};
/**
 * The decision a Message Intent pins at its first approved creation (L-04): the language actually used, the exact
 * template identity and revision (the pin), the Tenant mode and a safe reference to its policy version. A retry reuses
 * it verbatim and never selects again; only a new business request makes a new decision.
 */
export const SelectedLanguageDecisionSchema = Schema.Struct({
  ...decisionEvidence,
  basis: LanguageBasisSchema,
  language: SupportedLanguageSchema,
  outcome: Schema.Literal('selected'),
  pin: TemplatePinSchema,
});
export type SelectedLanguageDecision = typeof SelectedLanguageDecisionSchema.Type;
/** A truthful stop. Mode and policy are absent only when the setting itself could not be read. */
export const NotSentLanguageDecisionSchema = Schema.Struct({
  affectedLanguage: Schema.optionalKey(SupportedLanguageSchema),
  mode: Schema.optionalKey(LanguageModeSchema),
  outcome: Schema.Literal('not-sent'),
  policy: Schema.optionalKey(LanguagePolicyRefSchema),
  reason: NotSentReasonSchema,
  requestedLanguage: Schema.optionalKey(requestedLanguageSchema),
});
export type NotSentLanguageDecision = typeof NotSentLanguageDecisionSchema.Type;
export const LanguageDecisionSchema = Schema.Union([SelectedLanguageDecisionSchema, NotSentLanguageDecisionSchema]);
export type LanguageDecision = typeof LanguageDecisionSchema.Type;
