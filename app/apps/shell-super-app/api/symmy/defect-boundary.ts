import { GatewayInternalProblemSchema } from '@app/shared-contracts';
import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApiMiddleware } from 'effect/http-api';

export const SymmyRouteNotFoundProblemSchema = makeProblemDetailsSchema('SymmyRouteNotFoundProblem', 404);

export const symmyRouteNotFoundProblem = SymmyRouteNotFoundProblemSchema.make({
  detail: 'The requested integration path is unavailable.',
  status: SymmyRouteNotFoundProblemSchema.fields.status.literal,
  title: 'Integration route not found',
  type: 'https://ontos.dev/problems/symmy-route-not-found',
});

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
