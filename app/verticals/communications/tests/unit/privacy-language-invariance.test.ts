import { SourceProcessingEligibilityRequestSchema } from '@app/privacy/api/source-processing-eligibility';
import { NodeCrypto } from '@effect/platform-node';
import { Array as EffectArray, Effect, Layer, Option, Ref, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { decideRequest } from '../../src/domain/intake/decide-request.ts';
import { RecipientLanguageAuthority } from '../../src/domain/intake/recipient-language.ts';
import { ProcessingScopeDeclaration } from '../../src/domain/intake/scope-declaration.ts';
import type { ProcessingScopeDeclarationInput } from '../../src/domain/intake/scope-declaration.ts';
import type { RecipientLanguageContext, SupportedLanguage } from '../../src/domain/language/vocabulary.ts';
import { ProcessingEligibilityGate } from '../../src/domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityQuery } from '../../src/domain/privacy/eligibility-gate.ts';
import { decideMessageHandoffs } from '../../src/domain/privacy/handoff-decision.ts';
import { processingScopeKey, ProcessingScopeSchema } from '../../src/domain/privacy/processing-scope.ts';
import { MessageHandoffDecision } from '../../src/domain/privacy/suppression.ts';
import { privacyRequestOf } from '../../src/integrations/privacy-eligibility-gate.ts';
import {
  catalogOf,
  communicationRequest,
  originalRecipient,
  privacyOwnerDouble,
  recipientLanguageDouble,
  recipientOwnerDouble,
  scopeDeclarationDouble,
  sourceAuthorityDouble,
} from '../support/intake-fixtures.ts';
import { makeInMemoryResendPort } from '../support/in-memory-resend-port.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { baseIdentity, makeInMemoryLanguagePolicyPort, seedLanguages } from '../support/language-fixtures.ts';
import { fixtureType } from './support/catalog-fixtures.ts';
import {
  currentSource,
  handoffItem,
  privacyAllowed,
  privacyGateDouble,
  processingScope,
} from './support/privacy-fixtures.ts';
import { evaluationInput, gateDouble, TEST_GATE_CHECK_TIMEOUT, usable } from './support/recipient-fixtures.ts';

/**
 * [#1397 S13] Language is never a cause for a new Privacy authorisation. The Privacy question Communications asks (the
 * domain query, the exact Processing Scope and the wire request to Privacy's public Read) is derived from the declared
 * scope only, so it is byte-for-byte the same whatever the trusted recipient language is, and a language change between
 * the intake decision and the later recheck before handoff neither adds a Privacy question nor changes one.
 *
 * Every owner here is a labelled TEST DOUBLE and every language tag, scope and recipient is FICTIONAL: this proves how
 * Communications builds its Privacy question, never that a real Privacy owner answers so.
 */

const type = fixtureType();
const RECIPIENT = 'customer-1';
const request = communicationRequest({ bindings: [originalRecipient(RECIPIENT)] });

/** A FICTIONAL, well-formed but unsupported language tag that nothing in Communications can select. */
const FICTIONAL_UNSUPPORTED_TAG = 'tlh-FICTION';
/** A FICTIONAL malformed value: no evidence of any language. */
const FICTIONAL_MALFORMED_TAG = 'not a language tag';

const languages: readonly (readonly [string, RecipientLanguageContext])[] = [
  ['trusted cs', { kind: 'trusted', language: 'cs' }],
  ['trusted en', { kind: 'trusted', language: 'en' }],
  ['trusted en-GB', { kind: 'trusted', language: 'en-GB' }],
  ['trusted unsupported', { kind: 'trusted', language: FICTIONAL_UNSUPPORTED_TAG }],
  ['trusted malformed', { kind: 'trusted', language: FICTIONAL_MALFORMED_TAG }],
  ['absent (not established)', { kind: 'not-established' }],
];

/** Every object key at any depth of a JSON text, so a language field nested anywhere would be found. */
const jsonKeysOf = (json: string): readonly string[] =>
  [...json.matchAll(/"(?<key>(?:[^"\\]|\\.)*)":/gu)].map((match) => match.groups?.['key'] ?? '');
