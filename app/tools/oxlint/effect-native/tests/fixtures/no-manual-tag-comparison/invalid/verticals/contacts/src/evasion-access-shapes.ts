// expect-count: 10
interface Failure {
  readonly _tag: string;
  readonly reason: Failure;
}

/** Optional chaining plus computed access still names the discriminant. */
export const optionalComputed = (error?: Failure): boolean => error?.["_tag"] === "ContactsUnavailableProblem";

/** Non-null assertion plus computed access. */
export const nonNullComputed = (error: Failure): boolean => error!["_tag"] !== "ContactsCustomerNotFound";

/** A template-literal key is still the `_tag` key. */
export const templateKey = (error: Failure): boolean => error[`_tag`] === "ContactsRequestInvalidProblem";

/** Reversed operand order. */
export const reversed = (error: Failure): boolean => "ContactsCustomerNotFound" === error._tag;

/** `as` on the receiver, template literal as the compared value. */
export const casted = (error: unknown): boolean => (error as Failure)._tag === `ContactsUnavailableProblem`;

/** `satisfies` wrapped around the tag read. */
export const satisfied = (error: Failure): boolean => (error._tag satisfies string) === "ContactsGatewayProblem";

/** Angle-bracket type assertion (TS-only syntax). */
export const asserted = (error: Failure): boolean => (<string>error._tag) === "ContactsTimeoutProblem";

/** Deep receiver chain. */
export const deep = (error: { readonly a: { readonly b: Failure } }): boolean =>
  error.a.b.reason._tag === "TransportError";

/** Call-expression receiver. */
declare function currentError(): Failure;
export const fromCall = (): boolean => currentError()._tag === "ActionAlreadyCommitted";

/** Loose inequality is the same hand-written narrowing. */
export const loose = (error: Failure): boolean => error._tag != "ActionTransactionError";
