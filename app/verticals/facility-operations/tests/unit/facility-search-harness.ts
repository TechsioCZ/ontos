import { CoreSearchQueryRuntime, CoreSearchProjectionHitSchema, ContextAccess } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { expect } from 'effect-rstest';
import { assetsRead } from '../../src/search/assets.provider.ts';
import { devicesRead } from '../../src/search/devices.provider.ts';
import { documentsRead } from '../../src/search/documents.provider.ts';
import { metersRead } from '../../src/search/meters.provider.ts';
import type { FacilitySearchResource } from '../../src/search/record-access.ts';
import { buildFacilitySearchDocuments } from '../../src/services/facility-search-projection.ts';
import { facilityOperationsRegistration } from '../../vertical.registration.ts';
import { company, otherCompany, scope, snapshot, tenantId } from './facility-search-fixtures.ts';

export interface FacilitySearchScenario {
  readonly candidateCount?: number;
  readonly foreignCompany?: boolean;
  readonly foreignOwnerRow?: boolean;
  readonly listOutcome?: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
  readonly missingPredicate?: boolean;
  readonly operationalOnly?: boolean;
  readonly ownerReadDenied?: boolean;
  readonly predicate?: ListAccessPredicate;
  readonly scopeAccess?: 'allowed' | 'denied';
}
const searchKeys = { asset: 'assets', device: 'devices', document: 'documents', meter: 'meters' } as const;
export const runFacilitySearchScenario = (resource: FacilitySearchResource, options: FacilitySearchScenario = {}) =>
  Effect.scoped(
    Effect.gen(function* scenario() {
      const rows = Array.from({ length: options.candidateCount ?? 3 }, (_, index) => ({
        archived: false,
        id: `${resource}-${index}`,
        legalEntityId: company,
        tenantId,
        text: [`Záznam ${index}`],
        title: `Záznam ${index}`,
        type: resource,
      }));
      const documents = yield* buildFacilitySearchDocuments({ ...snapshot, rows });
      const hits = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(
        documents.map((document) => ({
          ...document,
          relevance: { score: 1000, version: '1' },
          selectedLegalEntityId: options.foreignCompany === true ? otherCompany : company,
        })),
      );
      const key = `facility.operations.search-${searchKeys[resource]}.read`;
      const gate = makeTestBoundAccessGate({
        answers: {
          [key]: { outcome: options.listOutcome ?? 'ALLOWED', predicate: options.predicate ?? { groups: [] } },
        },
      });
      const bound =
        options.missingPredicate === true
          ? {
              ...gate.bound,
              list: (question: Parameters<typeof gate.bound.list>[0]) =>
                gate.bound.list(question).pipe(Effect.map(({ decision }) => ({ decision }))),
            }
          : gate.bound;
      const ownerGate = makeTestAccessDecision({
        answers: {
          'facility.operations.api-records.read': { outcome: options.ownerReadDenied === true ? 'DENIED' : 'ALLOWED' },
          'facility.operations.records-restricted.read': {
            outcome: options.operationalOnly === true ? 'DENIED' : 'ALLOWED',
          },
        },
        defaultAnswer: { outcome: 'DENIED' },
      });
      const harness = yield* makeReadTestHarness({
        accessDecision: bound,
        compositionRevision: 'a'.repeat(64),
        executeOwnerQuery: ({ params, sql }) => {
          expect(sql).toContain('jsonb_array_elements');
          expect(sql).toContain('"facility_operations"."agenda_states"');
          expect(params).toContain(tenantId);
          expect(params).toContain(company);
          return Effect.succeed([
            {
              legalEntityId: options.foreignOwnerRow === true ? otherCompany : company,
              records: rows.map(({ archived, id, title }) => ({ archived, id, title })),
              tenantId,
            },
          ]);
        },
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-04T09:00:00Z')),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: facilityOperationsRegistration,
        permissionDecision: 'allowed',
        scope,
        scopeAccess: options.scopeAccess ?? 'allowed',
      });
      Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
        contextPermissions: () => Effect.die('Retired facility permission authority was invoked'),
        resources: () => Effect.die('Retired per-resource authority was invoked'),
      });
      let searched = false;
      const request = {
        input: { query: 'zaznam' },
        principal: scope,
        transport: { correlationId: scope.correlationId },
      };
      const read = Effect.gen(function* run() {
        if (resource === 'asset') {
          return yield* harness.runtime.runRead({ ...request, registration: assetsRead });
        }
        if (resource === 'device') {
          return yield* harness.runtime.runRead({ ...request, registration: devicesRead });
        }
        if (resource === 'document') {
          return yield* harness.runtime.runRead({ ...request, registration: documentsRead });
        }
        return yield* harness.runtime.runRead({ ...request, registration: metersRead });
      });
      const exit = yield* read.pipe(
        Effect.provide(harness.layer),
        Effect.provideService(AccessDecisionGate, ownerGate),
        Effect.provideService(CoreSearchQueryRuntime, {
          search: () =>
            Effect.sync(() => {
              expect(harness.snapshot().statements.join('\n')).toMatch(/commit/iu);
              searched = true;
              return hits;
            }),
        }),
        Effect.exit,
      );
      return { exit, gate: gate.accessDecision, hits, ownerGate, searched, snapshot: harness.snapshot() };
    }),
  );
