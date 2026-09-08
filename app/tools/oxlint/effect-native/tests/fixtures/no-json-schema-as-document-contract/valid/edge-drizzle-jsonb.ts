// Blessed by the audit ("Drizzle JSONB correctly"): a jsonb column really is shape-free, and the
// `typeof Schema.Json` here is a column type argument, not a document contract.
import { Schema } from 'effect';

const jsonb = (name: string) => ({ $type: <T,>(): { readonly name: string } => ({ name }) });

export const auditEvidenceColumn = jsonb('audit_evidence').$type<
  Schema.Schema.Type<typeof Schema.Json>
>();

export const withEvidence = (
  evidence: Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>,
): number => Object.keys(evidence).length;
