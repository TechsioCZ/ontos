// expect-count: 4
import type { Exit } from "effect";

interface DomainError {
  readonly _tag: string;
}

export const handle = (exit: Exit.Exit<number, DomainError>, error: DomainError): string => {
  // `Failure` is an Effect ADT tag — reported by `no-raw-effect-adt-tag-check`, never here.
  if (exit._tag === "Failure") return "failed";
  if (error._tag === "ActionTransactionError") return "tx";
  if (error._tag === "ActionInvocationPersistenceError") return "persist";
  return "ok";
};

/** Tag-to-tag identity is not a case analysis; never reported. */
export const sameTag = (left: DomainError, right: DomainError): boolean => left._tag === right._tag;

export const missingTag = (error: Partial<DomainError>): boolean => error._tag === undefined;

export const templated = (error: DomainError): boolean => error._tag === `ModuleStateDeniedError`;
