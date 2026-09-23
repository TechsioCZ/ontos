import { Schema } from 'effect';

import { CatalogExternalSourceRecordRefSchema } from '../../shared/domain/external-identifier-boundary.ts';

export class ExternalCorrelationMissingLink extends Schema.TaggedError<ExternalCorrelationMissingLink>()(
  'ExternalCorrelationMissingLink',
  { sourceRecord: CatalogExternalSourceRecordRefSchema },
) {}
