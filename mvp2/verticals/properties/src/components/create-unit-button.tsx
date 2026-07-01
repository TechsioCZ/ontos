// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalConsole:off
import { useState } from 'react';
import { createUnit, runEffectRequest } from '../effect/properties-client';
import { effectRequestFailureMessage } from '../helpers/effect-request-failure-message';

const createUnitFromClick = async (setStatus: (status: string) => void) => {
  const idempotencyKey = crypto.randomUUID();
  const unitName = 'xNew unitx';

  console.log('[properties-ui] Create Unit clicked');
  try {
    await runEffectRequest(createUnit({ idempotencyKey, unitName }));
    setStatus('Unit created.');
  } catch (error) {
    setStatus(effectRequestFailureMessage(error, 'Create Unit failed.'));
  }
};

export const CreateUnitButton = ({
  canCreateUnit = true,
}: {
  readonly canCreateUnit?: boolean | undefined;
}) => {
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div className="properties:flex properties:flex-col properties:items-start properties:gap-2">
      <button
        className="properties:rounded-full properties:bg-stone-950 properties:px-4 properties:py-2 properties:text-sm properties:font-bold properties:text-white properties:disabled:cursor-not-allowed properties:disabled:opacity-60"
        disabled={!canCreateUnit}
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
