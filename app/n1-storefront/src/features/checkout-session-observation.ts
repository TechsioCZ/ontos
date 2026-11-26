import type { PortalOutcome } from "@/ontos/portal";

export interface CheckoutSessionObservation {
  readonly generation: number;
  readonly identity: Extract<PortalOutcome, { state: "admitted" }> | null;
  readonly key: string;
}

/** Presentation objects may be fresh; an admitted object identifies one particular admission. */
export const observeCheckoutSession = (
  previous: CheckoutSessionObservation | null,
  { loaded, outcome, pending }: { loaded: boolean; outcome: PortalOutcome; pending: boolean },
): CheckoutSessionObservation => {
  const key = JSON.stringify([loaded, pending, outcome]);
  const identity = outcome.state === "admitted" ? outcome : null;
  if (previous !== null && previous.key === key && previous.identity === identity) {
    return previous;
  }
  return { generation: previous === null ? 0 : previous.generation + 1, identity, key };
};

/** Draft continuity is distinct from operation admission. Never equate customers by display data. */
export const sameCheckoutCustomer = (
  left: CheckoutSessionObservation["identity"],
  right: CheckoutSessionObservation["identity"],
) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.customerKey !== undefined &&
    left.customerKey === right.customerKey);
