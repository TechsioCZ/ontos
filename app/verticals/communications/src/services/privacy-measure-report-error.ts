import { Schema } from 'effect';

export class PrivacyMeasureReportError extends Schema.TaggedError<PrivacyMeasureReportError>()(
  'PrivacyMeasureReportError',
  {
    code: Schema.Literals([
      'privacy_measure_context_invalid',
      'privacy_measure_handoff_conflict',
      'privacy_measure_report_conflict',
      'privacy_measure_report_unavailable',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
