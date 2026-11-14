import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { WorkloadKeySchema } from '../../authorization/access-declaration.ts';
import { accessWorkloadBindings, principals, tenants } from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { OperationContextUnavailable } from '../../operations/errors.ts';
import { isLiveScopedOperationTransaction } from '../enforcement/workload-admission.ts';
import { readScopedSourceExecutionFence } from './source-execution-fence.ts';
import type { SourceExecutionFenceFact } from './source-execution-fence.ts';

export interface SourceAdmissionEnrollmentFact extends SourceExecutionFenceFact {
  readonly bindingIncarnation: string;
  readonly workloadKey: string;
}

const unavailable = (cause?: unknown) => {
  const failure = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'The current source admission enrollment could not be established',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { value: cause });
  }
  return failure;
};

/** Current binding facts for the recorded integration, not proof that this binding was selected by its historical admission. */
export const readScopedSourceAdmissionEnrollment = Effect.fn('SourceAdmission.readCurrentEnrollment')(
  function* readScopedSourceAdmissionEnrollment(
    transaction: ScopedTransactionExecutor,
    originalAdmissionInvocationId: string,
    sourceWorkloadKey: string,
  ) {
    const key = yield* Schema.decodeUnknownEffect(WorkloadKeySchema)(sourceWorkloadKey).pipe(
      Effect.mapError(unavailable),
    );
    const admission = yield* readScopedSourceExecutionFence(transaction, originalAdmissionInvocationId);
    if (Option.isNone(admission)) {
      return Option.none<SourceAdmissionEnrollmentFact>();
    }
    const rows = yield* transaction
      .select({ bindingIncarnation: accessWorkloadBindings.incarnation })
      .from(accessWorkloadBindings)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, accessWorkloadBindings.tenantId),
          eq(principals.principalId, accessWorkloadBindings.principalId),
        ),
      )
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .where(
        and(
          eq(accessWorkloadBindings.tenantId, transaction.scope.tenantId),
          eq(accessWorkloadBindings.principalId, admission.value.originalPrincipalId),
          eq(accessWorkloadBindings.workloadKey, key),
          eq(accessWorkloadBindings.status, 'active'),
          eq(principals.kind, 'integration'),
          eq(principals.status, 'active'),
          eq(tenants.status, 'active'),
        ),
      )
      .limit(2)
      .pipe(Effect.mapError(unavailable));
    if (!isLiveScopedOperationTransaction(transaction) || rows.length > 1) {
      return yield* unavailable();
    }
    return Option.map(Option.fromUndefinedOr(rows[0]), (row): SourceAdmissionEnrollmentFact =>
      Object.freeze({
        ...admission.value,
        bindingIncarnation: row.bindingIncarnation,
        workloadKey: key,
      }),
    );
  },
);
