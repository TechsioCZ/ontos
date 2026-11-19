import { Effect } from 'effect';
import { checkLanguageHandoff } from '../domain/language/handoff.ts';
import type { LanguageHandoffCheck } from '../domain/language/handoff.ts';
import { chooseLanguage } from '../domain/language/selection.ts';
import type { LanguageSelectionInput, TemplateBaseIdentity } from '../domain/language/selection.ts';
import type {
  LanguageAvailability,
  LanguageDecision,
  RevisionAvailability,
  SelectedLanguageDecision,
  SupportedLanguage,
} from '../domain/language/vocabulary.ts';
import type { LanguagePolicyPortContract } from './language-policy-port.service.ts';
import { readLanguagePolicySnapshot } from './language-policy-domain.service.ts';
import type { TemplateRevisionPortContract } from './template-revision-port.service.ts';
import { resolveTemplatePin, verifyTemplatePinForHandoff } from './template-revision-domain.service.ts';

/**
 * The approved revision of one language in exactly this type, channel and scope: the #1398 pin contract, mapped to what a
 * language decision needs. A missing or unusable revision and an ambiguous one are different facts; a store failure is
 * neither and propagates, so nothing is decided on a guess.
 */
const availabilityOf = (port: TemplateRevisionPortContract, base: TemplateBaseIdentity, language: SupportedLanguage) =>
  resolveTemplatePin(port, { ...base, language }).pipe(
    Effect.map((pin): RevisionAvailability => ({ kind: 'usable', pin })),
    Effect.catchTag('TemplateResolutionFailed', (failure) =>
      Effect.succeed<RevisionAvailability>({
        kind: failure.code === 'template_active_revision_ambiguous' ? 'ambiguous' : 'missing',
      }),
    ),
  );

const resolveLanguageAvailability = Effect.fn('LanguageSelection.availability')(function* availability(
  port: TemplateRevisionPortContract,
  base: TemplateBaseIdentity,
) {
  return (yield* Effect.all(
    { cs: availabilityOf(port, base, 'cs'), en: availabilityOf(port, base, 'en') },
    { concurrency: 1 },
  )) satisfies LanguageAvailability;
});

export type DecideLanguageInput = Omit<LanguageSelectionInput, 'availability' | 'policy'>;

/**
 * The decision for a new Message Intent: resolves the Tenant mode and the approved revision of each language, then
 * chooses. The intent lane stores the returned decision verbatim and never calls this for a retry.
 */
export const decideMessageLanguage = Effect.fn('LanguageSelection.decide')(function* decide(
  templates: TemplateRevisionPortContract,
  policies: LanguagePolicyPortContract,
  input: DecideLanguageInput,
) {
  const policy = yield* readLanguagePolicySnapshot(policies);
  // An unreadable mode needs no template lookup: the handoff is not allowed whatever the templates say.
  const availability: LanguageAvailability =
    policy.kind === 'unreadable'
      ? { cs: { kind: 'missing' }, en: { kind: 'missing' } }
      : yield* resolveLanguageAvailability(templates, input.base);
  return chooseLanguage({ ...input, availability, policy }) satisfies LanguageDecision;
});

/**
 * The last stoppable handoff of a pinned decision. It verifies the pinned revision (#1398: an unsafe-invalidated
 * revision blocks), reads the Current mode and, for an English pin, the Current Czech revision, then lets the pure gate
 * decide. Only the stored decision goes in: a retry cannot select again, and a stop rewrites nothing.
 */
export const verifyLanguageForHandoff = Effect.fn('LanguageSelection.verifyHandoff')(function* verify(
  templates: TemplateRevisionPortContract,
  policies: LanguagePolicyPortContract,
  decision: SelectedLanguageDecision,
) {
  yield* verifyTemplatePinForHandoff(templates, decision.pin);
  const policy = yield* readLanguagePolicySnapshot(policies);
  const currentCzech: RevisionAvailability =
    decision.language === 'en' && policy.kind === 'effective'
      ? yield* availabilityOf(
          templates,
          { channel: decision.pin.channel, messageType: decision.pin.messageType, scope: decision.pin.scope },
          'cs',
        )
      : { kind: 'missing' };
  return checkLanguageHandoff({ currentCzech, decision, policy }) satisfies LanguageHandoffCheck;
});
