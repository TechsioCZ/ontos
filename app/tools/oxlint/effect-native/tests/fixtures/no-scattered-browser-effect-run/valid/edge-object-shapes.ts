// Domain objects whose members happen to be spelled like Effect runners: no report.
const Effect = { runPromise: (job: string) => job };

export class JobQueue {
  runPromise(job: string): string {
    return job;
  }

  drain(): string {
    return this.runPromise('job');
  }
}

export const dispatch = {
  queryFn: () => new JobQueue().runPromise('job'),
  runSync: (job: string) => job,
};

export const started = Effect.runPromise('job');
