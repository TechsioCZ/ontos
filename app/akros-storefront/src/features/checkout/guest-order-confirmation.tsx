"use client";
import { useSyncExternalStore } from "react";
import StoreLink from "@/components/store-link";
import { LiveOrderStatus } from "./live-order-status";
import { OrderEmailStatus } from "./order-email-status";
import { useDictionary } from "@/ontos/market-context";

/** The last guest order of this browser tab; a guest has no account to read the receipt from. */
export const guestOrderKey = "sf-guest-order";

export interface GuestOrderReceipt {
  orderId: string;
  orderNumber: string;
  clientRequestId: string;
  email: string;
}

function parseGuestOrder(value: string | null): GuestOrderReceipt | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const { orderId, orderNumber, clientRequestId, email } = parsed as Record<string, unknown>;
    return typeof orderId === "string" &&
      typeof orderNumber === "string" &&
      typeof clientRequestId === "string" &&
      typeof email === "string"
      ? { orderId, orderNumber, clientRequestId, email }
      : null;
  } catch {
    return null;
  }
}

function readStoredGuestOrder() {
  try {
    return window.sessionStorage.getItem(guestOrderKey);
  } catch {
    return null;
  }
}

const subscribe = () => () => {};

export function GuestOrderConfirmation({ orderId }: { orderId: string }) {
  const copy = useDictionary().checkout.placed;
  const stored = useSyncExternalStore(subscribe, readStoredGuestOrder, () => undefined);
  if (stored === undefined) return <output>{copy.loading}</output>;
  const order = parseGuestOrder(stored);
  if (!order || order.orderId !== orderId)
    return (
      <section data-sf-checkout className="mx-auto grid max-w-5xl gap-4 py-8">
        <h1 className="text-lg font-bold">{copy.unavailableTitle}</h1>
        <p>{copy.unavailableText}</p>
        <StoreLink className="underline" href="/">
          {copy.backToShop}
        </StoreLink>
      </section>
    );
  return (
    <section data-sf-checkout className="mx-auto grid max-w-5xl gap-8 py-8">
      <header className="grid gap-4">
        <h1 className="text-lg font-bold">{copy.saved(order.orderNumber)}</h1>
        <p>{copy.guestText}</p>
        <LiveOrderStatus orderId={order.orderId} clientRequestId={order.clientRequestId} />
      </header>
      <OrderEmailStatus email={order.email} orderNumber={order.orderNumber} />
      <p>
        {copy.accountPrompt}{" "}
        <StoreLink className="underline" href="/registrace">
          {copy.createAccount}
        </StoreLink>
      </p>
    </section>
  );
}
