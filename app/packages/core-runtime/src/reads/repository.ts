import { Effect } from 'effect';
import { dataAccessEvents } from '../db/schema.ts';
import type { CoreDbExecutor } from '../db/types.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ReadEvidencePersistenceError } from './errors.ts';
import type { ReadAccessKind, ReadEvidenceCaptureMode } from './definition.ts';

export interface PersistReadEvidenceInput {
  readonly accessKind: ReadAccessKind;
  readonly captureMode: ReadEvidenceCaptureMode;
  readonly outcome: 'allowed' | 'denied' | 'failed';
  readonly outcomeCode: string;
  readonly outcomeStage: 'authz' | 'evidence' | 'execution' | 'policy';
  readonly policyKey: string;
  readonly queryHash?: string;
  readonly readKey: string;
  readonly resultCount: number;
  readonly resultFingerprintHash?: string;
  readonly resultFingerprintSchema?: string;
  readonly scope: OperationalScope;
  readonly servingModuleKey: string;
  readonly targetModuleKey?: string;
  readonly targetResourceId?: string;
  readonly targetResourceType?: string;
}

const accessKind = (kind: ReadAccessKind): 'download' | 'export' | 'list' | 'read' | 'search' =>
  kind === 'detail' || kind === 'report' ? 'read' : kind;

export const persistReadEvidence = (
  executor: CoreDbExecutor,
  input: PersistReadEvidenceInput,
): Effect.Effect<void, ReadEvidencePersistenceError> =>
  Effect.tryPromise({
    catch: () =>
      new ReadEvidencePersistenceError({
        code: 'read_evidence_persistence_failed',
        reason: 'Required read evidence could not be persisted',
      }),
    try: () =>
      executor.insert(dataAccessEvents).values({
        accessKind: accessKind(input.accessKind),
        authBindingId: input.scope.authBindingId,
        authContextRef: input.scope.authContextRef,
        authMethod: input.scope.authMethod,
        evidenceCaptureMode: input.captureMode,
        evidencePolicyKey: input.policyKey,
        impersonatedByPrincipalId: input.scope.impersonatedByPrincipalId,
        legalEntityId: input.scope.legalEntityId,
        outcome: input.outcome,
        outcomeCode: input.outcomeCode,
        outcomeStage: input.outcomeStage,
        principalId: input.scope.principalId,
        queryHash: input.queryHash,
        resultCount: input.resultCount,
        resultFingerprintHash: input.resultFingerprintHash,
        resultFingerprintSchema: input.resultFingerprintSchema,
        servingModuleKey: input.servingModuleKey,
        targetModuleKey: input.targetModuleKey,
        targetResourceId: input.targetResourceId,
        targetResourceType: input.targetResourceType,
        tenantId: input.scope.tenantId,
      }),
  }).pipe(Effect.asVoid);
