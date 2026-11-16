import { defineScopedRoutine } from '@app/core-runtime';
import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { Context, Effect, Option, Schema } from 'effect';
import {
  SymmyJobLifecycleMetadataSchema,
  SymmyJobRetentionResultSchema,
} from '../../shared/domain/symmy-job-retention.ts';
import type {
  SymmyJobLifecycleMetadata,
  SymmyJobRetentionAuthority,
  SymmyJobRetentionPolicy,
  SymmyJobRetentionResult,
} from '../../shared/domain/symmy-job-retention.ts';
import { SymmyJobLifecycleStoreError } from './symmy-job-notification-store.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(new SymmyJobLifecycleStoreError({ code: 'lifecycle_store_unavailable' }), 'cause', {
    enumerable: false,
    value: cause,
  });
const base = { ownerModuleKey: 'integration.symmy', schema: 'symmy_integration' } as const;
const metadata = defineScopedRoutine({
  ...base,
  name: 'read_symmy_job_lifecycle',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ metadata: Schema.toEncoded(SymmyJobLifecycleMetadataSchema) }),
  routineKey: 'symmy-job.read-lifecycle',
});
const syncMetadata = defineScopedRoutine({
  ...base,
  name: 'read_symmy_sync_lifecycle',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ metadata: Schema.toEncoded(SymmyJobLifecycleMetadataSchema) }),
  routineKey: 'symmy-job.read-sync-lifecycle',
});
const syncPurge = defineScopedRoutine({
  ...base,
  name: 'purge_symmy_sync_intents',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ status: SymmyJobRetentionResultSchema }),
  routineKey: 'symmy-job.purge-sync-intents',
});
const purge = defineScopedRoutine({
  ...base,
  name: 'purge_symmy_job_intents',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ status: SymmyJobRetentionResultSchema }),
  routineKey: 'symmy-job.purge-intents',
});
export interface SymmyJobRetentionStoreService {
  readonly load: (
    jobId: string,
    kind?: 'JOB' | 'SYNC',
  ) => Effect.Effect<Option.Option<SymmyJobLifecycleMetadata>, SymmyJobLifecycleStoreError>;
  readonly purge: (input: {
    readonly authority: SymmyJobRetentionAuthority;
    readonly jobId: string;
    readonly kind?: 'JOB' | 'SYNC';
    readonly policy: SymmyJobRetentionPolicy;
  }) => Effect.Effect<SymmyJobRetentionResult, SymmyJobLifecycleStoreError>;
}
export class SymmyJobRetentionStore extends Context.Service<SymmyJobRetentionStore, SymmyJobRetentionStoreService>()(
  '@app/symmy-integration/services/symmy-job-retention-store/SymmyJobRetentionStore',
) {}
export const symmyJobRetentionStore = (transaction: ScopedRoutineInvoker): SymmyJobRetentionStoreService =>
  SymmyJobRetentionStore.of({
    load: Effect.fn('SymmyJobRetentionStore.load')(function* load(jobId: string, kind: 'JOB' | 'SYNC' = 'JOB') {
      const [row] = yield* transaction
        .invoke(kind === 'SYNC' ? syncMetadata : metadata, [jobId])
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return Option.none();
      }
      return yield* Schema.decodeUnknownEffect(SymmyJobLifecycleMetadataSchema)(row.metadata).pipe(
        Effect.map(Option.some),
        Effect.mapError(unavailable),
      );
    }),
    purge: Effect.fn('SymmyJobRetentionStore.purge')(function* purgeIntents(input: {
      readonly authority: SymmyJobRetentionAuthority;
      readonly jobId: string;
      readonly kind?: 'JOB' | 'SYNC';
      readonly policy: SymmyJobRetentionPolicy;
    }) {
      const [row] = yield* transaction
        .invoke(input.kind === 'SYNC' ? syncPurge : purge, [
          input.jobId,
          {
            governanceLegalEntityId: input.policy.governanceLegalEntityId,
            policyId: input.policy.policyId,
            retentionMs: input.policy.retentionMs,
            revision: input.policy.revision,
            routeId: input.policy.routeId,
            targetLegalEntityId: Option.getOrNull(input.policy.targetLegalEntityId),
          },
          input.authority,
        ])
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* unavailable();
      }
      return row.status;
    }),
  });
