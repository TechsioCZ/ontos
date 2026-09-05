import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;
declare const dec: (value: unknown) => (target: unknown, context: unknown) => void;
declare const tag: (strings: TemplateStringsArray, ...values: unknown[]) => string;

const identity = <A,>(value: A): A => value;

class Pathological<A> {
  #orDie = 1;
  static readonly kind = 'orDie' as const;
  @dec('orDie')
  accessor label = 'orDie';
  static {
    void Pathological.kind;
  }
  async *walk(): AsyncGenerator<number> {
    yield this.#orDie;
  }
  read(): number {
    return this.#orDie;
  }
}

export const nested = identity(Base).pipe(Layer.provide(identity(Base)));
export const tagged = tag`orDie ${Pathological.kind}`;
export const optional = (undefined as unknown as { orDie?: () => void })?.orDie?.();
export const satisfied = { orDie: 1 } satisfies { orDie: number };

export const Element = () => (
  <>
    <div data-or-die="orDie" aria-label={Pathological.kind}>
      {tagged}
      {String(optional)}
      {String(satisfied.orDie)}
    </div>
  </>
);
