import { Schema } from 'effect';

/** Market owner routines could not be reached or returned an undecodable outcome; the caller may retry. */
export class MarketAdministrationPersistenceUnavailable extends Schema.TaggedError<MarketAdministrationPersistenceUnavailable>()(
  'MarketAdministrationPersistenceUnavailable',
  {
    code: Schema.Literal('market_administration_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
