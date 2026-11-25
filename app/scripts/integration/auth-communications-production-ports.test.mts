import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Effect, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { historyReads } from './support/auth-communications-checks.spec.mts';
import { headersOf, makePostgresRealm, signUp } from './support/auth-communications-realms.spec.mts';
import { authWorld, pendingIntentsOf, step, worldServices } from './support/auth-communications-world.spec.mts';

/**
 * T1-04 guard of the Portal Auth -> Communications end-to-end suites: the owner ports they decide on are the PRODUCTION
 * composition, never a port a test supplies.
 *
 * Two proofs. STATIC: no suite file or support world of the family defines a source-occurrence authority, a recipient gate or a
 * Privacy gate of its own (`findSuppliedOwnerPorts`, which a deliberately bad sample must trip, so the guard is known to bite).
 * DYNAMIC: one real flow shows, from what the owners were ASKED, that the decision and the last stoppable handoff went through
 * the production Portal Auth adapters (two asks of Auth's published Read each) and the production Privacy adapter (two asks of
 * Privacy's eligibility Read, about the subject Privacy itself bound).
 *
 * Labelled stubs of this suite: the producer's Privacy-scope declaration (production declares none: open owner gate #1396 J),
 * the Messaging Adapter (step 22), and the in-process transports to Auth's Read and to the public Action (HTTP and the Shell
 * assertion are proven elsewhere). Every text is FICTIONAL. Nothing here is delivery evidence.
 */

/** Source patterns that stand a test-supplied owner port in for the production adapters. */
const SUPPLIED_PORT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  [
    'a service layer for an owner port',
    /Layer\.(?:succeed|effect|sync)\(\s*(?:SourceOccurrenceAuthority|RecipientCurrentGate|ProcessingEligibilityGate)\b/u,
  ],
  ['an owner-port answer key', /\b(?:sourceAuthority|recipientGate|privacyGate)\b\s*(?::\s*[({]|[,}])/u],
  ['the pre-production intake composition', /\bintakeWith\b/u],
  ['a recipient-gate verdict built by a test', /RecipientGateVerdict\.(?:Usable|Unusable)\(/u],
  ['a scripted Privacy answer', /\bprivacy(?:Allowed|NotAllowed|Indeterminate|Answers)\b/u],
];

/** The ways `source` supplies an owner port itself. Empty for a suite that composes the production ports. */
export const findSuppliedOwnerPorts = (source: string): readonly string[] =>
  SUPPLIED_PORT_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);

const appRoot = path.resolve(import.meta.dirname, '../..');
const familyFiles = [
  'scripts/integration/auth-communications-contract.test.mts',
  'scripts/integration/auth-communications-otp.test.mts',
  'scripts/integration/auth-communications-password-reset.test.mts',
  'scripts/integration/auth-communications-privacy-blocked.test.mts',
  'scripts/integration/auth-communications-route.test.mts',
  'scripts/integration/auth-communications-verify-email.test.mts',
  'scripts/integration/support/auth-communications-checks.spec.mts',
  'scripts/integration/support/auth-communications-realms.spec.mts',
  'scripts/integration/support/auth-communications-world.spec.mts',
  'verticals/communications/tests/support/source-owner-world.ts',
] as const;

describe('The Auth -> Communications suites decide on the production owner ports (T1-04)', () => {
  it('no file of the family supplies a source authority, recipient gate or Privacy gate of its own', () => {
    for (const file of familyFiles) {
      expect([file, findSuppliedOwnerPorts(readFileSync(path.join(appRoot, file), 'utf-8'))]).toEqual([file, []]);
    }
  });

  it('the guard bites: a file that stands its own owner ports in is found', () => {
    const bad = [
      'const gate = Layer.succeed(RecipientCurrentGate, { check: () => RecipientGateVerdict.Usable({ endpoint }) });',
      'const intake = owner.intakeWith({ sourceAuthority, recipientGate });',
      'world.privacyAnswers.set(subject, privacyNotAllowed());',
    ].join('\n');
    expect(findSuppliedOwnerPorts(bad)).toEqual([
      'a service layer for an owner port',
      'an owner-port answer key',
      'the pre-production intake composition',
      'a recipient-gate verdict built by a test',
      'a scripted Privacy answer',
    ]);
  });

  it.live(
    'one real flow is decided and handed off through the production adapters, each owner asked again at the handoff',
    () =>
      Effect.gen(function* productionPorts() {
        const world = yield* authWorld({ mode: 'B' });
        // what each port is: production, or a labelled double
        expect(world.ownerPortSources).toEqual({
          catalog: 'PRODUCTION',
          documentOwner: 'PRODUCTION_UNAVAILABLE_FORM',
          privacyGate: 'PRODUCTION_ADAPTER_OVER_PRIVACY_TRANSPORT',
          recipientGate: 'PRODUCTION_ADAPTER_OVER_AUTH_TRANSPORT',
          recipientLanguage: 'PRODUCTION_NOT_ESTABLISHED',
          scopeDeclaration: 'LABELLED_PRODUCER_DOUBLE',
          sourceAuthority: 'PRODUCTION_ADAPTER_OVER_AUTH_TRANSPORT',
        });
        const realm = yield* makePostgresRealm(world, 'ports');
        const subjectId = yield* signUp(realm);
        yield* Effect.promise(
          async () =>
            await realm.auth.api.requestPasswordReset({ body: { email: realm.email }, headers: headersOf(realm.ip) }),
        );
        yield* realm.relay;
        const [intentId] = pendingIntentsOf(world);
        expect((yield* step(world, world.messageHandoff, intentId ?? '')).kind).toBe('HANDED_OFF');
        const issuanceRef = world.submissions[0]?.request.occurrence.occurrenceId;
        // the source authority asked Auth about the occurrence, the recipient gate about the occurrence and the account: at the
        // decision and again at the last stoppable handoff, never from a remembered answer
        const sourceQuestions = world.authAsked.filter((asked) => asked.recipientSubjectId === undefined);
        const recipientQuestions = world.authAsked.filter((asked) => asked.recipientSubjectId !== undefined);
        expect(sourceQuestions.length).toBeGreaterThanOrEqual(2);
        expect(recipientQuestions.length).toBeGreaterThanOrEqual(2);
        expect(new Set(sourceQuestions.map((asked) => JSON.stringify(asked)))).toEqual(
          new Set([JSON.stringify({ issuanceRef })]),
        );
        expect(new Set(recipientQuestions.map((asked) => JSON.stringify(asked)))).toEqual(
          new Set([JSON.stringify({ issuanceRef, recipientSubjectId: subjectId })]),
        );
        // the Privacy adapter asked the REAL Privacy owner about the subject Privacy itself bound, at the decision and the handoff
        expect(world.privacyBindings).toHaveLength(1);
        expect(world.privacyQueries.length).toBeGreaterThanOrEqual(2);
        expect(Option.fromNullishOr((yield* (yield* historyReads(world)).list()).items[0]).pipe(Option.isSome)).toBe(
          true,
        );
        // a trusted language does not exist in production: a suite that did not ask for the labelled double cannot script one
        const refused = yield* Effect.exit(world.setTrustedLanguage('en'));
        expect(refused._tag).toBe('Failure');
      }).pipe(Effect.scoped, Effect.provide(worldServices)),
  );
});
