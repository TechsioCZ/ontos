import type {
  PriceGroupAssignmentResolutionRequest,
  PriceGroupAssignmentResolutionResponse,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import type {
  PriceGroupCompatibilityDecision,
  ValidatePriceGroupCompatibilityRequest,
} from '@app/price-group-catalog-contracts';
import { Effect, Redacted } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeCommerceResolutionPort } from '../../src/integrations/commerce-price-group-resolution.ts';
import { makePriceGroupCompatibilityPort } from '../../src/integrations/price-group-compatibility.ts';
import type {
  OwnerGatewayConnectionAcquire,
  OwnerGatewayConnectionInput,
} from '../../src/integrations/owner-gateway-connection.ts';
import { ownerConnectionStub, verifiedTestScope } from '../support/owner-gateway-connection.fixture.ts';

const compositionRevision = 'a'.repeat(64);

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000099';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-27T10:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const assignmentRequest: PriceGroupAssignmentResolutionRequest = {
  authorizationSubject: { kind: 'RETAIL' },
  effectiveAt,
  profile,
};
const compatibility = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: '50000000-0000-4000-8000-000000000001',
  definitionRevisionNumber: 3,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: effectiveAt,
  verifiedAt: '2026-09-27T10:00:01.000Z',
} as const;
const assignmentResponse: PriceGroupAssignmentResolutionResponse = {
  effectiveAt,
  profile,
  resolution: {
    _tag: 'ASSIGNED',
    assignmentRef: {
      moduleId: 'commerce.customer-context',
      resourceId: '60000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.customer-context.customer-price-group-assignment',
      tenantId,
    },
    assignmentRevision: 2,
    compatibility,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    priceGroupRef,
  },
};
const compatibilityRequest: ValidatePriceGroupCompatibilityRequest = {
  expectedCurrent: {
    catalogRevision: compatibility.catalogRevision,
    definitionRevisionId: compatibility.definitionRevisionId,
    definitionRevisionNumber: compatibility.definitionRevisionNumber,
    meaningFingerprint: compatibility.meaningFingerprint,
    priceGroupRef,
  },
  priceGroupRef,
  requiredContract: compatibility.requiredContract,
  trustedOperationAt: effectiveAt,
};
const compatibilityDecision: PriceGroupCompatibilityDecision = { evidence: compatibility, kind: 'USABLE' };

const principalId = '40000000-0000-4000-8000-000000000001';

/** Records every owner connection the port requests, then answers with the stub credential for that owner. */
const recordingOwner = (
  issued: OwnerGatewayConnectionInput[],
  credential: string,
  baseUrl: string,
): OwnerGatewayConnectionAcquire => {
  const owner = ownerConnectionStub(credential, baseUrl);
  return (input) => {
    issued.push(input);
    return owner(input);
  };
};

const scopeFor = (requestCorrelation: string) =>
  verifiedTestScope({ correlationId: requestCorrelation, legalEntityId, principalId, tenantId });

const commercePort = (
  requestCorrelation: string,
  execute: Parameters<typeof makeCommerceResolutionPort>[0]['execute'],
  acquire: OwnerGatewayConnectionAcquire,
) =>
  makeCommerceResolutionPort({
    acquire,
    context: {
      compositionRevision,
      legalEntityId,
      requestCorrelation,
      scope: scopeFor(requestCorrelation),
      tenantId,
    },
    execute,
  });

const compatibilityPort = (
  requestCorrelation: string,
  execute: Parameters<typeof makePriceGroupCompatibilityPort>[0]['execute'],
  acquire: OwnerGatewayConnectionAcquire,
) =>
  makePriceGroupCompatibilityPort({
    acquire,
    context: {
      compositionRevision,
      requestCorrelation,
      scope: scopeFor(requestCorrelation),
      tenantId,
    },
    execute,
  });

const commerceOwner = (issued: OwnerGatewayConnectionInput[]) =>
  recordingOwner(issued, 'Bearer commerce-owner-issued', 'https://commerce-customer.example.test');
const priceGroupOwner = (issued: OwnerGatewayConnectionInput[]) =>
  recordingOwner(issued, 'Bearer price-group-owner-issued', 'https://price-groups.example.test');

