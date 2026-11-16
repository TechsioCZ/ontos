import { Schema } from 'effect';

export class SymmyJobWorkerError extends Schema.TaggedError<SymmyJobWorkerError>()('SymmyJobWorkerError', {
  code: Schema.Literals(['symmy_job_worker_invalid', 'symmy_job_worker_unavailable', 'symmy_job_worker_blocked']),
  reason: Schema.String,
}) {}

export const symmyJobWorkerUnavailable = (cause?: unknown) => {
  const error = new SymmyJobWorkerError({
    code: 'symmy_job_worker_unavailable',
    reason: 'The original integration work cannot currently be completed.',
  });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
};
export const symmyJobWorkerInvalid = () =>
  new SymmyJobWorkerError({
    code: 'symmy_job_worker_invalid',
    reason: 'The delivery does not identify exact admitted integration work.',
  });
export const symmyJobWorkerBlocked = () =>
  new SymmyJobWorkerError({
    code: 'symmy_job_worker_blocked',
    reason: 'The original integration authority currently blocks new effects.',
  });
