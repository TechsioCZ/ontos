"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Effect, Exit, Match, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput } from "./form-controls";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import type { Dictionary } from "@/i18n";
import { CustomerProfileApi, CustomerProfileUpdateSchema } from "@/ontos/customer-profile";
import type { CustomerProfile } from "@/ontos/customer-profile";
import { clientRuntime } from "@/ontos/client-runtime";
import { profileActionFeedback } from "./action-feedback";
import type { ProfileFeedbackState } from "./action-feedback";

const profileClient = HttpApiClient.make(CustomerProfileApi);
const updateProfile = (fields: FormData, profile: CustomerProfile) =>
  Schema.decodeUnknownEffect(CustomerProfileUpdateSchema)({
    contactEmail: profile.contactEmail,
    displayName: fields.get("displayName"),
    phone: fields.get("phone"),
    version: profile.version,
  }).pipe(
    Effect.flatMap((payload) =>
      profileClient.pipe(Effect.flatMap((api) => api.customerProfile.update({ payload }))),
    ),
    Effect.timeout("65 seconds"),
  );
type Notice = ProfileFeedbackState;
const failureNotice = (error: Effect.Error<ReturnType<typeof updateProfile>>): Notice =>
  Match.value(error).pipe(
    Match.tag("SchemaError", () => "invalid" as const),
    Match.tag("CustomerProfileInvalidProblem", () => "invalid" as const),
    Match.tag("CustomerProfileAuthenticationProblem", () => "anonymous" as const),
    Match.tag("CustomerProfileForbiddenProblem", () => "forbidden" as const),
    Match.tag("CustomerProfileConflictProblem", () => "conflict" as const),
    Match.tag("CustomerProfileUnavailableProblem", () => "unavailable" as const),
    Match.orElse(() => "unconfirmed" as const),
  );

/** The native profile owns one displayName. Do not split stored names or edit login credentials. */
export const CustomerProfileForm = ({
  dictionary: d,
  disabled = false,
  profile,
}: {
  dictionary: Dictionary;
  disabled?: boolean;
  profile: CustomerProfile;
}) => {
  const id = useId();
  const router = useRouter();
  const toaster = useToast();
  const [notice, setNotice] = useState<Notice>("idle");
  const [invalid, setInvalid] = useState<readonly string[]>([]);
  const active = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pending = notice === "saving";
  const needsRead = ["conflict", "unconfirmed", "unavailable", "anonymous", "forbidden"].includes(
    notice,
  );
  const submit = (fields: FormData) => {
    if (active.current || needsRead || disabled) {
      return;
    }
    active.current = true;
    setNotice("saving");
    const program = updateProfile(fields, profile).pipe(
      Effect.match({ onFailure: failureNotice, onSuccess: (): Notice => "saved" }),
    );
    const fiber = clientRuntime.runFork(program);
    fiber.addObserver((exit) => {
      active.current = false;
      if (!mounted.current) {
        return;
      }
      const next = Exit.isSuccess(exit) ? exit.value : "unconfirmed";
      setNotice(next);
      const { successToast } = profileActionFeedback(next, d.accountPage);
      if (successToast !== null) {
        toaster.create(successToast);
      }
      if (next === "saved" || next === "anonymous") {
        router.refresh();
      }
    });
  };
  const validate = (input: HTMLInputElement) => {
    const { valid } = input.validity;
    const { name } = input;
    setInvalid((previous) =>
      valid ? previous.filter((value) => value !== name) : [...new Set([...previous, name])],
    );
  };
  const message = profileActionFeedback(notice, d.accountPage).statusText;
  return (
    <form
      action="/api/customer-profile"
      className="flex w-full min-w-0 flex-col gap-2"
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
    >
      <noscript>
        <p>{d.auth.javascriptRequired}</p>
      </noscript>
      <FormInput
        autoComplete="name"
        defaultValue={profile.displayName}
        disabled={pending || needsRead || disabled}
        id={`${id}-name`}
        label={d.accountPage.displayName}
        maxLength={300}
        name="displayName"
        onBlur={(event) => validate(event.currentTarget)}
        onInvalid={(event) => validate(event.currentTarget)}
        pattern={String.raw`.*\S.*`}
        required
        size="md"
        validateStatus={invalid.includes("displayName") ? "error" : "default"}
      />
      <FormInput
        autoComplete="tel"
        defaultValue={profile.phone}
        disabled={pending || needsRead || disabled}
        id={`${id}-phone`}
        label={d.accountPage.phone}
        maxLength={100}
        name="phone"
        onBlur={(event) => validate(event.currentTarget)}
        onInvalid={(event) => validate(event.currentTarget)}
        size="md"
        type="tel"
        validateStatus={invalid.includes("phone") ? "error" : "default"}
      />
      <FormInput
        defaultValue={profile.contactEmail}
        id={`${id}-email`}
        label={d.accountPage.email}
        name="contactEmail"
        readOnly
        size="md"
        type="email"
      />
      <div className="w-full md:w-fit">
        <Button
          block
          disabled={pending || needsRead || disabled}
          isLoading={pending}
          loadingText={d.accountPage.saving}
          size="md"
          theme="solid"
          type="submit"
          variant="secondary"
        >
          {d.accountPage.save}
        </Button>
      </div>
      {message !== "" && <output aria-live="polite">{message}</output>}
      {needsRead && (
        <div>
          <Button
            onClick={() => router.refresh()}
            size="md"
            theme="outlined"
            type="button"
            variant="secondary"
          >
            {d.accountPage.reload}
          </Button>
        </div>
      )}
    </form>
  );
};
