// Decorated class members must not crash the rule.
const logged = <This, Args extends ReadonlyArray<unknown>, Return>(
  target: (this: This, ...args: Args) => Return,
): ((this: This, ...args: Args) => Return) => target;

export class Reporter {
  @logged
  runPromise(job: string): string {
    return job;
  }
}
