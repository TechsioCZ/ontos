import assert from 'node:assert/strict';
import test from 'node:test';
import { Result } from 'effect';
import { readGeneratedSlotEntries } from '../scaffolding/shared.mts';

const start = '// slot:start';
const end = '// slot:end';
const readEntries = (body: string): readonly string[] =>
  readGeneratedSlotEntries(`${start}\n${body}\n${end}`, start, end);

void test('fluent slots split only outer calls, retaining nested multiline fluent chains', () => {
  const nested = `.addHttpApi(
  FirstApi
    .add(Group.make('nested'))
    .pipe(identity),
)`;
  assert.deepEqual(readEntries(`${nested}\n.addHttpApi(SecondApi)`), [
    nested,
    '.addHttpApi(SecondApi)',
  ]);
});

void test('slot delimiters inside strings and comments do not terminate entries', () => {
  const first = "first: { value: 'a,;.[({', /* ; } ] ) */ nested: [1, 2] },";
  const second = 'second: call(`comma, semicolon;`, "escaped\\\";"),';
  assert.deepEqual(readEntries(`${first}\n${second}`), [first, second]);
});

void test('line comments protect fluent-looking text until the newline', () => {
  const first = '.addHttpApi(\n  FirstApi // .addHttpApi(FakeApi);\n)';
  assert.deepEqual(readEntries(`${first}\n.addHttpApi(SecondApi)`), [
    first,
    '.addHttpApi(SecondApi)',
  ]);
});

void test('empty generated slots remain empty', () => {
  assert.deepEqual(readEntries('   \n'), []);
});

for (const source of ['.addHttpApi(FirstApi', 'first: "open,', 'first: /* open', 'first: ] ,']) {
  void test(`incomplete or unbalanced generated slot fails closed: ${source}`, () => {
    assert.ok(Result.isFailure(Result.try(() => readEntries(source))));
  });
}
