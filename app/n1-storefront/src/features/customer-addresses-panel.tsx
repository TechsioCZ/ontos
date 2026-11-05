"use client";

import { useEffect, useState } from "react";
import { Exit, Fiber } from "effect";
import type { Dictionary } from "@/i18n";
import type { CustomerAddress } from "@/ontos/customer-addresses";
import {
  customerAddressesForIdentity,
  readCustomerAddresses,
} from "@/ontos/customer-addresses-client";
import type {
  CustomerAddressIdentity,
  CustomerAddressesSnapshot,
} from "@/ontos/customer-addresses-client";
import { clientRuntime } from "@/ontos/client-runtime";

const AddressCard = ({
  address,
  dictionary: d,
}: {
  address: CustomerAddress;
  dictionary: Dictionary;
}) => (
  <article className="flex w-full flex-col gap-2 border border-border-primary bg-fill-surface p-2 md:w-[364px]">
    {address.label !== undefined && <h3 className="text-md font-medium">{address.label}</h3>}
    {address.location.state === "available" ? (
      <div className="text-sm text-fg-secondary">
        <p>{address.location.address.addressLine1}</p>
        {address.location.address.addressLine2 !== undefined && (
          <p>{address.location.address.addressLine2}</p>
        )}
        <p>
          {address.location.address.postalCode} {address.location.address.city}
        </p>
        {address.location.address.region !== undefined && <p>{address.location.address.region}</p>}
        <p>{address.location.address.countryCode}</p>
      </div>
    ) : (
      <p className="text-sm text-fg-secondary">{d.accountPage.addressUnresolved}</p>
    )}
    {(address.isBillingDefault || address.isDeliveryDefault) && (
      <div className="text-sm text-fg-secondary">
        {address.isBillingDefault && <p>{d.accountPage.billingAddress}</p>}
        {address.isDeliveryDefault && <p>{d.accountPage.deliveryAddress}</p>}
      </div>
    )}
  </article>
);

export const CustomerAddressesList = ({
  addresses,
  dictionary: d,
}: {
  addresses: readonly CustomerAddress[];
  dictionary: Dictionary;
}) =>
  addresses.length === 0 ? (
    <p>{d.accountPage.emptyAddresses}</p>
  ) : (
    <div className="flex flex-wrap gap-4">
      {addresses.map((address) => (
        <AddressCard address={address} dictionary={d} key={address.id} />
      ))}
    </div>
  );

export const CustomerAddressesPanel = ({
  dictionary: d,
  identity,
}: {
  dictionary: Dictionary;
  identity: CustomerAddressIdentity;
}) => {
  const [snapshot, setSnapshot] = useState<CustomerAddressesSnapshot | null>(null);
  useEffect(() => {
    let current = true;
    const fiber = clientRuntime.runFork(readCustomerAddresses());
    fiber.addObserver((exit) => {
      if (current) {
        setSnapshot({
          identity,
          result: Exit.isSuccess(exit) ? exit.value : { state: "unavailable" },
        });
      }
    });
    return () => {
      current = false;
      clientRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [identity]);
  const state = customerAddressesForIdentity(snapshot, identity);
  let body;
  if (state.state === "ready") {
    body = <CustomerAddressesList addresses={state.addresses} dictionary={d} />;
  } else {
    let message = d.accountPage.addressUnavailable;
    if (state.state === "loading") {
      message = d.accountPage.loading;
    } else if (state.state === "anonymous") {
      message = d.accountPage.anonymous;
    } else if (state.state === "forbidden") {
      message = d.accountPage.forbidden;
    }
    body = <output aria-live="polite">{message}</output>;
  }
  return (
    <section className="flex flex-col gap-2 px-2 pb-2">
      <h2 className="text-lg leading-normal font-semibold">{d.accountPage.addresses}</h2>
      {body}
    </section>
  );
};
