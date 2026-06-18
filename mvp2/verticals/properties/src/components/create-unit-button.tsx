// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalConsole:off
import { useState } from "react";
import { createUnit, runEffectRequest } from "../effect/properties-client";

const errorMessage = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "cause" in error &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  "message" in error.cause &&
  typeof error.cause.message === "string"
    ? error.cause.message
    : "Create Unit failed.";

const createUnitFromClick = async (setStatus: (status: string) => void) => {
  const idempotencyKey = crypto.randomUUID();
  const unitName = "xNew unitx";

  console.log("[properties-ui] Create Unit clicked");
  try {
    await runEffectRequest(createUnit({ idempotencyKey, unitName }));
    setStatus("Unit created.");
  } catch (error) {
    setStatus(errorMessage(error));
  }
};

export const CreateUnitButton = () => {
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div className="properties:flex properties:flex-col properties:items-start properties:gap-2">
      <button
        className="properties:rounded-full properties:bg-stone-950 properties:px-4 properties:py-2 properties:text-sm properties:font-bold properties:text-white"
        onClick={() => void createUnitFromClick(setStatus)}
        type="button"
      >
        Create Unit
      </button>
      {status === null ? null : (
        <p className="properties:text-sm properties:font-medium properties:text-stone-700">
          {status}
        </p>
      )}
    </div>
  );
};
