import { Option } from 'effect';
import type { LanguageMode, LanguagePolicyRef } from '../../../shared/language-policy.ts';
import { templateScopeKey } from '../../../shared/template-revision.ts';
import type { TemplateIdentity, TemplatePin } from '../../../shared/template-revision.ts';
import { isSupportedLanguage, primaryLanguageSubtag } from './vocabulary.ts';
import type {
  LanguageAvailability,
  LanguageBasis,
  LanguageDecision,
  LanguagePolicySnapshot,
  NotSentLanguageDecision,
  NotSentReason,
  RecipientLanguageContext,
  RevisionAvailability,
  SelectedLanguageDecision,
  SupportedLanguage,
} from './vocabulary.ts';

/** The exact type and scope a decision is about: the template identity without its language. */
export type TemplateBaseIdentity = Omit<TemplateIdentity, 'language'>;

export interface LanguageSelectionInput {
  /** The approved revision state of each language, resolved for exactly `base`; nothing else is consulted. */
  readonly availability: LanguageAvailability;
  readonly base: TemplateBaseIdentity;
  /**
   * The languages the owner allows for this content. Both languages leave the choice to Communications; exactly one
   * is a binding owner condition that no fallback may override (a repeated entry counts once).
   */
  readonly ownerPermittedLanguages: readonly [SupportedLanguage, ...SupportedLanguage[]];
  readonly policy: LanguagePolicySnapshot;
  /**
   * The trusted recipient or flow language. A source locale is only a hint of the source owner and is not an input of
   * this decision at all, and neither is anything inferred from IP, host name or the e-mail domain.
   */
  readonly recipient: RecipientLanguageContext;
}

/** What the trusted context asked for: a supported language, an unsupported one, or nothing established. */
type Requested =
  | { readonly kind: 'supported'; readonly language: SupportedLanguage; readonly raw: string }
  | { readonly kind: 'unsupported'; readonly raw: string }
  | { readonly kind: 'none' };

const requestedOf = (recipient: RecipientLanguageContext): Requested => {
  if (recipient.kind === 'not-established') {
    return { kind: 'none' };
  }
  const subtag = primaryLanguageSubtag(recipient.language);
  if (Option.isNone(subtag)) {
    // a malformed value is no evidence of any language
    return { kind: 'none' };
  }
  return isSupportedLanguage(subtag.value)
    ? { kind: 'supported', language: subtag.value, raw: subtag.value }
    : { kind: 'unsupported', raw: subtag.value };
};

/**
 * A revision counts only when its pin names exactly the type, channel, scope and language this decision is about. A pin
 * of another scope, brand or Tenant never becomes usable by being offered.
 */
export const usablePin = (
  availability: RevisionAvailability,
  base: TemplateBaseIdentity,
  language: SupportedLanguage,
): Option.Option<TemplatePin> =>
  availability.kind === 'usable' &&
  availability.pin.language === language &&
  availability.pin.channel === base.channel &&
  availability.pin.messageType === base.messageType &&
  templateScopeKey(availability.pin.scope) === templateScopeKey(base.scope)
    ? Option.some(availability.pin)
    : Option.none();

/** Adds a key only when its value exists: an absent fact stays an absent key, never an `undefined` one. */
const withOptional = <Base extends object, Key extends string, Value>(
  base: Base,
  key: Key,
  value: Value | undefined,
): Base | (Base & Readonly<Record<Key, Value>>) => (value === undefined ? base : { ...base, [key]: value });

const notSent = (
  stop: {
    readonly affectedLanguage?: SupportedLanguage | undefined;
    readonly mode?: LanguageMode;
    readonly policy?: LanguagePolicyRef;
    readonly reason: NotSentReason;
  },
  input: LanguageSelectionInput,
): NotSentLanguageDecision => {
  const requested = requestedOf(input.recipient);
  const base = withOptional(
    withOptional(
      withOptional({ outcome: 'not-sent', reason: stop.reason } as const, 'affectedLanguage', stop.affectedLanguage),
      'mode',
      stop.mode,
    ),
    'policy',
    stop.policy,
  );
  return withOptional(base, 'requestedLanguage', requested.kind === 'none' ? undefined : requested.raw);
};

