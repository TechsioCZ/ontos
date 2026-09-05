// TSX stress: generic arrow, JSX attribute and text that merely mention the seam names.
import { Cause, Effect } from 'effect';

declare const Widget: (props: { readonly hasDies: boolean; readonly catchDefect?: string }) => JSX.Element;
const identity = <T,>(value: T): T => value;

declare const cause: Cause.Cause<never>;

export const pretty = Effect.logError(Cause.pretty(cause));

export const View = (): JSX.Element => (
  <section title="Effect.catchCause" data-note={`Cause.hasDies ${identity('inline')}`}>
    Cause.hasDies is only text here.
    <Widget hasDies={false} catchDefect="none" />
  </section>
);
