import { trustVerifiedGatewayPrincipalContext, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Exit, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { BindPreVerificationSubjectPayloadSchema } from '../../shared/actions/pre-verification-binding-operations.ts';
import { PreVerificationBindingRejected } from '../../shared/actions/pre-verification-binding-rejected.ts';
import {
  PreVerificationEligibilityRequestSchema,
  PreVerificationEligibilityResponseSchema,
} from '../../shared/apis/pre-verification-eligibility.ts';
import type { PrivacyProcessingIntervention } from '../../shared/domain/privacy-processing-eligibility.ts';
import {
  evaluatePreVerificationEligibility,
  PreVerificationBindingPolicySchema,
  PreVerificationBindingRecordSchema,
  PreVerificationBindingRefSchema,
  rebindPreVerificationSubject,
  resolvePreVerificationPolicy,
} from '../../shared/domain/pre-verification-binding.ts';
import type {
  PreVerificationBindingPolicy,
  PreVerificationBindingRecord,
} from '../../shared/domain/pre-verification-binding.ts';
import { bindPreVerificationSubjectAction } from '../../src/actions/bind-pre-verification-subject.action.ts';
import { withdrawPreVerificationBindingAction } from '../../src/actions/withdraw-pre-verification-binding.action.ts';
import {
  preVerificationBindingsRead,
  runPreVerificationBindings,
} from '../../src/api/pre-verification-bindings.read.ts';
import { preVerificationEligibilityRead } from '../../src/api/pre-verification-eligibility.read.ts';
import { PreVerificationBindingRepository } from '../../src/persistence/pre-verification-binding-repository.ts';
import {
  bindPreVerificationSubject,
  evaluatePreVerificationEligibilityRequest,
} from '../../src/services/pre-verification-binding.service.ts';

/**
 * #1406 D.8 — the Privacy pre-verification binding contract: the pure owner rules and the service bodies over an
 * in-memory repository. The same bodies run against the REAL table in
 * `tests/integration/pre-verification-binding-postgres.test.ts`. Every policy value below is FICTIONAL.
 */
const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principalId = '20000000-0000-4000-8000-000000000003';
const bindingRef = PreVerificationBindingRefSchema.make('20000000-0000-4000-8000-0000000000b1');
const source = {
  moduleId: 'commerce.customer-context',
  resourceId: 'fictional-provider-subject-1',
  resourceType: 'fictional.portal-account',
} as const;
const asOf = '2026-11-22T10:00:00.000Z';
const FAR = '2099-12-31T00:00:00.000Z';

const policyOf = (
  overrides: Partial<typeof PreVerificationBindingPolicySchema.Encoded> = {},
): PreVerificationBindingPolicy =>
  Schema.decodeUnknownSync(PreVerificationBindingPolicySchema)({
    effectiveFrom: '2026-11-01T00:00:00.000Z',
    legalBasisRef: 'fictional-legal-basis:contract',
    policyRef: 'fictional-policy:verify',
    revision: 'fictional-r1',
    scope: {
      controllerRef: 'fictional-controller',
      dataCategoryRefs: ['fictional:contact'],
      operation: 'FICTIONAL_SEND',
      processingScopeRef: { scopeId: 'fictional-scope', scopeType: 'privacy.processing-scope' },
      purposeRef: 'fictional-purpose',
      purposeVersionId: 'fictional-purpose-v1',
      recipientRefs: ['fictional.communications'],
    },
    sourceModuleId: 'commerce.customer-context',
    sourcePurposeRef: 'fictional.source.verify',
    sourceResourceType: source.resourceType,
    tenantId,
    validUntil: '2026-12-31T00:00:00.000Z',
    ...overrides,
  });

const bindingOf = (overrides: Partial<PreVerificationBindingRecord> = {}): PreVerificationBindingRecord =>
  Schema.decodeUnknownSync(PreVerificationBindingRecordSchema)({
    bindingRef,
    boundAt: '2026-11-22T09:00:00.000Z',
    revision: 1,
    source,
    status: 'ACTIVE',
    tenantId,
    updatedAt: '2026-11-22T09:00:00.000Z',
    validUntil: '2026-11-22T11:00:00.000Z',
    ...overrides,
  });

const withdrawal = { evidenceRef: 'fictional-dsr-case', withdrawnAt: asOf, withdrawnBy: principalId };

const tenantQuery = {
  sourceModuleId: 'commerce.customer-context',
  sourcePurposeRef: 'fictional.source.verify',
  sourceResourceType: source.resourceType,
  tenantId,
} as const;

const evaluate = (
  binding: PreVerificationBindingRecord,
  policy = policyOf(),
  interventions: readonly PrivacyProcessingIntervention[] = [],
) => evaluatePreVerificationEligibility({ asOf, binding: Option.some(binding), interventions, policy });

/** One objection or restriction Privacy recorded for the bound subject in the policy's exact scope. FICTIONAL. */
const interventionOf = (
  kind: PrivacyProcessingIntervention['kind'],
  overrides: Partial<PrivacyProcessingIntervention> = {},
): PrivacyProcessingIntervention => ({
  currentness: {
    authoritative: true,
    observedAt: '2026-11-22T09:30:00.000Z',
    revision: 'fictional-intervention-r1',
    sourceRef: 'privacy.core.processing-interventions',
  },
  interventionRef: `fictional-${kind.toLowerCase()}-1`,
  kind,
  scope: {
    ...policyOf().scope,
    subjectRef: {
      moduleId: 'privacy.core',
      resourceId: bindingRef,
      resourceType: 'privacy.core.privacy-subject',
      tenantId,
    },
  },
  status: 'ACTIVE',
  ...overrides,
});

describe('#1406 D.8 the policy of an exact use', () => {
  it('finds the one current policy of the exact Tenant-wide use', () => {
    expect(resolvePreVerificationPolicy([policyOf()], tenantQuery, asOf)).toEqual({
      kind: 'CURRENT',
      policy: policyOf(),
    });
  });

  it('never matches a Legal Entity policy for a Tenant-wide use, nor the reverse', () => {
    expect(resolvePreVerificationPolicy([policyOf({ legalEntityId })], tenantQuery, asOf)).toEqual({
      kind: 'NOT_EVALUATED',
      reasonCode: 'NO_CONTEXT',
    });
    expect(resolvePreVerificationPolicy([policyOf()], { ...tenantQuery, legalEntityId }, asOf)).toEqual({
      kind: 'NOT_EVALUATED',
      reasonCode: 'NO_CONTEXT',
    });
  });

  it('names several policies, a policy outside its validity and another operation distinctly', () => {
    expect(resolvePreVerificationPolicy([policyOf(), policyOf({ revision: 'r2' })], tenantQuery, asOf)).toEqual({
      kind: 'NOT_EVALUATED',
      reasonCode: 'MULTIPLE_CONTEXTS',
    });
    expect(
      resolvePreVerificationPolicy([policyOf({ effectiveFrom: '2026-11-23T00:00:00.000Z' })], tenantQuery, asOf),
    ).toEqual({ kind: 'NOT_EVALUATED', reasonCode: 'CONTEXT_NOT_CURRENT' });
    expect(resolvePreVerificationPolicy([policyOf()], { ...tenantQuery, operation: 'OTHER' }, asOf)).toEqual({
      kind: 'NOT_EVALUATED',
      reasonCode: 'NO_CONTEXT',
    });
  });

  it('refuses a policy that ends before it starts', () => {
    expect(() => policyOf({ validUntil: '2026-10-01T00:00:00.000Z' })).toThrow();
  });
});

describe('#1406 D.8 the eligibility of one bound subject keeps three outcomes apart', () => {
  it('is ALLOWED for an active, current binding under a current policy whose basis needs no Consent', () => {
    const result = evaluate(bindingOf());
    expect(result.kind === 'EVALUATED' && result.outcome.outcome).toBe('ALLOWED');
    // the evaluated scope is the POLICY's, with Privacy's own subject reference
    expect(result.kind === 'EVALUATED' && result.outcome.evaluatedScope).toEqual({
      ...policyOf().scope,
      subjectRef: {
        moduleId: 'privacy.core',
        resourceId: bindingRef,
        resourceType: 'privacy.core.privacy-subject',
        tenantId,
      },
    });
  });

  it('is a proven NOT_ALLOWED for a withdrawn binding, even past its validity', () => {
    const withdrawn = bindingOf({ status: 'WITHDRAWN', validUntil: '2026-11-22T09:30:00.000Z', withdrawal });
    expect(evaluate(withdrawn)).toMatchObject({
      kind: 'EVALUATED',
      outcome: { outcome: 'NOT_ALLOWED', reasonCodes: ['pre_verification_binding_withdrawn'] },
    });
  });

  it('is INDETERMINATE, never ALLOWED, past the validity the source stated', () => {
    expect(evaluate(bindingOf({ validUntil: '2026-11-22T09:30:00.000Z' }))).toMatchObject({
      kind: 'EVALUATED',
      outcome: { outcome: 'INDETERMINATE', reasonCodes: ['pre_verification_binding_expired'] },
    });
  });

  it('is INDETERMINATE when the basis needs a Consent nobody can have given before verification', () => {
    expect(evaluate(bindingOf(), policyOf({ legalBasisRef: 'legal-basis:consent' }))).toMatchObject({
      kind: 'EVALUATED',
      outcome: { outcome: 'INDETERMINATE', reasonCodes: ['consent_absent'] },
    });
  });

  it('P1: is a proven NOT_ALLOWED when Privacy recorded a restriction or an objection for the bound subject', () => {
    for (const kind of ['RESTRICTION', 'OBJECTION'] as const) {
      const result = evaluate(bindingOf(), policyOf(), [interventionOf(kind)]);
      expect(result).toMatchObject({
        kind: 'EVALUATED',
        outcome: {
          inputResolutions: { [kind.toLowerCase()]: { state: 'CURRENT' } },
          outcome: 'NOT_ALLOWED',
          reasonCodes: [kind === 'RESTRICTION' ? 'processing_restriction_active' : 'processing_objection_active'],
        },
      });
    }
  });

  it('P1: is ALLOWED when Privacy holds no current intervention for the bound subject in that scope', () => {
    const resolved = interventionOf('RESTRICTION', {
      currentness: { ...interventionOf('RESTRICTION').currentness, observedAt: '2026-11-22T09:45:00.000Z' },
      interventionRef: 'fictional-restriction-resolved',
      status: 'RESOLVED',
    });
    const otherSubject = interventionOf('OBJECTION', {
      scope: {
        ...interventionOf('OBJECTION').scope,
        subjectRef: { ...interventionOf('OBJECTION').scope.subjectRef, resourceId: 'other' },
      },
    });
    const later = interventionOf('OBJECTION', {
      currentness: { ...interventionOf('OBJECTION').currentness, observedAt: '2026-11-22T10:30:00.000Z' },
    });
    for (const interventions of [[], [interventionOf('RESTRICTION'), resolved], [otherSubject], [later]]) {
      expect(evaluate(bindingOf(), policyOf(), interventions)).toMatchObject({
        kind: 'EVALUATED',
        outcome: {
          inputResolutions: { objection: { state: 'CURRENT' }, restriction: { state: 'CURRENT' } },
          outcome: 'ALLOWED',
        },
      });
    }
  });

  it('P1: is INDETERMINATE, never ALLOWED, when Privacy cannot resolve the current intervention', () => {
    const conflicting = [
      interventionOf('RESTRICTION'),
      interventionOf('RESTRICTION', { interventionRef: 'fictional-other', status: 'RESOLVED' }),
    ];
    expect(evaluate(bindingOf(), policyOf(), conflicting)).toMatchObject({
      kind: 'EVALUATED',
      outcome: { inputResolutions: { restriction: { state: 'UNAVAILABLE' } }, outcome: 'INDETERMINATE' },
    });
  });

  it('evaluates nothing for a binding of another Legal Entity, source type or for no binding', () => {
    expect(evaluate(bindingOf({ legalEntityId }))).toEqual({ kind: 'NOT_EVALUATED', reasonCode: 'SUBJECT_NOT_FOUND' });
    expect(evaluate(bindingOf({ source: { ...source, resourceType: 'other' } }))).toEqual({
      kind: 'NOT_EVALUATED',
      reasonCode: 'SUBJECT_NOT_FOUND',
    });
    expect(
      evaluatePreVerificationEligibility({ asOf, binding: Option.none(), interventions: [], policy: policyOf() }),
    ).toEqual({
      kind: 'NOT_EVALUATED',
      reasonCode: 'SUBJECT_NOT_FOUND',
    });
  });

  it('extends a binding only to a later occurrence and never reopens a withdrawal', () => {
    expect(rebindPreVerificationSubject(bindingOf(), '2026-11-22T12:00:00.000Z', asOf)).toMatchObject({
      revision: 2,
      validUntil: '2026-11-22T12:00:00.000Z',
    });
    const earlier = bindingOf();
    expect(rebindPreVerificationSubject(earlier, '2026-11-22T10:30:00.000Z', asOf)).toBe(earlier);
    const withdrawn = bindingOf({ status: 'WITHDRAWN', withdrawal });
    expect(rebindPreVerificationSubject(withdrawn, '2026-11-22T12:00:00.000Z', asOf).status).toBe('WITHDRAWN');
  });
});

describe('#1406 D.8 nothing secret has a field in the published contract', () => {
  it('refuses an address, a token or a code next to the source reference', () => {
    const payload = {
      occurrence: { occurrenceId: 'fictional-issuance', validUntil: '2026-11-22T11:00:00.000Z' },
      source,
      sourcePurposeRef: 'fictional.source.verify',
    };
    expect(Exit.isSuccess(Schema.decodeUnknownExit(BindPreVerificationSubjectPayloadSchema)(payload))).toBe(true);
    for (const secret of [{ email: 'person@example.test' }, { token: 'fictional-token' }, { otp: '123456' }]) {
      const exit = Schema.decodeUnknownExit(BindPreVerificationSubjectPayloadSchema, { onExcessProperty: 'error' })({
        ...payload,
        ...secret,
      });
      expect(Exit.isFailure(exit)).toBe(true);
    }
    expect(new Set(Object.keys(PreVerificationEligibilityRequestSchema.fields))).toEqual(
      new Set(['bindingRef', 'consumerModuleId', 'operation', 'sourcePurposeRef']),
    );
  });
});

const principalScope = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '20000000-0000-4000-8000-000000000004',
  authContextRef: 'fixture:pre-verification',
  authenticationNamespaceId: 'core.staff',
  authMethod: 'session',
  principalId,
  tenantId,
});

