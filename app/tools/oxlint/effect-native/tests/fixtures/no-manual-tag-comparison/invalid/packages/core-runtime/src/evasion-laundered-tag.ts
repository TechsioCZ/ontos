// expect-count: 12
// Evasion probe: the discriminant reached through every spelling that is not `x._tag === '...'`.
// Each one is the same hand-written case analysis with an extra hop, so each one reports once.
interface Failure {
  readonly _tag: string;
  readonly reason: { readonly _tag: string };
}

const TAG_KEY = "_tag";
const CONTACTS = /^Contacts/u;
const HANDLERS: Record<string, () => string> = { ContactsUnavailableProblem: () => "unavailable" };
const KNOWN_TAGS = ["ContactsUnavailableProblem", "ContactsCustomerNotFound"];

/** An indirect computed key is still the `_tag` key. */
export const viaConstKey = (error: Failure): boolean => error[TAG_KEY] === "ContactsGatewayProblem";

/** So is a concatenated one. */
export const viaConcatenatedKey = (error: Failure): boolean => error["_" + "tag"] === "ContactsTimeoutProblem";

/** `String()` laundering does not stop the value from being the tag. */
export const viaStringWrapper = (error: Failure): boolean => String(error._tag) === "ContactsRequestInvalidProblem";

export const viaStringWrapperProbe = (error: Failure): boolean => String(error._tag).startsWith("Contacts");

/** String surgery is prefix matching with extra steps. */
export const viaSlice = (error: Failure): boolean => error._tag.slice(0, 8) === "Contacts";

export const viaCaseFold = (error: Failure): boolean => error._tag.toLowerCase() === "contactsgatewayproblem";

/** Equality without an equality operator. */
export const viaObjectIs = (error: Failure): boolean => Object.is(error._tag, "ContactsCustomerNotFound");

/** `'_tag' in error` by another name. */
export const viaHasOwn = (error: object): boolean => Object.hasOwn(error, "_tag");

export const viaReflectHas = (error: object): boolean => Reflect.has(error, TAG_KEY);

/** The tag as the *argument* of a regex probe, through a const-bound pattern. */
export const viaRegexConst = (error: Failure): boolean => CONTACTS.test(error.reason._tag);

/** A hand-maintained dispatch map keyed by tag is a second copy of the vocabulary. */
export const viaDispatchMap = (error: Failure): boolean => error._tag in HANDLERS;

/** ...and so is a membership array. Only one report: the receiver is not itself a tag. */
export const viaMembershipArray = (error: Failure): boolean => KNOWN_TAGS.includes(error._tag);
