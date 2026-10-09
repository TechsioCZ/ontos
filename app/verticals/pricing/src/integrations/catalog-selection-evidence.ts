import { executeSelectionEvidenceWithAuthorization } from '@app/catalog/api/client';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { CatalogSelection } from '@app/catalog/domain/catalog-selection-evidence';
import type { CatalogSelectionOwnerAssessmentResult } from '@app/catalog/domain/catalog-selection-owner-contract';
import { Context, Effect, Option, Redacted, Schema } from 'effect';

import {
  CatalogSelectionGatewayCredentialService,
  PricingCatalogSelectionUnavailable,
  unavailableCatalogSelectionGatewayCredentialIssuer,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';
import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';

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

const executeSelectionEvidence: SelectionEvidenceExecutor = (payload, credential, requestCorrelation, options) =>
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

const makeCatalogSelectionAssessmentPort = (dependencies: {
  readonly context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  };
  readonly execute: SelectionEvidenceExecutor;
  readonly issuer: CatalogSelectionGatewayCredentialIssuer;
}): CatalogSelectionAssessmentPort =>
  CatalogSelectionAssessmentService.of({
    assess: (selection) =>
      dependencies.issuer
        .issue({
          audience: 'catalog',
          compositionRevision: dependencies.context.compositionRevision,
          legalEntityId: dependencies.context.legalEntityId,
          requestCorrelation: dependencies.context.requestCorrelation,
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

export const catalogSelectionAssessmentPortFromEnvironment = (
  context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  },
  execute: SelectionEvidenceExecutor = executeSelectionEvidence,
): Effect.Effect<CatalogSelectionAssessmentPort> =>
  Effect.serviceOption(CatalogSelectionGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makeCatalogSelectionAssessmentPort({
        context,
        execute,
        issuer: Option.isSome(issuerOption) ? issuerOption.value : unavailableCatalogSelectionGatewayCredentialIssuer,
      }),
    ),
  );
