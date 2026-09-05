import { Effect, Schedule } from 'effect';

declare const policy: Schedule.Schedule<number>;
declare const Timer: { readonly Root: () => JSX.Element };

type Wait = typeof Effect.sleep;

export const view = () => <Timer.Root />;
export const describe = (wait: Wait): string => `${String(policy)}${String(wait.name)}`;
