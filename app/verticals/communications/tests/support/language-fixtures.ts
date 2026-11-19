import { Crypto, DateTime, Effect, Option, Schema } from 'effect';
import { LanguagePolicyStoreUnavailable } from '../../shared/language-policy-errors.ts';
import { LanguagePolicyVersionIdSchema } from '../../shared/language-policy.ts';
import type { LanguageMode } from '../../shared/language-policy.ts';
import { TemplateRevisionIdSchema, TemplateTypeIdSchema } from '../../shared/template-revision.ts';
import type { TemplatePin } from '../../shared/template-revision.ts';
import type { TemplateBaseIdentity } from '../../src/domain/language/selection.ts';
import { NotSentLanguageDecisionSchema, SelectedLanguageDecisionSchema } from '../../src/domain/language/vocabulary.ts';
import type {
  LanguageAvailability,
  LanguageDecision,
  NotSentLanguageDecision,
  SelectedLanguageDecision,
  LanguagePolicySnapshot,
  RevisionAvailability,
  SupportedLanguage,
} from '../../src/domain/language/vocabulary.ts';
import type {
  LanguageModeVersionRecord,
  LanguagePolicyPortContract,
} from '../../src/services/language-policy-port.service.ts';
import type { TemplateRevisionPortContract } from '../../src/services/template-revision-port.service.ts';
import { actorFor, domainFor, fictionalDraft, identity } from './template-fixtures.ts';

export const baseIdentity: TemplateBaseIdentity = {
  channel: 'email',
  messageType: 'fixture.transactional-notice',
  scope: { kind: 'tenant' },
};

export const pinOf = (language: SupportedLanguage, overrides: Partial<TemplatePin> = {}): TemplatePin => ({
  ...baseIdentity,
  decisionTime: DateTime.makeUnsafe('2026-11-19T10:00:00Z'),
  language,
  revisionId: TemplateRevisionIdSchema.make('00000000-0000-4000-8000-0000000000d1'),
  revisionNumber: 1,
  templateTypeId: TemplateTypeIdSchema.make(`00000000-0000-4000-8000-0000000000e${language === 'cs' ? '1' : '2'}`),
  ...overrides,
});

export const usable = (language: SupportedLanguage, overrides: Partial<TemplatePin> = {}): RevisionAvailability => ({
  kind: 'usable',
  pin: pinOf(language, overrides),
});
export const missing: RevisionAvailability = { kind: 'missing' };
export const ambiguous: RevisionAvailability = { kind: 'ambiguous' };
export const availability = (cs: RevisionAvailability, en: RevisionAvailability): LanguageAvailability => ({ cs, en });

export const platformDefaultPolicy: LanguagePolicySnapshot = {
  kind: 'effective',
  mode: 'B',
  policy: { platformDefaultVersion: 1, source: 'platform-default' },
};
export const tenantPolicy = (mode: LanguageMode): LanguagePolicySnapshot => ({
  kind: 'effective',
  mode,
  policy: {
    policyVersionId: LanguagePolicyVersionIdSchema.make('00000000-0000-4000-8000-0000000000f1'),
    source: 'tenant',
    versionNumber: mode === 'A' ? 2 : 1,
  },
});
export const unreadablePolicy: LanguagePolicySnapshot = { kind: 'unreadable' };

const storeUnavailable = () =>
  new LanguagePolicyStoreUnavailable({
    code: 'language_policy_store_unavailable',
    reason: 'The Tenant language mode is unavailable',
  });

/** Same port contract as the PostgreSQL form, in memory, with a switch that makes the setting unreadable. */
export const makeInMemoryLanguagePolicyPort = () => {
  const versions: LanguageModeVersionRecord[] = [];
  const state = { clock: DateTime.makeUnsafe('2026-11-19T11:00:00Z'), unreadable: false, versions };
  const guard = <Value>(read: Effect.Effect<Value>): Effect.Effect<Value, ReturnType<typeof storeUnavailable>> =>
    Effect.suspend(() => (state.unreadable ? Effect.fail(storeUnavailable()) : read));
  const port: LanguagePolicyPortContract = {
    append: (input) =>
      Effect.gen(function* appendVersion() {
        if (state.unreadable) {
          return yield* storeUnavailable();
        }
        const policyVersionId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(Effect.orDie);
        const record: LanguageModeVersionRecord = {
          mode: input.mode,
          policyVersionId,
          setAt: input.setAt,
          setByPrincipalId: input.principalId,
          versionNumber: state.versions.length + 1,
        };
        state.versions.push(record);
        return record;
      }),
    clockNow: guard(Effect.sync(() => state.clock)),
    latest: guard(Effect.sync(() => Option.fromNullishOr(state.versions.at(-1)))),
    lockTenant: guard(Effect.void),
  };
  return { port, state };
};

/**
 * Prepares and activates one fictional revision per requested language of the exact type and scope. Each language gets
 * its own Template Type; nothing is shared between languages, scopes or Tenants.
 */
export const seedLanguages = (
  port: TemplateRevisionPortContract,
  languages: readonly SupportedLanguage[],
  base: TemplateBaseIdentity = baseIdentity,
) =>
  Effect.gen(function* seed() {
    const t = domainFor(port);
    // a Legal Entity scoped template is written by an operation that runs in exactly that Legal Entity
    const actor = actorFor(base.scope.kind === 'tenant' ? null : base.scope.legalEntityId);
    for (const language of languages) {
      const prepared = yield* t.prepare(
        fictionalDraft({ ...identity({ ...base, language }), body: `[FICTIONAL TEST COPY ${language}] {{purpose}}` }),
        actor,
      );
      yield* t.approve(prepared.revision.revisionId, actor);
    }
  });

const isSelected = Schema.is(SelectedLanguageDecisionSchema);
const isNotSent = Schema.is(NotSentLanguageDecisionSchema);
/** The decision as a selection: anything else is a failed expectation of the test. */
export const selectedOf = (decision: LanguageDecision): SelectedLanguageDecision =>
  Option.getOrThrow(Option.liftPredicate(decision, isSelected));
export const notSentOf = (decision: LanguageDecision): NotSentLanguageDecision =>
  Option.getOrThrow(Option.liftPredicate(decision, isNotSent));
