"use client";
import { useSyncExternalStore } from "react";
import StoreLink from "@/components/store-link";
import { LiveOrderStatus } from "./live-order-status";
import { OrderEmailStatus } from "./order-email-status";

/** The last guest order of this browser tab; a guest has no account to read the receipt from. */
export const guestOrderKey = "akros-guest-order";

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
  const stored = useSyncExternalStore(subscribe, readStoredGuestOrder, () => undefined);
  if (stored === undefined) return <output>Načítám potvrzení…</output>;
  const order = parseGuestOrder(stored);
  if (!order || order.orderId !== orderId)
    return (
      <section data-akros-checkout className="mx-auto grid max-w-5xl gap-4 py-8">
        <h1 className="text-lg font-bold">Potvrzení objednávky zde není k dispozici</h1>
        <p>
          Potvrzení objednávky bez registrace se zobrazí jen v okně, ze kterého byla odeslána. Stav
          objednávky posíláme na e-mail uvedený v objednávce.
        </p>
        <StoreLink className="underline" href="/">
          Zpět do obchodu
        </StoreLink>
      </section>
    );
  return (
    <section data-akros-checkout className="mx-auto grid max-w-5xl gap-8 py-8">
      <header className="grid gap-4">
        <h1 className="text-lg font-bold">
          Objednávka č. {order.orderNumber} byla uložena do OntOS
        </h1>
        <p>
          Objednávku jsme předali obchodu k vyřízení. Objednávali jste bez registrace, potvrzení a
          změny stavu proto posíláme na e-mail. Odesláním objednávky nebyla provedena platba.
        </p>
        <LiveOrderStatus orderId={order.orderId} clientRequestId={order.clientRequestId} />
      </header>
      <OrderEmailStatus email={order.email} orderNumber={order.orderNumber} />
      <p>
        Chcete mít přehled o objednávkách na jednom místě?{" "}
        <StoreLink className="underline" href="/registrace">
          Vytvořte si zákaznický účet
        </StoreLink>
      </p>
    </section>
  );
}
