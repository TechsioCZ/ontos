// expect-count: 6
import { Match } from "effect";

interface Failure {
  readonly _tag: string;
}

/** JSX attributes, expression containers and fragments are ordinary expression positions. */
export function Panel({ error }: { readonly error: Failure }) {
  return (
    <>
      <section data-unavailable={error._tag === "ContactsUnavailableProblem"}>
        {error._tag !== "ContactsCustomerNotFound" ? <b>{error._tag}</b> : null}
        {"_tag" in error && <em>tagged</em>}
        {error["_tag"] === "ContactsGatewayProblem" && <i>gateway</i>}
      </section>
    </>
  );
}

/** A generic arrow in TSX still needs its comparison reported. */
export const firstContacts = <T extends Failure,>(items: readonly T[]): T | undefined =>
  items.find((item) => item._tag.startsWith("Contacts"));

export const matched = (error: Failure) =>
  Match.value(error).pipe(
    Match.whenOr((candidate: Failure) => candidate?._tag === "AresSubjectThrottled", () => "throttled"),
    Match.orElse(() => "other"),
  );
