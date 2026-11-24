"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Dialog } from "@techsio/ui-kit/molecules/dialog";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import { Exit, Fiber } from "effect";
import type { Effect } from "effect";
import type { Dictionary } from "@/i18n";
import type { CustomerAddress, CustomerAddressCommand } from "@/ontos/customer-addresses";
import {
  changeCustomerAddress,
  customerAddressesForIdentity,
  readCustomerAddresses,
} from "@/ontos/customer-addresses-client";
import type {
  CustomerAddressIdentity,
  CustomerAddressesSnapshot,
} from "@/ontos/customer-addresses-client";
import { clientRuntime } from "@/ontos/client-runtime";
import { CustomerAddressForm } from "./customer-address-form";

type EditorAction =
  | { readonly operation: "add" }
  | { readonly address: CustomerAddress; readonly operation: "remove" | "update" };
type WriteEffect = ReturnType<typeof changeCustomerAddress>;
type WriteResult = Effect.Success<WriteEffect>;
type WriteFiber = Fiber.Fiber<WriteResult>;

const AddressCard = ({
  address,
  dictionary: d,
  onAction,
}: {
  address: CustomerAddress;
  dictionary: Dictionary;
  onAction?: ((action: EditorAction, trigger: HTMLButtonElement) => void) | undefined;
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
    {address.location.state === "available" && onAction !== undefined && (
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          onClick={(event) => onAction({ address, operation: "update" }, event.currentTarget)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {d.accountPage.addressEditor.edit}
        </Button>
        <Button
          aria-haspopup="dialog"
          onClick={(event) => onAction({ address, operation: "remove" }, event.currentTarget)}
          size="sm"
          type="button"
          variant="danger"
        >
          {d.accountPage.addressEditor.remove}
        </Button>
      </div>
    )}
  </article>
);

export const CustomerAddressesList = ({
  addresses,
  dictionary: d,
  onAction,
}: {
  addresses: readonly CustomerAddress[];
  dictionary: Dictionary;
  onAction?: ((action: EditorAction, trigger: HTMLButtonElement) => void) | undefined;
}) =>
  addresses.length === 0 ? (
    <p className="text-md leading-normal text-center text-fg-secondary">
      {d.accountPage.emptyAddresses}
    </p>
  ) : (
    <div className="flex flex-wrap gap-4">
      {addresses.map((address) => (
        <AddressCard address={address} dictionary={d} key={address.id} onAction={onAction} />
      ))}
    </div>
  );

const AddressBookEditor = ({
  addresses,
  dictionary: d,
  refresh,
}: {
  addresses: readonly CustomerAddress[];
  dictionary: Dictionary;
  refresh: () => void;
}) => {
  const [action, setAction] = useState<EditorAction | null>(null);
  const [failure, setFailure] = useState<Exclude<WriteResult, "saved"> | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<CustomerAddressCommand | null>(null);
  const running = useRef<WriteFiber | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const toast = useToast();
  const labels = d.accountPage.addressEditor;
  useEffect(
    () => () => {
      const fiber = running.current;
      running.current = null;
      if (fiber !== null) {
        clientRuntime.runFork(Fiber.interrupt(fiber));
      }
    },
    [],
  );
  const open = (next: EditorAction, opener: HTMLButtonElement) => {
    if (action === null && running.current === null && attempt.current === null) {
      trigger.current = opener;
      setFailure(null);
      setAction(next);
    }
  };
  const close = () => {
    if (running.current === null && attempt.current === null) {
      setFailure(null);
      setAction(null);
      trigger.current?.focus();
    }
  };
  const save = (command: CustomerAddressCommand) => {
    if (running.current !== null) {
      return;
    }
    attempt.current = command;
    setPending(true);
    setFailure(null);
    const fiber = clientRuntime.runFork(changeCustomerAddress(command));
    running.current = fiber;
    fiber.addObserver((exit) => {
      if (running.current !== fiber) {
        return;
      }
      running.current = null;
      setPending(false);
      const result = Exit.isSuccess(exit) ? exit.value : "unconfirmed";
      if (result !== "unconfirmed") {
        attempt.current = null;
      }
      if (result === "saved") {
        toast.create({
          title: command.operation === "remove" ? labels.removed : labels.saved,
          type: "success",
        });
        setAction(null);
        refresh();
      } else {
        setFailure(result);
      }
    });
  };
  const retry = () => {
    if (attempt.current !== null) {
      save(attempt.current);
    }
  };
  const blocked = pending || failure === "unconfirmed";
  const reload = failure === "conflict" || failure === "anonymous" || failure === "forbidden";
  const error =
    failure === null
      ? null
      : {
          anonymous: d.accountPage.anonymous,
          conflict: labels.conflict,
          forbidden: d.accountPage.forbidden,
          invalid: d.accountPage.invalid,
          unavailable: labels.unavailable,
          unconfirmed: labels.unconfirmed,
        }[failure];
  let recover = null;
  if (failure === "unconfirmed") {
    recover = (
      <Button onClick={retry} size="sm" type="button" variant="secondary">
        {labels.retry}
      </Button>
    );
  } else if (reload) {
    recover = (
      <Button onClick={refresh} size="sm" type="button" variant="secondary">
        {d.accountPage.reload}
      </Button>
    );
  }
  const removal = action?.operation === "remove" ? action.address : null;
  const target = removal?.location.state === "available" ? removal.location.address : undefined;
  const remove = () => {
    if (removal !== null) {
      save({
        addressId: removal.id,
        operation: "remove",
        operationId: crypto.randomUUID(),
        revision: removal.revision,
      });
    }
  };
  return (
    <>
      <Button
        aria-disabled={action !== null}
        className="self-start sm:self-end"
        onClick={(event) => open({ operation: "add" }, event.currentTarget)}
        size="sm"
        type="button"
        variant="secondary"
      >
        {labels.add}
      </Button>
      {action !== null && action.operation !== "remove" && (
        <>
          <CustomerAddressForm
            address={action.operation === "update" ? action.address : undefined}
            dictionary={d}
            disabled={blocked || reload}
            error={error}
            onCancel={close}
            onSubmit={save}
            pending={pending}
          />
          {recover}
        </>
      )}
      <CustomerAddressesList addresses={addresses} dictionary={d} onAction={open} />
      <Dialog
        actions={
          <div className="flex flex-wrap gap-2">
            <Button disabled={blocked} onClick={close} size="sm" type="button" variant="secondary">
              {labels.cancel}
            </Button>
            {recover}
            <Button
              disabled={blocked || reload}
              isLoading={pending}
              loadingText={d.accountPage.saving}
              onClick={remove}
              size="sm"
              type="button"
              variant="danger"
            >
              {labels.remove}
            </Button>
          </div>
        }
        closeLabel={labels.cancel}
        customTrigger
        description={labels.removeQuestion}
        finalFocusEl={() => trigger.current}
        onOpenChange={({ open: next }) => {
          if (!next) {
            close();
          }
        }}
        open={removal !== null}
        role="alertdialog"
        size="sm"
        title={labels.remove}
      >
        {target !== undefined && (
          <p>
            {target.addressLine1}, {target.city}
          </p>
        )}
        {error !== null && <output className="text-fg-secondary">{error}</output>}
      </Dialog>
    </>
  );
};

export const CustomerAddressesPanel = ({
  dictionary: d,
  identity,
}: {
  dictionary: Dictionary;
  identity: CustomerAddressIdentity;
}) => {
  const [generation, setGeneration] = useState(0);
  const [snapshot, setSnapshot] = useState<
    (CustomerAddressesSnapshot & { generation: number }) | null
  >(null);
  useEffect(() => {
    let current = true;
    const fiber = clientRuntime.runFork(readCustomerAddresses());
    fiber.addObserver((exit) => {
      if (current) {
        setSnapshot({
          generation,
          identity,
          result: Exit.isSuccess(exit) ? exit.value : { state: "unavailable" },
        });
      }
    });
    return () => {
      current = false;
      clientRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [identity, generation]);
  const state = customerAddressesForIdentity(
    snapshot?.generation === generation ? snapshot : null,
    identity,
  );
  const refresh = () => {
    setGeneration((value) => value + 1);
  };
  let body;
  if (state.state === "ready") {
    body = <AddressBookEditor addresses={state.addresses} dictionary={d} refresh={refresh} />;
  } else {
    let message = d.accountPage.addressUnavailable;
    if (state.state === "loading") {
      message = d.accountPage.loading;
    } else if (state.state === "anonymous") {
      message = d.accountPage.anonymous;
    } else if (state.state === "forbidden") {
      message = d.accountPage.forbidden;
    }
    body = (
      <div className="flex flex-col items-start gap-2">
        <output aria-live="polite">{message}</output>
        {state.state === "unavailable" && (
          <Button onClick={refresh} size="sm" type="button" variant="secondary">
            {d.accountPage.reload}
          </Button>
        )}
      </div>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg leading-normal font-semibold">{d.accountPage.addresses}</h2>
      {body}
    </section>
  );
};
