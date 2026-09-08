// expect-count: 4
import type { Effect } from 'effect';

const actionRegistration: unique symbol = Symbol('@app/core-runtime/actions/registration');
const actionHandler: unique symbol = Symbol('@app/core-runtime/actions/registration/handler');
const actionServiceFactory: unique symbol = Symbol(
  '@app/core-runtime/actions/registration/service-factory',
);

export type ActionHandler<Payload, Result> = (payload: Payload) => Effect.Effect<Result>;
export type ActionServiceFactory<Services> = () => Effect.Effect<Services>;

export interface ActionRegistration<Payload, Result, Services> {
  // reported: a handler hidden behind a unique-symbol slot
  readonly [actionHandler]: ActionHandler<Payload, Result>;
  // allowed: pure nominal marker (literal `true`)
  readonly [actionRegistration]: true;
  // reported: a service factory hidden behind a unique-symbol slot
  readonly [actionServiceFactory]: ActionServiceFactory<Services>;
}

export const registerAction = <Payload, Result, Services>(
  handler: ActionHandler<Payload, Result>,
  serviceFactory: ActionServiceFactory<Services>,
): ActionRegistration<Payload, Result, Services> =>
  Object.freeze({
    // reported: construction site of the same slot
    [actionHandler]: handler,
    // allowed: `true as const` marker
    [actionRegistration]: true as const,
    // reported
    [actionServiceFactory]: serviceFactory,
  });

// allowed by default (allowSameFileAccessors): the owning module opens its own private record
export const getActionHandler = <Payload, Result, Services>(
  registration: ActionRegistration<Payload, Result, Services>,
): ActionHandler<Payload, Result> => registration[actionHandler];

export const isActionRegistration = (value: object): boolean =>
  actionRegistration in value && value[actionRegistration] === true;
