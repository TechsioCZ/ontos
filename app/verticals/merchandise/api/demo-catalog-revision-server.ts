import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';

import { merchandiseApi } from '../shared/api.ts';
import {
  DemoCatalogRevisionAuthenticationProblemSchema,
  DemoCatalogRevisionForbiddenProblemSchema,
  DemoCatalogRevisionInternalProblemSchema,
  DemoCatalogRevisionInvalidProblemSchema,
  DemoCatalogRevisionNotFoundProblemSchema,
  DemoCatalogRevisionPolicyConflictProblemSchema,
  DemoCatalogRevisionPolicyProblemSchema,
  DemoCatalogRevisionUnavailableProblemSchema,
} from '../shared/apis/demo-catalog-revision.ts';
import { demoCatalogRevisionRead } from '../src/api/demo-catalog-revision.read.ts';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';

const problems = makeGovernedReadProblems({
  authentication: DemoCatalogRevisionAuthenticationProblemSchema,
  forbidden: DemoCatalogRevisionForbiddenProblemSchema,
  internal: DemoCatalogRevisionInternalProblemSchema,
  invalid: DemoCatalogRevisionInvalidProblemSchema,
  notFound: DemoCatalogRevisionNotFoundProblemSchema,
  policyConflict: DemoCatalogRevisionPolicyConflictProblemSchema,
  policyIneligible: DemoCatalogRevisionPolicyProblemSchema,
  unavailable: DemoCatalogRevisionUnavailableProblemSchema,
});

/** Authenticated owner handler, mounted with the same governed Read runtime as the other Merchandise reads. */
export const demoCatalogRevisionApiLive = HttpApiBuilder.group(merchandiseApi, 'demoCatalogRevision', (handlers) =>
  handlers.handle(
    'execute',
    makeGovernedReadHttpHandler({
      authenticatePrincipal: authenticateOperationPrincipal,
      problems,
      registration: demoCatalogRevisionRead,
    }),
  ),
);
