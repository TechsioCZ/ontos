// Pathological syntax that must parse without crashing the rule and must not report: JSX fragments
// and spreads, private fields, a static block, tagged templates, labels, `new.target`, decorators,
// `satisfies`/`as`, and optional chaining — none of it reads the environment.
import type { JSX } from 'react';

function logged<T extends (...args: never[]) => unknown>(target: T, _context: ClassMethodDecoratorContext): T {
  return target;
}

const tag = (parts: TemplateStringsArray, ...values: readonly unknown[]): string =>
  parts.join('') + String(values.length);

export const banner = tag`contacts ${1} panel`;

export class Panel {
  #title = 'panel';
  static #instances = 0;

  static {
    Panel.#instances = 0;
  }

  get title(): string {
    return this.#title;
  }

  set title(next: string) {
    this.#title = next;
  }

  @logged
  render(value?: { readonly nested?: { readonly label?: string } }): string {
    const label = value?.nested?.label;
    if (label === undefined) {
      throw new Error('label is required');
    }
    outer: for (const _entry of [1, 2]) {
      break outer;
    }
    return label satisfies string;
  }
}

export const Legacy = function (): void {
  if (new.target === undefined) {
    return;
  }
};

export const PanelView = (props: { readonly items: readonly number[] }): JSX.Element => (
  <>
    <section data-label={`${banner}`} {...{ id: 'panel' }}>
      {props.items.map((item) => (item > 1 ? <span key={item}>{item}</span> : null))}
    </section>
  </>
);