/** A Tenant-wide call as the Shell delivers it: the subject is the Principal, the verified actor is the calling module. */
const scopeFrom = (appId: string | null): OperationalScope => {
  const scope = { ...principalScope, correlationId: 'fixture:pre-verification' };
  return appId === null
    ? scope
    : trustVerifiedGatewayPrincipalContext(scope, 'e'.repeat(64), undefined, {
        appId,
        buildMarker: `${appId}-build`,
        principalId: '20000000-0000-4000-8000-000000000005',
      });
};

/** An in-memory repository of the exact scope; the real one runs in the PostgreSQL suite. */
const memoryRepository = (
  seed: readonly PreVerificationBindingRecord[] = [],
  recorded: readonly PrivacyProcessingIntervention[] = [],
) => {
  const rows = new Map(seed.map((record) => [String(record.bindingRef), record]));
  return PreVerificationBindingRepository.of({
    bind: ({ bindingRef: ref, occurrenceValidUntil, source: bound }) =>
      Effect.sync(() => {
        const existing = [...rows.values()].find((row) => row.source.resourceId === bound.resourceId);
        const record =
          existing === undefined
            ? bindingOf({
                bindingRef: PreVerificationBindingRefSchema.make(ref),
                source: bound,
                validUntil: occurrenceValidUntil,
              })
            : rebindPreVerificationSubject(existing, occurrenceValidUntil, asOf);
        rows.set(String(record.bindingRef), record);
        return { kind: 'BOUND', record } as const;
      }),
    findBySource: (named) =>
      Effect.sync(() =>
        Option.fromUndefinedOr([...rows.values()].find((row) => row.source.resourceId === named.resourceId)),
      ),
    get: (ref) => Effect.sync(() => Option.fromUndefinedOr(rows.get(ref))),
    interventions: () => Effect.succeed(recorded),
    withdraw: () => Effect.succeed(Option.none()),
  });
};

