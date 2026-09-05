// A local binding shadows the Effect import inside the function, so the member access is not
// Effect's `Schema`; and `JsonValue` used as an interface member / parameter type is not reported
// (only the declaring alias would be, and there is none here).
import { Schema } from 'effect';

export interface AuditEvidenceEnvelope {
  readonly evidence: Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>;
}

export const ReadinessEvidence = Schema.Struct({
  checkpoint: Schema.String,
  payload: Schema.Json,
});

export const shadowed = () => {
  const Schema = {
    Json: 'json',
    decodeUnknownSync: (_schema: string) => (value: unknown) => value,
  };
  return Schema.decodeUnknownSync(Schema.Json)({});
};

export const EvidencePanel = ({ envelope }: { readonly envelope: AuditEvidenceEnvelope }) => (
  <section>{Object.keys(envelope.evidence).length}</section>
);
