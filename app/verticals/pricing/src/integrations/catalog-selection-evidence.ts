import { executeSelectionEvidenceWithAuthorization } from '@app/catalog/api/client';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { CatalogSelection } from '@app/catalog/domain/catalog-selection-evidence';
import type { CatalogSelectionOwnerAssessmentResult } from '@app/catalog/domain/catalog-selection-owner-contract';
import type { OperationalScope } from '@app/core-runtime';
import { Context, Crypto, Effect, Redacted, Schema } from 'effect';

import { PricingCatalogSelectionUnavailable } from '../../shared/domain/pricing-catalog-selection-unavailable.ts';
import { acquireOwnerGatewayConnection } from './owner-gateway-connection.ts';
import type { OwnerGatewayConnectionAcquire } from './owner-gateway-connection.ts';

type SelectionEvidenceRequest = Parameters<typeof executeSelectionEvidenceWithAuthorization>[0];
type SelectionEvidenceEffect = ReturnType<typeof executeSelectionEvidenceWithAuthorization>;
type SelectionEvidenceResponse =
  SelectionEvidenceEffect extends Effect.Effect<infer Success, unknown, unknown> ? Success : never;
type SelectionEvidenceFailure =
  SelectionEvidenceEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type SelectionEvidenceExecutor = (
  payload: SelectionEvidenceRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<SelectionEvidenceResponse, SelectionEvidenceFailure>;

export interface CatalogSelectionAssessmentPort {
  readonly assess: (
    selection: CatalogSelection,
  ) => Effect.Effect<CatalogSelectionOwnerAssessmentResult, PricingCatalogSelectionUnavailable>;
}

class CatalogSelectionAssessmentService extends Context.Service<
  CatalogSelectionAssessmentService,
  CatalogSelectionAssessmentPort
>()('@app/pricing/integrations/catalog-selection-evidence/CatalogSelectionAssessmentService') {}

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);

export const executeSelectionEvidence: SelectionEvidenceExecutor = (payload, credential, requestCorrelation, options) =>
  executeSelectionEvidenceWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options);

const unavailable = (reason: string, cause?: unknown): PricingCatalogSelectionUnavailable => {
  const failure = new PricingCatalogSelectionUnavailable({
    code: 'pricing_catalog_selection_unavailable',
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const assessmentMatchesRequest = (
  assessment: CatalogSelectionOwnerAssessmentResult,
  selection: CatalogSelection,
): boolean => {
  if ('status' in assessment) {
    return assessment.purpose === 'PRICING' && sameSelection(assessment.selection, selection);
  }
  if (assessment.kind === 'NOT_FOUND') {
    return sameSelection(assessment.requested, selection);
  }
  if (assessment.kind === 'NOT_CATALOG_OWNED') {
    return assessment.purpose === 'PRICING' && sameSelection(assessment.selection, selection);
  }
  if (assessment.kind === 'UNVERIFIABLE_OWNER_EVIDENCE') {
    return sameSelection(assessment.selection, selection);
  }
  return true;
};

interface CatalogSelectionAssessmentContext {
  readonly compositionRevision: string;
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
  readonly scope: OperationalScope;
}

export const makeCatalogSelectionAssessmentPort = (dependencies: {
  readonly acquire: OwnerGatewayConnectionAcquire;
  readonly context: CatalogSelectionAssessmentContext;
  readonly execute: SelectionEvidenceExecutor;
}): CatalogSelectionAssessmentPort =>
  CatalogSelectionAssessmentService.of({
    assess: (selection) =>
      dependencies
        .acquire({
          audience: 'catalog',
          compositionRevision: dependencies.context.compositionRevision,
          legalEntityScope: 'tenant',
          requestCorrelation: dependencies.context.requestCorrelation,
          scope: dependencies.context.scope,
        })
        .pipe(
          Effect.flatMap(({ baseUrl, credential }) =>
            dependencies.execute(
              { purpose: 'PRICING', selection },
              credential,
              dependencies.context.requestCorrelation,
              {
                baseUrl,
                compositionRevision: dependencies.context.compositionRevision,
              },
            ),
          ),
          Effect.mapError((cause) =>
            Schema.is(PricingCatalogSelectionUnavailable)(cause)
              ? cause
              : unavailable('Catalog selection assessment is unavailable', cause),
          ),
          Effect.flatMap((response) => {
            if (!assessmentMatchesRequest(response.evidence, selection)) {
              return Effect.fail(unavailable('Catalog returned an assessment for a different selection or purpose'));
            }
            if (
              'status' in response.evidence &&
              response.evidence.status === 'VALID' &&
              response.missingRoles.length > 0
            ) {
              return Effect.fail(unavailable('Catalog returned incomplete evidence for a VALID selection assessment'));
            }
            return Effect.succeed(response.evidence);
          }),
        ),
  });

export const catalogSelectionAssessmentPortFromEnvironment = Effect.fn('catalogSelectionAssessmentPortFromEnvironment')(
  function* catalogSelectionAssessmentPortFromEnvironment(
    context: CatalogSelectionAssessmentContext,
    execute: SelectionEvidenceExecutor = executeSelectionEvidence,
  ): Effect.fn.Return<CatalogSelectionAssessmentPort, never, Crypto.Crypto> {
    const crypto = yield* Crypto.Crypto;
    return makeCatalogSelectionAssessmentPort({
      acquire: (input) => acquireOwnerGatewayConnection(input, crypto),
      context,
      execute,
    });
  },
);
