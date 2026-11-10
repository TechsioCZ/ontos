import { GatewayInternalProblemSchema } from '@app/shared-contracts';
import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApiMiddleware } from 'effect/http-api';

import { symmyRouteNotFoundPayload } from '../../shared/symmy-route-not-found.ts';

export const SymmyRouteNotFoundProblemSchema = makeProblemDetailsSchema(
  symmyRouteNotFoundPayload._tag,
  symmyRouteNotFoundPayload.status,
);

export const symmyRouteNotFoundProblem: typeof SymmyRouteNotFoundProblemSchema.Type = symmyRouteNotFoundPayload;

export class SymmyDefectBoundary extends HttpApiMiddleware.Service<SymmyDefectBoundary>()(
  '@app/shell-super-app/api/symmy/defect-boundary/SymmyDefectBoundary',
  { error: [GatewayInternalProblemSchema, SymmyRouteNotFoundProblemSchema] },
) {}

export const symmyInternalProblem = GatewayInternalProblemSchema.make({
  detail: 'The integration request could not be completed.',
  status: GatewayInternalProblemSchema.fields.status.literal,
  title: 'Integration request failed',
  type: 'https://ontos.dev/problems/gateway-internal',
});