const languageKeysOf = (json: string) => jsonKeysOf(json).filter((key) => /lang|locale/iu.test(key));

/** A recipient language authority that answers `language` and records every read in `reads`. */
const recordingLanguageAuthority = (language: RecipientLanguageContext, reads: string[]) =>
  Layer.succeed(RecipientLanguageAuthority, {
    languageOf: () =>
      Effect.sync(() => {
        reads.push('language');
        return language;
      }),
  });

/**
 * The REAL intake decision (`decideRequest`) over in-memory stores and labelled owner doubles, under one trusted
 * recipient language: returns the plan and every Privacy question the decision asked.
 */
const decideUnder = (language: RecipientLanguageContext, seeded: readonly SupportedLanguage[] = ['cs', 'en']) =>
  Effect.gen(function* decideWithLanguage() {
    const templates = makeInMemoryTemplatePort();
    yield* seedLanguages(templates.port, seeded, { ...baseIdentity, messageType: type.typeId });
    const recipientLanguage = recipientLanguageDouble();
    yield* Ref.set(recipientLanguage.ref, language);
    const privacy = privacyOwnerDouble({ [RECIPIENT]: privacyAllowed });
    const plan = yield* decideRequest(request, {
      policies: makeInMemoryLanguagePolicyPort().port,
      resend: makeInMemoryResendPort().port,
      templates: templates.port,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          catalogOf(type),
          recipientLanguage.layer,
          sourceAuthorityDouble().layer,
          scopeDeclarationDouble().layer,
          recipientOwnerDouble({ [`contact-${RECIPIENT}`]: usable() }).layer,
          privacy.layer,
        ),
      ),
    );
    const intent = Option.getOrThrow(EffectArray.head(plan.intents));
    return { intent, queries: [...privacy.queries] };
  });

/** What the language lane decided for the intent, so a test can show the language really varied. */
const languageOutcomeOf = (intent: Effect.Success<ReturnType<typeof decideUnder>>['intent']) =>
  Option.match(intent.language, {
    onNone: () => 'NONE',
    onSome: (decision) => (decision.outcome === 'selected' ? `selected:${decision.language}` : 'not-sent'),
  });

const onlyQuery = (queries: readonly ProcessingEligibilityQuery[]) => {
  expect(queries).toHaveLength(1);
  return Option.getOrThrow(EffectArray.head(queries));
};

