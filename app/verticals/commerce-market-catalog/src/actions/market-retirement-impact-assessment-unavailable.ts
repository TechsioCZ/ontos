import { Schema } from 'effect';

export class MarketRetirementImpactAssessmentUnavailable extends Schema.TaggedError<MarketRetirementImpactAssessmentUnavailable>()(
  'MarketRetirementImpactAssessmentUnavailable',
  {
    code: Schema.Literal('market_retirement_impact_assessment_unavailable'),
    reason: Schema.String,
  },
) {}
