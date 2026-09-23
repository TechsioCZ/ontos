import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import {
  CurrentStorefrontApplicationNotFoundProblemSchema,
  CurrentStorefrontApplicationPolicyConflictProblemSchema,
  CurrentStorefrontApplicationPolicyProblemSchema,
  CurrentStorefrontApplicationRequestSchema,
  CurrentStorefrontApplicationResponseSchema,
  executeCurrentStorefrontApplication,
  executeCurrentStorefrontApplicationWithAuthorization,
} from '../../src/index.ts';

const request = Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({
  effectiveAt: '2026-09-22T10:00:00.000Z',
  requestedChannel: 'B2C',
  storefrontAppId: 'shop-cz',
  tenantId: '22222222-2222-4222-8222-222222222222',
});

describe('Storefront Registry Current Storefront Application public contract', () => {
  it('strictly binds Tenant, Storefront Application, requested channel, and effective instant', () => {
    expect(Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)(request)).toEqual(request);
    expect(() =>
      Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({ ...request, effectiveAt: '2026-09-22T10:00:00Z' }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({ ...request, storefrontAppId: 'Shop CZ' }),
    ).toThrow();
    const requestWithExtraField = { ...request, extra: true };
    expect(() => Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)(requestWithExtraField)).toThrow();
  });

  it('accepts Current evidence only when it proves channel, lifecycle, and interval applicability', () => {
    const current = {
      ...request,
      allowedChannels: ['B2C', 'B2B'] as const,
      effectiveInterval: {
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        effectiveTo: '2026-10-01T00:00:00.000Z',
      },
      lifecycle: 'ACTIVE' as const,
      nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
      observedAt: '2026-09-22T09:59:59.000Z',
      outcome: 'CURRENT' as const,
      ownerRevision: 'storefront-application:41',
    };
    expect(Schema.decodeSync(CurrentStorefrontApplicationResponseSchema)(current)).toEqual(current);
    expect(() =>
      Schema.decodeSync(CurrentStorefrontApplicationResponseSchema)({
        ...current,
        allowedChannels: ['B2B'],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentStorefrontApplicationResponseSchema)({
        ...current,
        observedAt: '2026-09-22T10:00:00.001Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CurrentStorefrontApplicationResponseSchema)({
        ...current,
        effectiveInterval: { ...current.effectiveInterval, effectiveTo: request.effectiveAt },
      }),
    ).toThrow();
  });

  it('publishes every typed non-Current outcome and rejects contradictory channel evidence', () => {
    const outcomes = [
      { ...request, outcome: 'NOT_FOUND', reason: 'Application does not exist' },
      {
        ...request,
        lifecycle: 'SUSPENDED',
        outcome: 'NOT_CURRENT',
        ownerRevision: 'storefront-application:39',
        reason: 'Application is suspended',
      },
      {
        ...request,
        allowedChannels: ['B2B'],
        outcome: 'CHANNEL_NOT_ALLOWED',
        ownerRevision: 'storefront-application:41',
        reason: 'Application does not serve B2C',
      },
      { ...request, outcome: 'UNAVAILABLE', reason: 'Owner unavailable', retryable: true },
      { ...request, outcome: 'UNVERIFIABLE', reason: 'Owner evidence is incomplete' },
      {
        ...request,
        observedAt: '2026-09-22T09:00:00.000Z',
        outcome: 'STALE',
        ownerRevision: 'storefront-application:40',
        reason: 'Owner evidence is stale',
      },
    ] as const;

    for (const outcome of outcomes) {
      expect(Schema.decodeSync(CurrentStorefrontApplicationResponseSchema)(outcome).outcome).toBe(outcome.outcome);
    }

    expect(() =>
      Schema.decodeSync(CurrentStorefrontApplicationResponseSchema)({
        ...outcomes[2],
        allowedChannels: ['B2C'],
      }),
    ).toThrow();
  });

  it('publishes the generated not-found, policy-conflict, and policy problem contracts', () => {
    for (const [schema, status, tag] of [
      [CurrentStorefrontApplicationNotFoundProblemSchema, 404, 'CurrentStorefrontApplicationNotFoundProblem'],
      [
        CurrentStorefrontApplicationPolicyConflictProblemSchema,
        409,
        'CurrentStorefrontApplicationPolicyConflictProblem',
      ],
      [CurrentStorefrontApplicationPolicyProblemSchema, 422, 'CurrentStorefrontApplicationPolicyProblem'],
    ] as const) {
      expect(
        Schema.decodeUnknownSync(schema)({
          _tag: tag,
          detail: 'Storefront Registry rejected the governed read',
          status,
          title: 'Current Storefront Application problem',
          type: 'about:blank',
        }).status,
      ).toBe(status);
    }
  });

  it.effect('strictly encodes the request before either governed client executor can invoke HTTP', () =>
    Effect.gen(function* verifyStrictClientEncoding() {
      const invalid = { ...request, effectiveAt: 'not-an-instant' };
      const exit = yield* Effect.exit(
        executeCurrentStorefrontApplicationWithAuthorization(invalid, 'credential', 'correlation'),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(executeCurrentStorefrontApplication).toBeTypeOf('function');
    }),
  );
});
