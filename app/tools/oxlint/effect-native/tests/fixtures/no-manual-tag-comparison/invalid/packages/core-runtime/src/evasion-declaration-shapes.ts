// expect-count: 9
interface Failure {
  readonly _tag: string;
}

/** Class bodies, static blocks, accessors and computed keys all contain ordinary expressions. */
export class Classifier {
  static known = false;
  static {
    Classifier.known = ({ _tag: "none" } as Failure)._tag === "ActionCollectorError";
  }
  #last: Failure = { _tag: "none" };
  get isFailed(): boolean {
    return this.#last._tag === "ActionHandlerExecutionError";
  }
  set latest(next: Failure) {
    this.#last = next._tag !== "ActionInvocationPersistenceError" ? next : this.#last;
  }
  classify(error: Failure = { _tag: "none" }): string {
    return error._tag === "OutboxPollerConfigError" ? "config" : "other";
  }
  static isTransaction = (error: Failure): boolean => error._tag === "ActionTransactionError";
}

/** Generators and async generators. */
export function* tags(errors: readonly Failure[]): Generator<string> {
  for (const error of errors) if (error._tag === "AresSubjectThrottled") yield error._tag;
}

export async function* stream(errors: AsyncIterable<Failure>): AsyncGenerator<string> {
  for await (const error of errors) {
    if (error._tag !== "AresSubjectTimeout") yield "kept";
  }
}

/** Loop heads and labelled statements. */
export const scan = (errors: readonly Failure[]): number => {
  let index = 0;
  outer: while (errors[index]?._tag === "ContactsUnavailableProblem") {
    index += 1;
    if (index > 10) break outer;
  }
  do {
    index -= 1;
  } while (errors[index]?.["_tag"] === "ContactsCustomerNotFound");
  return index;
};
