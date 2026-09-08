import { Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { readGeneratedSlotEntries } from '../scaffolding/shared.mts';

const start = '// slot:start';
const end = '// slot:end';
const readEntries = (body: string): readonly string[] =>
  readGeneratedSlotEntries(`${start}\n${body}\n${end}`, start, end);

it('fluent slots split only outer calls, retaining nested multiline fluent chains', () => {
  const nested = `.addHttpApi(
  FirstApi
    .add(Group.make('nested'))
    .pipe(identity),
)`;
  expect(readEntries(`${nested}\n.addHttpApi(SecondApi)`)).toEqual([
    nested,
    '.addHttpApi(SecondApi)',
  ]);
});

it('slot delimiters inside strings and comments do not terminate entries', () => {
  const first = "first: { value: 'a,;.[({', /* ; } ] ) */ nested: [1, 2] },";
  const second = 'second: call(`comma, semicolon;`, "escaped\\\";"),';
  expect(readEntries(`${first}\n${second}`)).toEqual([first, second]);
});

it('line comments protect fluent-looking text until the newline', () => {
  const first = '.addHttpApi(\n  FirstApi // .addHttpApi(FakeApi);\n)';
  expect(readEntries(`${first}\n.addHttpApi(SecondApi)`)).toEqual([
    first,
    '.addHttpApi(SecondApi)',
  ]);
});

it('empty generated slots remain empty', () => {
  expect(readEntries('   \n')).toEqual([]);
});

for (const source of [
  '.addHttpApi(FirstApi',
  'first: "open,',
  'first: /* open',
  'first: ] ,',
]) {
  it(`incomplete or unbalanced generated slot fails closed: ${source}`, () => {
    expect(
      Result.isFailure(Result.try(() => readEntries(source)))
    ).toBeTruthy();
  });
}