describe('[#1397 S13] Language is never a cause for a new Privacy authorisation', () => {
  it.effect(
    '[#1397 S13] the Privacy question of the intake decision is byte-for-byte identical for cs, en, an unsupported, a malformed and an absent language',
    () =>
      Effect.gen(function* invariantAcrossLanguages() {
        const runs = yield* Effect.all(
          languages.map(([label, language]) => decideUnder(language).pipe(Effect.map((run) => ({ label, ...run })))),
        );
        const baseline = Option.getOrThrow(EffectArray.head(runs));
        const baselineQuery = onlyQuery(baseline.queries);
        const baselineWire = JSON.stringify(yield* privacyRequestOf(baselineQuery));
        for (const run of runs) {
          const query = onlyQuery(run.queries);
          // the domain question, the stored scope and the wire request to Privacy are the same bytes
          expect({ label: run.label, query: JSON.stringify(query) }).toEqual({
            label: run.label,
            query: JSON.stringify(baselineQuery),
          });
          expect(query).toEqual(baselineQuery);
          expect(JSON.stringify(yield* privacyRequestOf(query))).toBe(baselineWire);
          expect(processingScopeKey(Option.getOrThrow(run.intent.scope))).toBe(processingScopeKey(baselineQuery.scope));
          expect(Option.getOrThrow(run.intent.scope)).toEqual(baselineQuery.scope);
        }
        // the language lane really did decide differently, so the invariance is not an artefact of one language
        expect(new Set(runs.map(({ intent }) => languageOutcomeOf(intent)))).toEqual(
          new Set(['selected:cs', 'selected:en']),
        );
        expect(runs.map(({ intent, label }) => [label, languageOutcomeOf(intent)])).toEqual([
          ['trusted cs', 'selected:cs'],
          ['trusted en', 'selected:en'],
          ['trusted en-GB', 'selected:en'],
          ['trusted unsupported', 'selected:cs'],
          ['trusted malformed', 'selected:cs'],
          ['absent (not established)', 'selected:cs'],
        ]);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[#1397 S13] a message the language lane stops (mode B, no Czech revision) asked Privacy exactly the same question as a sent one',
    () =>
      Effect.gen(function* languageStopIsNotAPrivacyCause() {
        const sent = yield* decideUnder({ kind: 'trusted', language: 'cs' });
        // only an English revision exists: the platform default mode B stops a trusted `en` for language reasons
        const stopped = yield* decideUnder({ kind: 'trusted', language: 'en' }, ['en']);
        expect(languageOutcomeOf(stopped.intent)).toBe('not-sent');
        expect(stopped.intent.status).toBe('NOT_SENT');
        expect(JSON.stringify(onlyQuery(stopped.queries))).toBe(JSON.stringify(onlyQuery(sent.queries)));
        expect(JSON.stringify(yield* privacyRequestOf(onlyQuery(stopped.queries)))).toBe(
          JSON.stringify(yield* privacyRequestOf(onlyQuery(sent.queries))),
        );
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[#1397 S13] a language change between intake and the recheck before handoff adds no Privacy question and changes none',
    () =>
      Effect.gen(function* languageChangeBeforeHandoff() {
        const intake = yield* decideUnder({ kind: 'trusted', language: 'cs' });
        const intakeQuery = onlyQuery(intake.queries);
        const storedScope = Option.getOrThrow(intake.intent.scope);
        const recipientBinding = originalRecipient(RECIPIENT);
        const input = evaluationInput(type, [recipientBinding]);

        /** The recheck of the stored intent, while the recipient language authority now says `language`. */
        const recheckUnder = (language: RecipientLanguageContext) =>
          Effect.gen(function* recheck() {
            const languageReads: string[] = [];
            const privacyGate = privacyGateDouble({ [RECIPIENT]: privacyAllowed });
            const decisions = yield* decideMessageHandoffs({ recipient: input, source: currentSource }, [
              handoffItem(input, recipientBinding, 'primary', { scope: storedScope }),
            ]).pipe(
              Effect.provide(
                Layer.mergeAll(
                  gateDouble({ [`contact-${RECIPIENT}`]: usable() }).layer,
                  privacyGate.layer,
                  // offered on purpose: the recheck never consults the recipient language at all
                  recordingLanguageAuthority(language, languageReads),
                ),
              ),
            );
            return { decisions, languageReads: languageReads.length, queries: [...privacyGate.queries] };
          });

        const unchanged = yield* recheckUnder({ kind: 'trusted', language: 'cs' });
        const changed = yield* recheckUnder({ kind: 'trusted', language: 'en' });
        const dropped = yield* recheckUnder({ kind: 'not-established' });

        for (const run of [unchanged, changed, dropped]) {
          // exactly the one Current recheck every handoff owes Privacy anyway, never an extra one for the language
          const query = onlyQuery(run.queries);
          expect(JSON.stringify(query)).toBe(JSON.stringify(onlyQuery(unchanged.queries)));
          expect(query.scope).toEqual(intakeQuery.scope);
          expect(JSON.stringify(yield* privacyRequestOf(query))).toBe(
            JSON.stringify(yield* privacyRequestOf(intakeQuery)),
          );
          expect(run.languageReads).toBe(0);
          expect(run.decisions.map((decision) => MessageHandoffDecision.$is('Proceed')(decision))).toEqual([true]);
        }
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[#1397 S13] the scope is declared and Privacy asked before the language is even read, from inputs that hold no language',
    () =>
      Effect.gen(function* privacyBeforeLanguage() {
        const events: string[] = [];
        const declarationInputs: ProcessingScopeDeclarationInput[] = [];
        const templates = makeInMemoryTemplatePort();
        yield* seedLanguages(templates.port, ['cs', 'en'], { ...baseIdentity, messageType: type.typeId });
        yield* decideRequest(request, {
          policies: makeInMemoryLanguagePolicyPort().port,
          resend: makeInMemoryResendPort().port,
          templates: templates.port,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              catalogOf(type),
              recordingLanguageAuthority({ kind: 'trusted', language: 'en' }, events),
              sourceAuthorityDouble().layer,
              // the labelled scope double, wrapped to record WHEN and FROM WHAT the scope is declared
              Layer.succeed(ProcessingScopeDeclaration, {
                declare: (input) =>
                  Effect.sync(() => {
                    events.push('declare-scope');
                    declarationInputs.push(input);
                    return processingScope(input.binding.recipientRef.resourceId);
                  }),
              }),
              recipientOwnerDouble({ [`contact-${RECIPIENT}`]: usable() }).layer,
              Layer.succeed(ProcessingEligibilityGate, {
                check: (query) =>
                  Effect.suspend(() => {
                    events.push('ask-privacy');
                    return privacyAllowed(query);
                  }),
                checkTimeout: TEST_GATE_CHECK_TIMEOUT,
              }),
            ),
          ),
        );
        expect(events).toEqual(['declare-scope', 'ask-privacy', 'language']);
        expect(declarationInputs).toHaveLength(1);
        const declared = Option.getOrThrow(EffectArray.head(declarationInputs));
        expect(Object.keys(declared).toSorted((left, right) => left.localeCompare(right))).toEqual([
          'binding',
          'request',
          'slotKey',
          'type',
        ]);
        expect(jsonKeysOf(JSON.stringify(declared))).toContain('recipientRef');
        expect(languageKeysOf(JSON.stringify(declared))).toEqual([]);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[#1397 S13] the Privacy question and its wire request carry no language field at any depth', () =>
    Effect.gen(function* noLanguageField() {
      const run = yield* decideUnder({ kind: 'trusted', language: FICTIONAL_UNSUPPORTED_TAG });
      const query = onlyQuery(run.queries);
      const wire = yield* privacyRequestOf(query);
      // the key scan really reads nested keys: the scope's purpose version and the located source record are found
      expect(jsonKeysOf(JSON.stringify(query))).toContain('purposeVersionId');
      expect(jsonKeysOf(JSON.stringify(wire))).toContain('occurrenceId');
      expect(languageKeysOf(JSON.stringify(query))).toEqual([]);
      expect(languageKeysOf(JSON.stringify(wire))).toEqual([]);
      expect(JSON.stringify([query, wire])).not.toContain(FICTIONAL_UNSUPPORTED_TAG);
      expect(Object.keys(query).toSorted((left, right) => left.localeCompare(right))).toEqual([
        'occurrence',
        'recipient',
        'scope',
        'sourceModule',
        'tenantId',
        'typeId',
      ]);
      // neither the scope nor Privacy's published request can even be given a language
      const decodeScope = Schema.decodeUnknownResult(ProcessingScopeSchema, { onExcessProperty: 'error' });
      const decodeWire = Schema.decodeUnknownResult(SourceProcessingEligibilityRequestSchema, {
        onExcessProperty: 'error',
      });
      expect(Result.isSuccess(decodeScope(query.scope))).toBe(true);
      expect(Result.isSuccess(decodeWire(wire))).toBe(true);
      for (const field of ['language', 'locale', 'recipientLanguage']) {
        expect(Result.isFailure(decodeScope({ ...query.scope, [field]: 'en' }))).toBe(true);
        expect(Result.isFailure(decodeWire({ ...wire, [field]: 'en' }))).toBe(true);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
