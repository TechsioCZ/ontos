import { Schema } from 'effect';
import { MarketRetirementAbortedSettlementSchema } from './market-retirement-impact.ts';

export class MarketRetirementImpactAssessmentRejected extends Schema.TaggedError<MarketRetirementImpactAssessmentRejected>()(
  'MarketRetirementImpactAssessmentRejected',
  {
    code: Schema.Literal('market_retirement_impact_assessment_rejected'),
    reason: Schema.String,
    retirementSettlement: Schema.optionalKey(MarketRetirementAbortedSettlementSchema),
  },
) {}
