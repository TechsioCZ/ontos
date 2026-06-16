// @effect-diagnostics globalConsole:off
import { createUnit, runEffectRequest } from '../effect/properties-client';

const createUnitFromClick = () => {
  console.log('[properties-ui] Create Unit clicked');
  void runEffectRequest(createUnit());
};

export const CreateUnitButton = () => (
  <button
    className="properties:rounded-full properties:bg-stone-950 properties:px-4 properties:py-2 properties:text-sm properties:font-bold properties:text-white"
    onClick={createUnitFromClick}
    type="button"
  >
    Create Unit
  </button>
);
