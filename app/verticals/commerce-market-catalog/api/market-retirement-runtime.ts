import { ActionPermissionCheckError } from '@app/core-runtime';
import { MarketRetirementImpactAssessmentUnavailable } from '../src/actions/market-retirement-impact-assessment-unavailable.ts';

export const retirementUnavailable = (cause?: unknown) => {
  const failure = new MarketRetirementImpactAssessmentUnavailable({
    code: 'market_retirement_impact_assessment_unavailable',
    reason: 'Original Market retirement settlement remains pending or unverifiable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
export const retirementPreflightUnavailable = () =>
  new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'The owner retirement preflight could not complete',
  });
