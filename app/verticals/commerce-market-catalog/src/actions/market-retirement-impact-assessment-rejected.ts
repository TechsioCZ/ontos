import { Schema } from 'effect';

export class MarketRetirementImpactAssessmentRejected extends Schema.TaggedError<MarketRetirementImpactAssessmentRejected>()(
  'MarketRetirementImpactAssessmentRejected',
  {
    code: Schema.Literal('market_retirement_impact_assessment_rejected'),
    reason: Schema.String,
  },
) {}