const bindPayload = Schema.decodeUnknownSync(BindPreVerificationSubjectPayloadSchema)({
  occurrence: { occurrenceId: 'fictional-issuance', validUntil: FAR },
  source,
  sourcePurposeRef: 'fictional.source.verify',
});
const farPolicies = [policyOf({ validUntil: FAR })];

const bindAs = (appId: string | null, payload = bindPayload, policies = farPolicies) =>
  bindPreVerificationSubject(payload, scopeFrom(appId), {
    newBindingRef: Effect.succeed(bindingRef),
    policies,
    repository: memoryRepository(),
  });

const rejectedFor = (reason: PreVerificationBindingRejected['reason']) =>
  new PreVerificationBindingRejected({ code: 'pre_verification_binding_rejected', reason });

const eligibilityRequest = Schema.decodeUnknownSync(PreVerificationEligibilityRequestSchema)({
  bindingRef,
  consumerModuleId: 'communications.core',
  operation: 'FICTIONAL_SEND',
  sourcePurposeRef: 'fictional.source.verify',
});

const askAs = (
  appId: string | null,
  request = eligibilityRequest,
  recorded: readonly PrivacyProcessingIntervention[] = [],
) =>
  evaluatePreVerificationEligibilityRequest(request, scopeFrom(appId), {
    policies: farPolicies,
    repository: memoryRepository([bindingOf({ validUntil: FAR })], recorded),
  });

