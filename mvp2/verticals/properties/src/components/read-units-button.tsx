// @effect-diagnostics asyncFunction:off globalConsole:off
import { useState } from 'react';
import { readUnits, runEffectRequest } from '../effect/properties-client';
import { effectRequestFailureMessage } from '../helpers/effect-request-failure-message';

interface ReadUnit {
  readonly createdAt: string;
  readonly name: string;
  readonly unitId: string;
}

const readUnitsFromClick = async ({
  setIsLoading,
  setStatus,
  setUnits,
}: {
  readonly setIsLoading: (isLoading: boolean) => void;
  readonly setStatus: (status: string) => void;
  readonly setUnits: (units: readonly ReadUnit[]) => void;
}) => {
  console.log('[properties-ui] Read Units clicked');
  setIsLoading(true);
  setStatus('Reading units...');

  try {
    const units = await runEffectRequest(readUnits());
    setUnits(units);
    setStatus(units.length === 0 ? 'No units found.' : `${units.length} units found.`);
  } catch (error) {
    setStatus(effectRequestFailureMessage(error, 'Read Units failed.'));
  } finally {
    setIsLoading(false);
  }
};

export const ReadUnitsButton = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [units, setUnits] = useState<readonly ReadUnit[]>([]);

  return (
    <div className="properties:flex properties:w-full properties:max-w-2xl properties:flex-col properties:items-start properties:gap-4">
      <button
        className="properties:rounded-full properties:bg-stone-950 properties:px-4 properties:py-2 properties:text-sm properties:font-bold properties:text-white disabled:properties:cursor-not-allowed disabled:properties:bg-stone-500"
        disabled={isLoading}
        onClick={() => void readUnitsFromClick({ setIsLoading, setStatus, setUnits })}
        type="button"
      >
        {isLoading ? 'Reading Units' : 'Read Units'}
      </button>
      {status === null ? null : (
        <p className="properties:text-sm properties:font-medium properties:text-stone-700">
          {status}
        </p>
      )}
      {units.length === 0 ? null : (
        <ul className="properties:w-full properties:divide-y properties:divide-stone-200 properties:rounded-lg properties:border properties:border-stone-200 properties:bg-white">
          {units.map((unit) => (
            <li className="properties:p-4" key={unit.unitId}>
              <p className="properties:text-sm properties:font-bold properties:text-stone-950">
                {unit.name}
              </p>
              <p className="properties:mt-1 properties:text-xs properties:text-stone-600">
                {unit.unitId}
              </p>
              <p className="properties:mt-1 properties:text-xs properties:text-stone-600">
                {unit.createdAt}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
