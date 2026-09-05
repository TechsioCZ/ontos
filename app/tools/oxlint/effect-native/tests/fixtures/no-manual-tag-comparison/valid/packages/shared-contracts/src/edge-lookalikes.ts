/** Keys that merely resemble the discriminant, and reads that are not comparisons. */
interface Failure {
  readonly _tag: string;
  readonly _tags?: readonly string[];
  readonly tag?: string;
}

export const nearMisses = (error: Failure, key: string): boolean =>
  error.tag === "ContactsUnavailableProblem" ||
  error._tags?.[0] === "ContactsUnavailableProblem" ||
  error["_tag2" as "tag"] === "x" ||
  error[key as "tag"] === "y" ||
  error[`_tag${key}` as "tag"] === "z";

/** Truthiness checks, plain reads and `in` on other keys. */
export const reads = (error?: Failure): string | undefined => (error?._tag ? error._tag : undefined);
export const otherKey = (value: object): boolean => "reason" in value && "_tagged" in value;

/** A private-name `in` check must not be mistaken for the `_tag` shape test. */
export class Holder {
  #brand = true;
  static has(value: object): boolean {
    return #brand in value;
  }
}

/** Comparing two discriminants is identity, not case analysis — including through computed access. */
export const same = (a: Failure, b: Failure): boolean => a._tag === b?.["_tag"];

/** Effect's own ADT tags belong to `no-raw-effect-adt-tag-check`. */
export const adt = (value: Failure): boolean => value._tag === "Some" || value._tag !== "Failure";
