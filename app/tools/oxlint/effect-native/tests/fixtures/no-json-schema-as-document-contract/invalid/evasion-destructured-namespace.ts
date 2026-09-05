// Capturing members of the Effect `Schema` namespace in local bindings hides both the codec entry
// point and `Json` from a member-expression-only matcher. Same A7 document contract as
// `api/modules/deployment-allowlist.ts`, written with destructuring / a codec alias.
import { Schema } from 'effect';

const { decodeUnknownSync, Json, Record: JsonRecord, String: JsonKey } = Schema;
const decodeAnyJson = Schema.decodeUnknownSync;

export const DeploymentAllowlistDocument = JsonRecord(JsonKey, Json);
export const decodeDeploymentAllowlist = decodeUnknownSync(DeploymentAllowlistDocument);
export const decodeReadinessEvidence = decodeAnyJson(Schema.Json);
