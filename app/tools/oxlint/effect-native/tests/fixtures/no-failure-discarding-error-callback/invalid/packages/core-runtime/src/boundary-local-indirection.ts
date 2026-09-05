// expect-count: 5
import { Effect } from 'effect';
const E = Effect;
const { mapError: translate } = E;
export const first = translate(() => 'generic');
export const second = (E as typeof E)[`matchEffect`]({onSuccess: Effect.succeed, onFailure: () => Effect.succeed('gone')});
const base = () => 'generic'; const alias = base;
export const third = E.mapError(alias);
const options = { try: () => 1, ['catch']: () => 'generic' };
export const fourth = E.try(options);
export const fifth = E.mapError((error = undefined) => 'generic');
