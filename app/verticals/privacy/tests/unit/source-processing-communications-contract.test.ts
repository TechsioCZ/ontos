import { trustVerifiedGatewayPrincipalContext, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Option, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import {
  SourceProcessingContextSchema,
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingEligibilityResponseSchema,
} from '../../shared/apis/source-processing-eligibility.ts';
import {
  runSourceProcessingEligibility,
  sourceProcessingCallerAdmitted,
  sourceProcessingEligibilityRead,
} from '../../src/api/source-processing-eligibility.read.ts';
import type { SourceProcessingEligibilityServices } from '../../src/api/source-processing-eligibility.read.ts';
import { makeSourceProcessingFixture } from '../support/source-processing-fixture.ts';

/**
 * #1396 — the public shape of the owner contract for the Communications consumer. These are contract tests; the
 * three outcomes themselves are proven against real ledgers in
 * `tests/integration/source-processing-communications-postgres.test.ts`.
 */
const fixture = makeSourceProcessingFixture({
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const denial = (eligibility: Readonly<Record<string, string>>) => ({
  eligibility,
  evaluatedAt: fixture.evaluatedAt,
  outcome: 'DENIED',
  reason: 'AUTHORITY_NOT_CURRENT',
});
const decodeRequest = Schema.decodeUnknownResult(SourceProcessingEligibilityRequestSchema, {
  onExcessProperty: 'error',
});
const communicationsRequest = { ...fixture.request, consumerModuleId: 'communications.core' };
type Candidate = Parameters<typeof decodeRequest>[0];
const accepted = (input: Candidate) => Result.isSuccess(decodeRequest(input));

describe('#1396 the Communications consumer of the source processing contract', () => {
  it('accepts a qualified source record or a Party target and nothing that names nobody', () => {
    expect(accepted(communicationsRequest)).toBe(true);
    expect(
      accepted({ ...communicationsRequest, source: null, target: { kind: 'PARTY', resourceId: 'party-one' } }),
    ).toBe(true);
    // A native owner operation (no source, no target) identifies nobody: it is not a Communications use.
    expect(accepted({ ...communicationsRequest, source: null, target: null })).toBe(false);
  });

  it('refuses the organization, Symmy and counterparty uses that belong to other consumers', () => {
    expect(accepted({ ...communicationsRequest, organizationBusinessUse: 'COMPANY_ICO' })).toBe(false);
    expect(accepted({ ...communicationsRequest, operation: 'CUSTOMER_SOURCE_INTAKE' })).toBe(false);
    expect(
      accepted({ ...communicationsRequest, target: { kind: 'COUNTERPARTY', resourceId: 'counterparty-one' } }),
    ).toBe(false);
    expect(
      accepted({ ...communicationsRequest, target: { kind: 'PARTY_CONTACT_POINT', resourceId: 'contact-one' } }),
    ).toBe(false);
  });

  it('carries no e-mail address, channel secret or other control field that could select the subject', () => {
    expect(accepted({ ...communicationsRequest, emailAddress: 'someone@example.test' })).toBe(false);
    expect(accepted({ ...communicationsRequest, principalId: '10000000-0000-4000-8000-000000000003' })).toBe(false);
  });

  it('leaves the requests of the original consumers exactly as they were', () => {
    expect(accepted(fixture.request)).toBe(true);
    expect(accepted({ ...fixture.request, source: null, target: null })).toBe(true);
    expect(accepted({ ...fixture.request, consumerModuleId: 'unknown.consumer' })).toBe(false);
  });

  it('keeps the original denial responses valid and adds only an optional, evidenced distinction', () => {
    const plain = { evaluatedAt: fixture.evaluatedAt, outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' };
    expect(Schema.is(SourceProcessingEligibilityResponseSchema)(plain)).toBe(true);
    // An unevidenced claim of a prohibition is not representable: the distinction must carry the owner's evidence.
    expect(
      Schema.is(SourceProcessingEligibilityResponseSchema)({ ...plain, eligibility: { outcome: 'NOT_ALLOWED' } }),
    ).toBe(false);
    expect(
      Schema.is(SourceProcessingEligibilityResponseSchema)({
        ...plain,
        eligibility: { evidence: {}, outcome: 'ALLOWED' },
      }),
    ).toBe(false);
  });

  it('adds a safe discriminator for a denial in which nothing was evaluated, with a closed set of causes', () => {
    const valid = Schema.is(SourceProcessingEligibilityResponseSchema);
    for (const cause of [
      'NO_CONTEXT',
      'MULTIPLE_CONTEXTS',
      'CONTEXT_NOT_CURRENT',
      'PURPOSE_NOT_CURRENT',
      'APPLICABILITY_NOT_CURRENT',
      'SUBJECT_NOT_FOUND',
    ]) {
      expect(valid(denial({ outcome: 'NOT_EVALUATED', reasonCode: cause }))).toBe(true);
    }
    // No cause or an invented cause is not representable, so "nothing evaluated" cannot be unexplained.
    expect(valid(denial({ outcome: 'NOT_EVALUATED' }))).toBe(false);
    expect(valid(denial({ outcome: 'NOT_EVALUATED', reasonCode: 'ANYTHING' }))).toBe(false);
  });

  it('admits the Communications module as a declared caller beside the three original callers', () => {
    expect(sourceProcessingEligibilityRead.descriptor.accessActor?.callers).toEqual([
      'party-registry',
      'commerce-customer-context',
      'symmy-integration',
      'communications',
    ]);
    // The same enrolled workload and the same declaration: no new authority path was invented for Communications.
    expect(sourceProcessingEligibilityRead.descriptor.accessActor?.subjectWorkloads).toEqual([
      'privacy.core.source-processing-check',
    ]);
    expect(sourceProcessingEligibilityRead.descriptor.accessDeclaration?.key).toBe(
      'privacy.core.source-processing-eligibility.read',
    );
  });
});

/**
 * #1396 — the caller of the Read is bound to the consumer it claims. The Shell signs the calling module of a delegated
 * call; the request cannot choose it. These tests drive the real caller check and the real Read body, with only the
 * Privacy ledgers behind them replaced by an empty purpose ledger.
 */
const ids = {
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000001',
};
const compositionRevision = 'e'.repeat(64);
const principal = (authMethod: 'api_key' | 'session') =>
  Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000004',
    authContextRef: `fixture:caller-binding:${authMethod}`,
    authenticationNamespaceId: 'core.staff',
    authMethod,
    legalEntityId: ids.legalEntityId,
    principalId: ids.principalId,
    tenantId: ids.tenantId,
  });
/** A call as the Shell delivers it: the subject is the Principal, the verified actor is the calling module. */
const callFrom = (appId: string | undefined, authMethod: 'api_key' | 'session' = 'session'): OperationalScope => {
  const scope = { ...principal(authMethod), correlationId: 'fixture:caller-binding' };
  return appId === undefined
    ? scope
    : trustVerifiedGatewayPrincipalContext(scope, compositionRevision, undefined, {
        appId,
        buildMarker: `${appId}-build`,
        principalId: '10000000-0000-4000-8000-000000000005',
      });
};

describe('#1396 the caller is bound to the consumer it claims, in both directions', () => {
  const communicationsId = 'communications.core';
  const symmyId = 'integration.symmy';

  it('admits communications.core only from the verified Communications module', () => {
    expect(sourceProcessingCallerAdmitted(communicationsId, callFrom('communications'))).toBe(true);
    // Impersonation: no other module, and no call without a verified module actor, may claim communications.core.
    for (const appId of ['party-registry', 'commerce-customer-context', 'symmy-integration', 'privacy', undefined]) {
      expect(sourceProcessingCallerAdmitted(communicationsId, callFrom(appId))).toBe(false);
    }
    expect(sourceProcessingCallerAdmitted(communicationsId, callFrom(undefined, 'api_key'))).toBe(false);
  });

  it('refuses the Communications module claiming the identity of any other consumer', () => {
    for (const consumer of ['party.registry', 'commerce.customer-context', symmyId]) {
      expect(sourceProcessingCallerAdmitted(consumer, callFrom('communications'))).toBe(false);
      expect(sourceProcessingCallerAdmitted(consumer, callFrom('communications', 'api_key'))).toBe(false);
    }
  });

  it('leaves the other declared owners and the Symmy API-key binding exactly as they were', () => {
    expect(sourceProcessingCallerAdmitted('party.registry', callFrom('party-registry'))).toBe(true);
    expect(sourceProcessingCallerAdmitted('commerce.customer-context', callFrom('commerce-customer-context'))).toBe(
      true,
    );
    expect(sourceProcessingCallerAdmitted(symmyId, callFrom('symmy-integration', 'api_key'))).toBe(true);
    expect(sourceProcessingCallerAdmitted(symmyId, callFrom('symmy-integration', 'session'))).toBe(false);
    expect(sourceProcessingCallerAdmitted(symmyId, callFrom('party-registry', 'api_key'))).toBe(false);
  });

  const decodeSource = Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema);
  const request = decodeSource(communicationsRequest);
  const context = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
    ...makeSourceProcessingFixture(ids).context,
    request,
  });
  const services: SourceProcessingEligibilityServices = {
    contexts: [context],
    // An empty purpose ledger: an admitted caller reaches it and learns the purpose is not current; a refused one never does.
    protections: () => Effect.succeed({ items: [], sourceSubjectRefs: [] }),
    purposes: { get: () => Effect.succeed(Option.none()) },
    repository: {
      listApplicabilityDecisions: () => Effect.succeed([]),
      listApplicabilityPolicies: () => Effect.succeed([]),
      resolveEligibilityInputs: () => Effect.die('the Privacy inputs are never resolved in this test'),
    },
    subjectExists: () => Effect.succeed(true),
  };
  const run = (claimed: typeof request, scope: OperationalScope) =>
    Effect.gen(function* callTheRead() {
      yield* TestClock.setTime(Date.parse(fixture.evaluatedAt));
      return (yield* runSourceProcessingEligibility(claimed, { scope, services })).result;
    });

  it.effect(
    'runs the real Read body for the Communications module and refuses an impersonator before any Privacy fact',
    () =>
      Effect.gen(function* readBody() {
        const admitted = yield* run(request, callFrom('communications'));
        expect(admitted).toEqual({
          eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'PURPOSE_NOT_CURRENT' },
          evaluatedAt: fixture.evaluatedAt,
          outcome: 'DENIED',
          reason: 'PROCESSING_NOT_ALLOWED',
        });
        // The impersonator learns nothing about the exact context: the plain, evidence-free denial, like Symmy's refusal.
        for (const impersonator of ['party-registry', 'symmy-integration', undefined]) {
          expect(yield* run(request, callFrom(impersonator))).toEqual({
            evaluatedAt: fixture.evaluatedAt,
            outcome: 'DENIED',
            reason: 'AUTHORITY_NOT_CURRENT',
          });
        }
      }),
  );

  it.effect('refuses the Communications module for a context that belongs to another consumer', () =>
    Effect.gen(function* borrowedIdentity() {
      const party = decodeSource({ ...fixture.request, consumerModuleId: 'party.registry' });
      expect(yield* run(party, callFrom('communications'))).toEqual({
        evaluatedAt: fixture.evaluatedAt,
        outcome: 'DENIED',
        reason: 'AUTHORITY_NOT_CURRENT',
      });
    }),
  );
});