describe('#1406 D.8 only the source owner binds, and only Communications asks', () => {
  it.live("binds for the verified source module and returns the policy scope with Privacy's own subject", () =>
    Effect.gen(function* boundBySource() {
      const result = yield* bindAs('commerce-customer-context');
      expect(result.status).toBe('ACTIVE');
      expect(result.scope.subjectRef.resourceId).toBe(result.bindingRef);
      expect(result.scope.operation).toBe('FICTIONAL_SEND');
    }),
  );

  it.live('refuses every other caller, a missing policy and a spent occurrence with a typed reason', () =>
    Effect.gen(function* refused() {
      for (const appId of ['communications', 'party-registry', 'privacy', null]) {
        expect(yield* Effect.flip(bindAs(appId))).toEqual(rejectedFor('CALLER_NOT_SOURCE'));
      }
      expect(yield* Effect.flip(bindAs('commerce-customer-context', bindPayload, []))).toEqual(
        rejectedFor('NO_CURRENT_POLICY'),
      );
      const spent = {
        ...bindPayload,
        occurrence: { ...bindPayload.occurrence, validUntil: '2020-01-01T00:00:00.000Z' },
      };
      expect(yield* Effect.flip(bindAs('commerce-customer-context', spent))).toEqual(
        rejectedFor('OCCURRENCE_NOT_CURRENT'),
      );
    }),
  );

  it.live('answers only the verified Communications module, in the published answer shape', () =>
    Effect.gen(function* consumerBound() {
      const allowed = yield* askAs('communications');
      expect(allowed.outcome).toBe('ALLOWED');
      const encoded = Schema.encodeSync(PreVerificationEligibilityResponseSchema)(allowed);
      expect(Exit.isSuccess(Schema.decodeUnknownExit(PreVerificationEligibilityResponseSchema)(encoded))).toBe(true);
      for (const appId of ['commerce-customer-context', 'privacy', null]) {
        // an impostor learns nothing: no evaluation and no reason
        expect(yield* askAs(appId)).toEqual({
          evaluatedAt: expect.any(String),
          outcome: 'DENIED',
          reason: 'AUTHORITY_NOT_CURRENT',
        });
      }
      const unknownBinding = {
        ...eligibilityRequest,
        bindingRef: PreVerificationBindingRefSchema.make('20000000-0000-4000-8000-0000000000ff'),
      };
      expect(yield* askAs('communications', unknownBinding)).toMatchObject({
        eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'SUBJECT_NOT_FOUND' },
        outcome: 'DENIED',
      });
    }),
  );
});

