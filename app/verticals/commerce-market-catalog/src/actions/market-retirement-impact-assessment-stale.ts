import { Schema } from 'effect';

export class MarketRetirementImpactAssessmentStale extends Schema.TaggedError<MarketRetirementImpactAssessmentStale>()(
  'MarketRetirementImpactAssessmentStale',
  {
    code: Schema.Literal('market_retirement_impact_assessment_stale'),
    reason: Schema.String,
  },
) {}