/**
 * Chooses the language of one new Message Intent (L-01..L-05, L-13). Pure: the caller resolves the approved revisions
 * and the Tenant mode and this only decides.
 * - A trusted `en` selects the usable EN revision; mode B additionally requires a usable CS revision of
 *   the same type and scope, mode A does not.
 * - No language, an unsupported one or a missing EN revision falls back to `cs` only, and a
 *   missing CS revision then stops the message in both modes. English is never a fallback.
 * - A single owner-permitted language is binding: it is used or the message stops, and no fallback overrides it.
 * - An ambiguous revision stops the message and is never picked at random.
 */
export const chooseLanguage = (input: LanguageSelectionInput): LanguageDecision => {
  if (input.policy.kind === 'unreadable') {
    return notSent({ reason: 'language_policy_unreadable' }, input);
  }
  const { mode, policy } = input.policy;
  const requested = requestedOf(input.recipient);
  const permitted = [...new Set(input.ownerPermittedLanguages)];
  const usable = (language: SupportedLanguage) => usablePin(input.availability[language], input.base, language);
  const ambiguous = (language: SupportedLanguage) => input.availability[language].kind === 'ambiguous';
  const stop = (reason: NotSentReason, affectedLanguage?: SupportedLanguage): NotSentLanguageDecision =>
    notSent({ affectedLanguage, mode, policy, reason }, input);
  // the trusted context as received is kept next to the language actually used
  const select = (language: SupportedLanguage, pin: TemplatePin, basis: LanguageBasis): SelectedLanguageDecision =>
    withOptional(
      { basis, language, mode, outcome: 'selected', pin, policy } as const,
      'requestedLanguage',
      requested.kind === 'none' ? undefined : requested.raw,
    );
  // Mode B: any English message needs the Czech revision of the same type and scope to be usable as well.
  const modeBlocksEnglish = mode === 'B' && Option.isNone(usable('cs'));
  /** The English decision, or none when no usable EN revision exists (the caller then decides what that means). */
  const tryEnglish = (basis: LanguageBasis): LanguageDecision | undefined => {
    const english = usable('en');
    if (Option.isNone(english)) {
      return undefined;
    }
    if (modeBlocksEnglish) {
      return ambiguous('cs')
        ? stop('template_revision_ambiguous', 'cs')
        : stop('czech_revision_required_by_mode_b', 'cs');
    }
    return select('en', english.value, basis);
  };
  const ownerRequiredCzech = () => {
    const czech = usable('cs');
    return Option.isSome(czech) ? select('cs', czech.value, 'owner-required-language') : undefined;
  };
  const czechOrStop = (basis: LanguageBasis): LanguageDecision => {
    if (ambiguous('cs')) {
      return stop('template_revision_ambiguous', 'cs');
    }
    const czech = usable('cs');
    return Option.isSome(czech) ? select('cs', czech.value, basis) : stop('czech_revision_unavailable', 'cs');
  };

  const [onlyPermitted] = permitted;
  if (onlyPermitted !== undefined && permitted.length === 1) {
    // A binding owner language: used as is, or a stop; the recipient's context and every fallback are overridden by it.
    const only = onlyPermitted;
    if (ambiguous(only)) {
      return stop('template_revision_ambiguous', only);
    }
    const decided = only === 'en' ? tryEnglish('owner-required-language') : ownerRequiredCzech();
    return decided ?? stop('owner_required_language_unavailable', only);
  }

  if (requested.kind === 'supported' && requested.language === 'en') {
    if (ambiguous('en')) {
      return stop('template_revision_ambiguous', 'en');
    }
    // a missing EN revision falls back to the approved Czech revision of the same type and scope, and to nothing else
    return tryEnglish('trusted-context') ?? czechOrStop('fallback-revision-missing');
  }
  if (requested.kind === 'supported') {
    return czechOrStop('trusted-context');
  }
  return czechOrStop(
    requested.kind === 'unsupported' ? 'fallback-unsupported-language' : 'default-no-trusted-language',
  );
};
