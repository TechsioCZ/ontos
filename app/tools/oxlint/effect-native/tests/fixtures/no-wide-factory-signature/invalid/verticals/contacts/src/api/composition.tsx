// expect-count: 3
import * as Fx from 'effect/Effect';

/** B4 option bag: collaborators arrive in a hand-rolled `Dependencies` record, body is Effect code. */
export const makeShellComposition = (dependencies: ShellCompositionDependencies) => ({
  compose: (input: unknown) => Fx.gen(function* () {
    return { dependencies, input };
  }),
});

/** Same shape through a `.pipe(` chain instead of `Effect.gen`. */
export const createContactsClient = (options: ContactsClientOptions) =>
  Fx.succeed(options).pipe(Fx.map((value) => value));

export class ContactsGateway {
  /** Positional wiring on a class method. */
  createReadHandler(descriptor: unknown, handler: unknown, resolver: unknown) {
    return { descriptor, handler, resolver };
  }

  /** Allowed: within the limit, no option bag. */
  createReadKey(descriptor: string, owner: string) {
    return `${descriptor}:${owner}`;
  }
}

/** Allowed: a pure value bag with no Effect body is a data constructor, not hidden wiring. */
export const createPoolConfig = (options: ContactsPoolOptions) => ({ max: options.max ?? 10 });

export const ContactsPanel = (): JSX.Element => <section data-testid="contacts">contacts</section>;
