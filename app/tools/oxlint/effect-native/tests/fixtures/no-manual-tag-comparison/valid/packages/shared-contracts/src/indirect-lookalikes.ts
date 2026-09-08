/**
 * Near-misses for the indirect / laundered detections. Resolving a binding through scope must not
 * turn "a local whose name resembles a tag" into a violation, and the shape/membership probes must
 * stay pinned to the `_tag` key.
 */
interface Failure {
  readonly _tag: string;
  readonly reason: string;
  readonly kind: string;
}

const OTHER_KEY = "reason";
const CONTACTS = /^Contacts/u;
const NOT_A_REGEX = { test: (_value: string): boolean => false };
const ADT_TAGS = ["Some", "None"];

/** A local that never held `_tag` is just a string. */
export const viaOtherProperty = (error: Failure): boolean => {
  const kind = error.kind;
  return kind === "unavailable" || kind.startsWith("Contacts");
};

/** Destructuring a different key is not destructuring the discriminant. */
export const viaOtherDestructuring = (error: Failure): boolean => {
  const { reason, kind: renamed } = error;
  return reason === "transport" && renamed !== "unavailable";
};

/** Reading, returning and re-packing a tag is fine; only narrowing is not. */
export const readTag = ({ _tag }: Failure): string => _tag;
export const repack = (error: Failure) => ({ _tag: error._tag, failureTag: error._tag });

/** An inner binding shadows the outer tag alias, so the inner comparison is not a tag comparison. */
export const shadowed = (error: Failure): ((tag: string) => boolean) => {
  const tag = error._tag;
  void tag;
  return (tag: string): boolean => tag === "ContactsUnavailableProblem";
};

/** An indirect computed key that is not `_tag`. */
export const otherComputedKey = (error: Failure): boolean => error[OTHER_KEY] === "transport";

/** Shape and membership probes aimed at other keys. */
export const hasReason = (value: object): boolean => Object.hasOwn(value, "reason") && Reflect.has(value, "kind");
export const isSameReason = (a: Failure, b: Failure): boolean => Object.is(a.reason, b.reason);
export const knownKinds = ["created", "updated"];
export const isKnownKind = (error: Failure): boolean => knownKinds.includes(error.kind);

/** Regex and string probes on something that is not the discriminant. */
export const probesOther = (error: Failure): boolean => CONTACTS.test(error.reason) || NOT_A_REGEX.test(error._tag);

/** Effect's own ADT tags stay with `no-raw-effect-adt-tag-check`, membership lists included. */
export const isAdt = (value: { readonly _tag: string }): boolean =>
  ADT_TAGS.includes(value._tag) || ["Success", "Failure"].includes(value._tag);

/** `Object.is` between two discriminants is identity, not case analysis. */
export const sameTag = (a: Failure, b: Failure): boolean => Object.is(a._tag, b._tag);

/** A shadowed `Object` global is not the shape probe. */
export const shadowedGlobal = (value: { readonly _tag: string }): boolean => {
  const Object = { hasOwn: (_target: unknown, _key: string): boolean => true };
  return Object.hasOwn(value, "_tag");
};
