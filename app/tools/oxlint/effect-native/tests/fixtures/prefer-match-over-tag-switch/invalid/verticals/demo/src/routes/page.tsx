// expect-count: 3
import type { ReactElement } from 'react';

type PageState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly rows: readonly string[] }
  | { readonly state: 'failed'; readonly outcome: 'forbidden' | 'unavailable' };

declare const Spinner: () => ReactElement;
declare const View: (props: { readonly rows: readonly string[] }) => ReactElement;
declare const Denied: () => ReactElement;
declare const Offline: () => ReactElement;

/** B5: a closed UI vocabulary re-declared and dispatched by hand. */
export function Page(props: { readonly state: PageState }): ReactElement {
  switch (props.state.state) {
    case 'loading': {
      return <Spinner />;
    }
    case 'ready': {
      return <View rows={props.state.rows} />;
    }
    case 'failed': {
      return <Denied />;
    }
  }
}

/** A4: frontend reclassification after the typed union was erased. */
export function FailureView(props: { readonly outcome: 'forbidden' | 'unavailable' }): ReactElement {
  switch (props.outcome) {
    case 'forbidden': {
      return <Denied />;
    }
    case 'unavailable': {
      return <Offline />;
    }
  }
}

/** A template literal case with no interpolation is still a string literal case. */
export function ModeView(props: { readonly mode: string }): ReactElement {
  switch (props.mode) {
    case `compact`: {
      return <Spinner />;
    }
    case `full`: {
      return <Offline />;
    }
    default: {
      return <Denied />;
    }
  }
}
