// expect-count: 1
import { Schema } from 'effect';

class Box {
  #id = 'x';
  get id(): string {
    return this.#id;
  }
}

const tag = (strings: TemplateStringsArray, ...values: readonly unknown[]): string =>
  `${strings.join('|')}${values.length}`;

export const legacy = tag`a${1}b`;

outer: for (const _entry of [] as readonly string[]) {
  break outer;
}

try {
  JSON.parse('{}');
} catch {
  /* optional catch binding */
}

export const ready = await Promise.resolve(new Box().id);

export const RowSchema = Schema.Struct({ tenantId: Schema.String });

export const El = (): unknown => (
  <>
    <span>{legacy}</span>
    {ready}
  </>
);