describe('Price Group interpretation owner adapters', () => {
  it.effect('sends the exact customer profile request and preserves the complete Commerce owner decision', () =>
    Effect.gen(function* exactCommerceResolution() {
      const calls: unknown[] = [];
      const issued: OwnerGatewayConnectionInput[] = [];
      const port = commercePort(
        'commerce-resolution-test',
        (payload, credential, correlation, options) => {
          calls.push({ correlation, credential: Redacted.value(credential), options, payload });
          return Effect.succeed(assignmentResponse);
        },
        commerceOwner(issued),
      );

      const result = yield* port.resolve({ request: assignmentRequest, sellingLegalEntityId: legalEntityId });

      expect(result).toEqual(assignmentResponse);
      expect(
        issued.map(({ audience, compositionRevision: revision, legalEntityScope, requestCorrelation }) => ({
          audience,
          compositionRevision: revision,
          legalEntityScope,
          requestCorrelation,
        })),
      ).toEqual([
        {
          audience: 'commerce-customer-context',
          compositionRevision,
          legalEntityScope: 'subject',
          requestCorrelation: 'commerce-resolution-test',
        },
      ]);
      expect(calls).toEqual([
        {
          correlation: 'commerce-resolution-test',
          credential: 'Bearer commerce-owner-issued',
          options: { baseUrl: new URL('https://commerce-customer.example.test'), compositionRevision },
          payload: assignmentRequest,
        },
      ]);
    }),
  );

  it.effect('rejects cross-Tenant requests and mismatched owner responses as unverifiable', () =>
    Effect.gen(function* rejectUnverifiableCommerceEvidence() {
      let executions = 0;
      const port = commercePort(
        'commerce-resolution-test',
        () => {
          executions += 1;
          return Effect.succeed(
            executions === 1
              ? { ...assignmentResponse, profile: { ...profile, tenantId: otherTenantId } }
              : { ...assignmentResponse, effectiveAt: '2026-09-27T10:00:00.001Z' },
          );
        },
        commerceOwner([]),
      );
      const crossTenantFailure = yield* port
        .resolve({
          request: { ...assignmentRequest, profile: { ...profile, tenantId: otherTenantId } },
          sellingLegalEntityId: legalEntityId,
        })
        .pipe(Effect.flip);
      const mismatchedResponseFailure = yield* port
        .resolve({ request: assignmentRequest, sellingLegalEntityId: legalEntityId })
        .pipe(Effect.flip);
      const mismatchedTimeFailure = yield* port
        .resolve({ request: assignmentRequest, sellingLegalEntityId: legalEntityId })
        .pipe(Effect.flip);

      expect(crossTenantFailure).toMatchObject({ kind: 'UNVERIFIABLE', owner: 'COMMERCE_ASSIGNMENT' });
      expect(mismatchedResponseFailure).toMatchObject({ kind: 'UNVERIFIABLE', owner: 'COMMERCE_ASSIGNMENT' });
      expect(mismatchedTimeFailure).toMatchObject({ kind: 'UNVERIFIABLE', owner: 'COMMERCE_ASSIGNMENT' });
      expect(executions).toBe(2);
    }),
  );

  it.effect('rejects a basis Selling Legal Entity mismatch before owner connection or owner execution', () =>
    Effect.gen(function* rejectSellingLegalEntityMismatch() {
      const issued: OwnerGatewayConnectionInput[] = [];
      let executions = 0;
      const port = commercePort(
        'commerce-resolution-test',
        () => {
          executions += 1;
          return Effect.succeed(assignmentResponse);
        },
        commerceOwner(issued),
      );
      const failure = yield* port
        .resolve({
          request: assignmentRequest,
          sellingLegalEntityId: '20000000-0000-4000-8000-000000000099',
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ kind: 'UNVERIFIABLE', owner: 'COMMERCE_ASSIGNMENT' });
      expect(issued).toHaveLength(0);
      expect(executions).toBe(0);
    }),
  );

  it.effect('sends exact compatibility evidence and preserves the owner decision', () =>
    Effect.gen(function* exactCompatibility() {
      const calls: unknown[] = [];
      const port = compatibilityPort(
        'compatibility-test',
        (payload, credential, correlation, options) => {
          calls.push({ correlation, credential: Redacted.value(credential), options, payload });
          return Effect.succeed(compatibilityDecision);
        },
        priceGroupOwner([]),
      );

      const result = yield* port.validate(compatibilityRequest);

      expect(result).toEqual(compatibilityDecision);
      expect(calls).toEqual([
        {
          correlation: 'compatibility-test',
          credential: 'Bearer price-group-owner-issued',
          options: { baseUrl: new URL('https://price-groups.example.test'), compositionRevision },
          payload: compatibilityRequest,
        },
      ]);
    }),
  );

  it.effect('fails closed when Price Group Catalog evidence is bound to another Group or operation time', () =>
    Effect.gen(function* rejectUnverifiableCompatibilityEvidence() {
      const port = compatibilityPort(
        'compatibility-test',
        () =>
          Effect.succeed({
            evidence: {
              ...compatibility,
              priceGroupRef: { ...priceGroupRef, resourceId: '30000000-0000-4000-8000-000000000099' },
              trustedOperationAt: '2026-09-27T10:00:02.000Z',
            },
            kind: 'USABLE',
          }),
        priceGroupOwner([]),
      );
      const failure = yield* port.validate(compatibilityRequest).pipe(Effect.flip);

      expect(failure).toMatchObject({ kind: 'UNVERIFIABLE', owner: 'PRICE_GROUP_COMPATIBILITY' });
    }),
  );
});
