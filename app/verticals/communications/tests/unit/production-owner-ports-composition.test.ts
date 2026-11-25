import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import { CommunicationOutcome } from '../../src/domain/catalog/decision.ts';
import type { TransactionalMessageType } from '../../src/domain/catalog/message-type.ts';
import { decideRequest } from '../../src/domain/intake/decide-request.ts';
import { ProcessingScopeDeclaration } from '../../src/domain/intake/scope-declaration.ts';
import type { ProcessingEligibilityGate } from '../../src/domain/privacy/eligibility-gate.ts';
import { communicationsOwnerPortsOver } from '../../src/composition/owner-ports.ts';
import { actionOwnerCall, underOwnerCall } from '../../src/integrations/owner-call.ts';
import type { PortalAuthOwnerTransport } from '../../src/integrations/portal-auth-owner.ts';
import type { PrivacyOwnerTransport } from '../../src/integrations/privacy-eligibility-gate.ts';
import { makeInMemoryResendPort } from '../support/in-memory-resend-port.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { communicationRequest, privacyOwnerDouble } from '../support/intake-fixtures.ts';
import { baseIdentity, makeInMemoryLanguagePolicyPort, seedLanguages } from '../support/language-fixtures.ts';
import { FIXTURE_TENANT_ID } from './support/catalog-fixtures.ts';
import { privacyAllowed, processingScope } from './support/privacy-fixtures.ts';
import { binding } from './support/recipient-fixtures.ts';

/**
 * T1-01 guard: a type registered `ACTIVE` with an `ACTIVE` onboarding must be decidable by the REAL production owner ports.
 * `communicationsOwnerPortsOver` is the production composition with only the TRANSPORTS to the owners supplied (the HTTP edge
 * of Auth and Privacy, SCRIPTED here: they prove how Communications asks and reads, not that an owner answers so). The catalog,
 * the recipient and source adapters, the Privacy gate and the language and scope ports are the production ones, and no
 * owner port is supplied by the test except where a case says so in its name.
 *
 * Every value is FICTIONAL.
 */

const AUTH = 'commerce.customer-context';
const ISSUANCE = 'pa-1';
const ACCOUNT = 'subject-1';

const activeTypes = approvedMessageTypes.filter(
  ({ onboarding, status }) => status === 'ACTIVE' && onboarding === 'ACTIVE',
);

const ownerCall = actionOwnerCall({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '30000000-0000-4000-8000-000000000004',
    authContextRef: 'fixture:production-owner-ports',
    authenticationNamespaceId: 'core.staff',
    authMethod: 'session',
    principalId: '30000000-0000-4000-8000-000000000003',
    tenantId: FIXTURE_TENANT_ID,
  }),
  correlationId: 'fixture:production-owner-ports',
});

/** Auth's published answer while the issuance is Current for its account. */
const currentAnswer = (question: { readonly recipientSubjectId?: string }) => {
  const stated = {
    issuanceRef: ISSUANCE,
    kind: 'FACTS',
    latestRevision: 1,
    state: `${AUTH}.portal-auth.issuance-current`,
  };
  return question.recipientSubjectId === undefined
    ? stated
    : { ...stated, originalEndpoint: { kind: 'CURRENT', mask: 'h***@example.test' } };
};

const authBinding = () =>
  binding('account-holder', ACCOUNT, ISSUANCE, {
    contactOwner: AUTH,
    contactResourceType: `${AUTH}.portal-auth-endpoint`,
    evidence: {
      kind: 'HISTORICAL_SNAPSHOT',
      snapshotRef: { moduleId: AUTH, resourceId: ISSUANCE, resourceType: `${AUTH}.portal-auth-issuance` },
    },
  });