describe('#1406 D.8 a recorded intervention reaches the published answer (P1)', () => {
  it.live('answers PROCESSING_NOT_ALLOWED to Communications for a bound subject with a recorded restriction', () =>
    Effect.gen(function* restricted() {
      const restriction = interventionOf('RESTRICTION', {
        scope: { ...interventionOf('RESTRICTION').scope, ...policyOf({ validUntil: FAR }).scope },
      });
      expect(yield* askAs('communications', eligibilityRequest, [restriction])).toMatchObject({
        eligibility: { outcome: 'NOT_ALLOWED' },
        outcome: 'DENIED',
        reason: 'PROCESSING_NOT_ALLOWED',
      });
    }),
  );
});

describe('#1406 D.8 governed registrations', () => {
  it('declares the Read and both Actions Tenant-scoped with an optional Legal Entity and exact callers', () => {
    expect(preVerificationEligibilityRead.descriptor.legalEntityScope).toBe('optional');
    expect(preVerificationEligibilityRead.descriptor.accessActor?.callers).toEqual(['communications']);
    expect(bindPreVerificationSubjectAction.descriptor.legalEntityScope).toBe('optional');
    expect(bindPreVerificationSubjectAction.descriptor.accessActor?.callers).toEqual(['commerce-customer-context']);
    expect(withdrawPreVerificationBindingAction.descriptor.legalEntityScope).toBe('optional');
    expect(withdrawPreVerificationBindingAction.descriptor.accessActor).toBeUndefined();
  });

  it('P2: declares the locate Read for a Privacy operator, Tenant-scoped with an optional Legal Entity', () => {
    const { descriptor } = preVerificationBindingsRead;
    expect(descriptor.legalEntityScope).toBe('optional');
    expect(descriptor.accessActor).toBeUndefined();
    expect(descriptor.accessDeclaration).toMatchObject({
      key: 'privacy.core.pre-verification-bindings.read',
      kind: 'read',
      risk: 'sensitive',
    });
  });
});

describe('#1406 D.8 a Privacy operator locates the binding of a source account (P2)', () => {
  it.effect('answers the binding of the named account with minimal fields, and nothing for another account', () =>
    Effect.gen(function* locate() {
      const withdrawn = bindingOf({ status: 'WITHDRAWN', validUntil: FAR, withdrawal });
      const services = memoryRepository([withdrawn]);
      const found = yield* runPreVerificationBindings({ source }, { services });
      expect(found).toEqual({
        evidence: { resultCount: 1 },
        result: {
          bindings: [
            { bindingRef, boundAt: withdrawn.boundAt, status: 'WITHDRAWN', validUntil: FAR, withdrawnAt: asOf },
          ],
        },
      });
      expect(JSON.stringify(found)).not.toContain(source.resourceId);
      const other = yield* runPreVerificationBindings(
        { source: { ...source, resourceId: 'fictional-provider-subject-other' } },
        { services },
      );
      expect(other).toEqual({ evidence: { resultCount: 0 }, result: { bindings: [] } });
    }),
  );
});
