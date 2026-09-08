import type { JSX } from 'react';

function sealed(target: unknown): void {
  void target;
}

function logged(_value: unknown, _context: unknown): void {}

/** Decorators, generics, JSX, async generators, satisfies — parse-shape probe only. */
@sealed
export class ContactPanel<Props extends { readonly title: string }> {
  @logged
  accessor title: string = 'contacts';

  readonly props: Props;

  constructor(props: Props) {
    this.props = props;
  }

  async *rows(): AsyncGenerator<string> {
    yield this.props.title;
  }

  render(): JSX.Element {
    return (
      <section aria-label={this.props.title}>
        <span>{this.title}</span>
      </section>
    );
  }
}

export const config = { mode: 'panel' } satisfies { readonly mode: string };

export const Panel = <Props extends { readonly title: string }>({
  props,
}: {
  readonly props: Props;
}): JSX.Element => <div>{props.title}</div>;
