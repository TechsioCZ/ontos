import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TechnologyCategorySchema,
  TechnologyConsentChoiceSchema,
  assessTechnologyConsentReassessment,
  resolveTechnologyChoice,
  validateTechnologyCategory,
  validateTechnologyProviderSet,
} from '../../shared/domain/privacy-technology-consent.ts';
import type {
  TechnologyConsentContext,
  TechnologyConsentChoice,
} from '../../shared/domain/privacy-technology-consent.ts';
import type { ConsentScope } from '../../shared/domain/privacy-consent-scope.ts';

const scope: ConsentScope = {
  controllerRef: 'controller:one',
  materialDimensions: [
    { kind: 'SITE', value: 'site:one' },
    { kind: 'TECHNOLOGY_CATEGORY', value: 'cat:analytics' },
  ],
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: 'subject-1',
    resourceType: 'privacy.core.privacy-subject',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:analytics',
    resourceType: 'privacy.core.processing-purpose',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  purposeMeaning: 'Measure product usage',
  purposeVersionRef: 'purpose-version:1',
  scopeRef: 'scope:technology:one',
};

const context: TechnologyConsentContext = {
  addressableUntil: '2026-12-31T00:00:00Z',
  contextRef: 'anonymous:one',
  deviceContextRef: 'device:one',
  evidenceRefs: [],
  siteRef: 'site:one',
  subject: {
    anonymousContext: {
      addressability: 'COOKIE',
      contextRef: 'anonymous:one',
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-12-31T00:00:00Z',
      kind: 'ANONYMOUS_PRIVACY_CONTEXT',
      provenance: { method: 'cookie', source: 'storefront' },
    },
    kind: 'ANONYMOUS',
  },
};

const choice = (outcome: TechnologyConsentChoice['outcome'] = 'GRANTED'): TechnologyConsentChoice => ({
  contextRef: context.contextRef,
  explicit: outcome === 'GRANTED' || outcome === 'REFUSED',
  outcome,
  recordedAt: '2026-01-02T00:00:00Z',
  scope,
});
const trustedNow = '2026-06-01T00:00:00Z';

describe('Technology Consent', () => {
  it('requires governed categories and explicit purpose mapping', () => {
    const category = {
      categoryRef: 'cat:analytics',
      evidenceRefs: ['evidence:category:1'],
      meaning: 'Product measurement',
      processingPurposeRef: 'purpose:analytics',
      purposeVersionRef: 'purpose-version:1',
      status: 'ACTIVE' as const,
    };
    expect(Schema.decodeUnknownSync(TechnologyCategorySchema)(category)).toEqual(category);
    expect(validateTechnologyCategory({ ...category, categoryRef: 'analytics' })).toContain('governed');
    expect(
      validateTechnologyProviderSet({
        evidenceRefs: ['evidence:1'],
        meaning: 'Declared providers',
        providerRefs: ['provider:a', 'provider:a'],
        providerSetRef: 'providers:one',
        version: '1',
      }),
    ).toContain('duplicate');
  });

  it('does not turn first visit, close, or lost persistence into a grant', () => {
    expect(resolveTechnologyChoice({ context, now: trustedNow, persistenceReliable: true, scope })).toBe('ABSENT');
    expect(
      resolveTechnologyChoice({
        context,
        now: trustedNow,
        persisted: choice('ABSENT'),
        persistenceReliable: true,
        scope,
      }),
    ).toBe('UNKNOWN');
    expect(
      resolveTechnologyChoice({ context, now: trustedNow, persisted: choice(), persistenceReliable: false, scope }),
    ).toBe('UNKNOWN');
  });

  it('accepts only an explicit choice for the exact bounded context and scope', () => {
    expect(
      resolveTechnologyChoice({ context, now: trustedNow, persisted: choice(), persistenceReliable: true, scope }),
    ).toBe('GRANTED');
    expect(
      resolveTechnologyChoice({
        context,
        now: trustedNow,
        persisted: { ...choice(), contextRef: 'anonymous:other' },
        persistenceReliable: true,
        scope,
      }),
    ).toBe('UNKNOWN');
    expect(Schema.decodeUnknownSync(TechnologyConsentChoiceSchema)(choice('REFUSED')).outcome).toBe('REFUSED');
  });

  it('does not transfer anonymous consent when an anonymous context is linked', () => {
    const linked = { anonymousContextRef: 'anonymous:one', dataSubjectRef: 'subject:one', linkRef: 'link:one' };
    expect(
      resolveTechnologyChoice({
        context,
        now: trustedNow,
        persisted: { ...choice(), contextRef: linked.anonymousContextRef },
        persistenceReliable: true,
        scope,
      }),
    ).toBe('GRANTED');
    expect(
      resolveTechnologyChoice({
        context: { ...context, contextRef: 'anonymous:new' },
        now: trustedNow,
        persisted: { ...choice(), contextRef: linked.anonymousContextRef },
        persistenceReliable: true,
        scope,
      }),
    ).toBe('UNKNOWN');
  });

  it('fails closed when trusted time reaches either anonymous-context expiry boundary', () => {
    expect(
      resolveTechnologyChoice({
        context,
        now: context.addressableUntil,
        persisted: choice(),
        persistenceReliable: true,
        scope,
      }),
    ).toBe('UNKNOWN');
    expect(
      resolveTechnologyChoice({
        context: { ...context, addressableUntil: '2027-01-01T00:00:00Z' },
        now: context.subject.kind === 'ANONYMOUS' ? context.subject.anonymousContext.expiresAt : trustedNow,
        persisted: choice(),
        persistenceReliable: true,
        scope,
      }),
    ).toBe('UNKNOWN');
  });

  it('requires reprompt or blocking when a material scope changes', () => {
    expect(
      assessTechnologyConsentReassessment({
        current: {
          ...scope,
          materialDimensions: [
            ...scope.materialDimensions,
            { kind: 'TECHNOLOGY_PROVIDER_SET', value: 'providers:one' },
          ],
        },
        materialChange: true,
        previous: scope,
      }),
    ).toMatchObject({ outcome: 'BLOCK_UNTIL_NEW_DECISION' });
    expect(
      assessTechnologyConsentReassessment({
        current: {
          ...scope,
          materialDimensions: [
            ...scope.materialDimensions,
            { kind: 'TECHNOLOGY_PROVIDER_SET', value: 'providers:one' },
          ],
        },
        materialChange: true,
        policyRef: 'policy:reprompt',
        previous: scope,
      }),
    ).toMatchObject({ outcome: 'REPROMPT_REQUIRED' });
  });
});
