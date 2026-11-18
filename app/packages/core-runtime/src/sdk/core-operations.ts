/**
 * `@app/core-runtime/sdk/core`: Core's own operations, referenced exactly like a vertical's. A module
 * calls them through the same `call`, covered by a requirement in its own manifest whose
 * `provider.moduleId` is the Core module (such a requirement declares no `callers`). Core runs them
 * in-process with the execution's own principal, under each operation's own access decision and field
 * groups.
 *
 * Schemas and data only, never a server registration: the read that answers each operation lives with
 * its domain and uses these schemas, and Core pairs the two in `coreOperationRegistrations`
 * (`modules/module-operation-execution.ts`).
 */
import { Schema } from 'effect';

import { LegalEntityRefSchema } from '../resources/legal-entity.ts';
import { CoreOperationRouteSchema } from './index.ts';
import type { CallSchema, OperationProvider, OperationRef } from './index.ts';

const coreOperation = <RequestSchema extends CallSchema, ResponseSchema extends CallSchema>(input: {
  readonly provider: OperationProvider;
  readonly request: RequestSchema;
  readonly response: ResponseSchema;
}): OperationRef<RequestSchema, ResponseSchema> =>
  Object.freeze({
    kind: 'read' as const,
    provider: Object.freeze({ ...input.provider }),
    request: input.request,
    response: input.response,
    route: CoreOperationRouteSchema.make({}),
  });

export const LegalEntityDetailRequestSchema = Schema.Struct({ legalEntityRef: LegalEntityRefSchema });
export const LegalEntityDetailResponseSchema = Schema.Struct({
  legalEntityRef: LegalEntityRefSchema,
  // Governed by the personal-data field group (O17, O84): a caller without the field grant receives
  // the identity and status without the sole-trader name.
  legalName: Schema.optionalKey(Schema.String),
  status: Schema.Literals(['active', 'suspended', 'archived']),
});

export const coreOperations = Object.freeze({
  legalEntityDetail: coreOperation({
    provider: { entrypointKey: 'core.identity.api.legal-entity-detail', moduleId: 'core.identity', schemaVersion: '1' },
    request: LegalEntityDetailRequestSchema,
    response: LegalEntityDetailResponseSchema,
  }),
});

export type CoreOperations = typeof coreOperations;