/** The REAL production ports over scripted transports, deciding one Portal Auth request of the given approved type. */
const decide = (
  type: TransactionalMessageType,
  producer?: Layer.Layer<ProcessingScopeDeclaration | ProcessingEligibilityGate>,
) =>
  Effect.gen(function* decideOnProduction() {
    const authAsked: unknown[] = [];
    const privacyAsked: unknown[] = [];
    const portalAuth: PortalAuthOwnerTransport = (question) =>
      Effect.sync(() => {
        authAsked.push(question);
        return currentAnswer(question);
      });
    const privacy: PrivacyOwnerTransport = (question) =>
      Effect.sync(() => {
        privacyAsked.push(question);
      }).pipe(Effect.andThen(Effect.fail(new Error('a scripted Privacy transport answers nothing'))));
    const templates = makeInMemoryTemplatePort();
    yield* seedLanguages(templates.port, ['cs', 'en'], { ...baseIdentity, messageType: type.typeId });
    const plan = yield* decideRequest(
      communicationRequest({
        bindings: [authBinding()],
        occurrenceId: ISSUANCE,
        purpose: type.purpose,
        sourceModule: type.sourceOwner,
      }),
      {
        policies: makeInMemoryLanguagePolicyPort().port,
        resend: makeInMemoryResendPort().port,
        templates: templates.port,
      },
    ).pipe(
      // a case that names a producer double replaces exactly the scope declaration and the Privacy gate, and nothing else
      Effect.provide(
        producer === undefined
          ? communicationsOwnerPortsOver({ portalAuth, privacy })
          : Layer.merge(communicationsOwnerPortsOver({ portalAuth, privacy }), producer),
      ),
      underOwnerCall(ownerCall),
    );
    return { authAsked, plan, privacyAsked };
  }).pipe(Effect.provide(NodeCrypto.layer));

describe('An ACTIVE type is decided by the real production owner ports (T1-01)', () => {
  it('the production catalog registers the three Portal Auth types as ACTIVE, so this guard has types to prove', () => {
    expect(activeTypes.map(({ sourceOwner }) => sourceOwner)).toEqual([AUTH, AUTH, AUTH]);
  });

  it.effect.each(activeTypes.map((type) => [type.typeId, type] as const))(
    '%s is decided, never left undecided for want of an owner adapter, and stops at the unresolved Privacy context',
    ([, type]) =>
      Effect.gen(function* decidedByProduction() {
        const { authAsked, plan, privacyAsked } = yield* decide(type);
        // a durable decision with one concrete message for the account holder
        expect(
          CommunicationOutcome.$match(plan.decision.outcome, {
            Candidates: ({ candidates }) => candidates.length,
            NoMessage: ({ reason }) => reason,
          }),
        ).toBe(1);
        expect(plan.intents).toHaveLength(1);
        // Auth was asked about the occurrence and again about the recipient, both through its published Read
        expect(authAsked).toEqual([{ issuanceRef: ISSUANCE }, { issuanceRef: ISSUANCE, recipientSubjectId: ACCOUNT }]);
        // no producer declares a Privacy scope yet (#1396 J), so Privacy is never asked about a guess and nothing reaches handoff
        expect(privacyAsked).toHaveLength(0);
        expect(plan.intents[0]).toMatchObject({ reason: Option.some('PRIVACY_INDETERMINATE'), status: 'SUPPRESSED' });
      }),
  );

  it.effect.each(activeTypes.map((type) => [type.typeId, type] as const))(
    '%s reaches the handoff stop once a producer declares its Privacy scope (labelled producer double)',
    ([, type]) =>
      Effect.gen(function* decidedUpToHandoff() {
        const declared = Layer.succeed(ProcessingScopeDeclaration, {
          declare: ({ binding: original, type: declaringType }) =>
            Effect.succeed(
              processingScope(original.recipientRef.resourceId, {
                catalogPurposeRef: Option.getOrThrow(Option.fromNullishOr(declaringType.privacyPurposeRefs[0])),
              }),
            ),
        });
        const double = privacyOwnerDouble({ [ACCOUNT]: privacyAllowed });
        const { plan } = yield* decide(type, Layer.mergeAll(declared, double.layer));
        expect(plan.intents.map(({ status }) => status)).toEqual(['PENDING_HANDOFF']);
        expect(plan.intents[0]?.endpoint).toSatisfy(Option.isSome);
        // the stored endpoint is the contact reference and the mask Auth stated; no address is a field of the plan
        expect(Object.keys(Option.getOrThrow(plan.intents[0]?.endpoint ?? Option.none())).toSorted()).toEqual([
          'channel',
          'contactRef',
          'mask',
        ]);
        expect(double.queries).toHaveLength(1);
      }),
  );
});
