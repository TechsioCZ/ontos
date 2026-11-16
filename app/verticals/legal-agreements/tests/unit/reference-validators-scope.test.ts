// Command reference validators are built per request from that request's scope. Two companies' requests in one
// process, interleaved, each get their own validators, their own reference credentials and their own lookups.
import { ActiveApplicationCompositionService } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { Effect, Predicate } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it, rstest } from 'effect-rstest';
import type { RecordsRequest as LeasingRequest } from '@app/property-leasing/contracts/records';
import type { RecordsRequest as PropertyRequest } from '@app/property-portfolio/contracts/records';
import { UnitRefSchema } from '@app/property-portfolio/resources/unit';
import { OccupancyRefSchema } from '@app/property-leasing/resources/occupancy';
import {
  AgreementsReferenceValidators,
  AgreementsReferenceValidatorsLive,
} from '../../src/services/persistence.service.ts';

interface IssuedRead {
  readonly authorization: string;
  readonly baseUrl: string;
  readonly correlationId: string;
}

const calls = rstest.hoisted(() => {
  const leasing: IssuedRead[] = [];
  const property: IssuedRead[] = [];
  const sources: string[] = [];
  return { leasing, property, sources };
});

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyA = '20000000-0000-4000-8000-00000000000a';
const companyB = '20000000-0000-4000-8000-00000000000b';
const propertyId = '50000000-0000-4000-8000-000000000001';
const unitId = '50000000-0000-4000-8000-000000000002';

rstest.mock('@app/gateway-principal-verifier/server', () => ({
  ...rstest.requireActual<{
    readonly GatewayPrincipalVerifierConfiguration: typeof GatewayPrincipalVerifierConfiguration;
  }>('@app/gateway-principal-verifier/server'),
  makeReferenceGatewayCredentialSource: (scope: OperationalScope) =>
    Effect.sync(() => {
      calls.sources.push(`${scope.tenantId}/${scope.legalEntityId ?? ''}`);
      return {
        issue: (audience: string) =>
          Effect.succeed({
            apiBaseUrl: `https://${audience}.test/${scope.legalEntityId ?? ''}`,
            authorization: `credential-for-${scope.legalEntityId ?? ''}`,
            compositionRevision: 'composition-1',
          }),
      };
    }),
}));

const issuedRead = (
  authorization: string,
  correlationId: string,
  options: { readonly baseUrl: string },
): IssuedRead => ({ authorization, baseUrl: options.baseUrl, correlationId });

rstest.mock('@app/property-leasing/clients/records', () => ({
  executeRecordsWithAuthorization: (
    _request: LeasingRequest,
    authorization: string,
    correlationId: string,
    options: { readonly baseUrl: string },
  ) =>
    Effect.sync(() => {
      calls.leasing.push(issuedRead(authorization, correlationId, options));
      return { occupancies: [] };
    }),
}));

// The unit and its building belong to company A, whoever asks.
rstest.mock('@app/property-portfolio/clients/records', () => ({
  executeRecordsWithAuthorization: (
    _request: PropertyRequest,
    authorization: string,
    correlationId: string,
    options: { readonly baseUrl: string },
  ) =>
    Effect.sync(() => {
      calls.property.push(issuedRead(authorization, correlationId, options));
      const propertyRef = {
        moduleId: 'property.portfolio',
        resourceId: propertyId,
        resourceType: 'property.portfolio.property',
        tenantId,
      };
      return {
        properties: [
          {
            legalEntityRef: { resourceId: companyA },
            lifecycleState: 'ACTIVE',
            propertyRef,
          },
        ],
        units: [
          {
            lifecycleState: 'ACTIVE',
            propertyRef,
            unitRef: {
              moduleId: 'property.portfolio',
              resourceId: unitId,
              resourceType: 'property.portfolio.unit',
              tenantId,
            },
          },
        ],
      };
    }),
}));

const credentialOf = (company: string) => `credential-for-${company}`;

const scopeOf = (legalEntityId: string, correlationId: string): OperationalScope => ({
  authMethod: 'session',
  correlationId,
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
});

const unitRef = UnitRefSchema.make({
  moduleId: 'property.portfolio',
  resourceId: unitId,
  resourceType: 'property.portfolio.unit',
  tenantId,
});
const occupancyRef = OccupancyRefSchema.make({
  moduleId: 'property.leasing',
  resourceId: '60000000-0000-4000-8000-000000000001',
  resourceType: 'property.leasing.occupancy',
  tenantId,
});

it.layer(AgreementsReferenceValidatorsLive)('per-request reference validators', (suite) => {
  suite.effect('two companies interleaved never share validators, credentials or lookups', () =>
    Effect.gen(function* interleavedCompanies() {
      const referenceValidators = yield* AgreementsReferenceValidators;
      const scopeA = scopeOf(companyA, 'request-a');
      const scopeB = scopeOf(companyB, 'request-b');

      const forA = yield* referenceValidators.forScope(scopeA);
      const forB = yield* referenceValidators.forScope(scopeB);
      expect(forA).not.toBe(forB);
      expect(calls.sources).toEqual([`${tenantId}/${companyA}`, `${tenantId}/${companyB}`]);

      const unitForA = yield* forA.unit(unitRef);
      const refusedForB = yield* Effect.flip(forB.unit(unitRef));
      const unitForAAgain = yield* forA.unit(unitRef);
      expect(unitForA.legalEntityId).toBe(companyA);
      expect(unitForAAgain.legalEntityId).toBe(companyA);
      expect(Predicate.isTagged(refusedForB, 'AgreementsRejected')).toBe(true);
      expect(refusedForB).toMatchObject({ code: 'agreements_rejected', reason: 'unit_not_usable' });

      yield* Effect.flip(forB.occupancy(occupancyRef));
      yield* Effect.flip(forA.occupancy(occupancyRef));

      expect(calls.property.map((read) => [read.correlationId, read.authorization])).toEqual([
        ['request-a', credentialOf(companyA)],
        ['request-a', credentialOf(companyA)],
        ['request-b', credentialOf(companyB)],
        ['request-b', credentialOf(companyB)],
        ['request-a', credentialOf(companyA)],
        ['request-a', credentialOf(companyA)],
      ]);
      expect(calls.leasing.map((read) => [read.correlationId, read.authorization, read.baseUrl])).toEqual([
        ['request-b', credentialOf(companyB), `https://property-leasing.test/${companyB}`],
        ['request-a', credentialOf(companyA), `https://property-leasing.test/${companyA}`],
      ]);
    }).pipe(
      // The reference transport is replaced above; these only satisfy its declared requirements.
      Effect.provideService(ActiveApplicationCompositionService, {
        load: Effect.die('Unexpected composition read in a scope-isolation test'),
      }),
      Effect.provideService(GatewayPrincipalVerifierConfiguration, {
        configuration: Effect.die('Unexpected gateway configuration in a scope-isolation test'),
      }),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request('https://ontos.test/reference-validators')),
      ),
    ),
  );
});
