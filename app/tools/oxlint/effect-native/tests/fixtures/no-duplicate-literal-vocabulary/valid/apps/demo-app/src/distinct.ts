// Distinct vocabularies, each declared once.
import { Schema } from 'effect';

export const Contract = Schema.Struct({
  auditProfile: Schema.Literals(['minimal', 'sensitive', 'standard']),
  idempotency: Schema.Literals(['optional', 'required']),
  legalEntityScope: Schema.Literals(['forbidden', 'optional', 'required']),
  credential: Schema.Literals(['api_key', 'session']),
  kind: Schema.Literals(['service', 'integration', 'system']),
});
