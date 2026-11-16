import { expect, it } from 'effect-rstest';

import { callbackReturnedExpressionStaged } from '../generated-governed-http-boundary.mts';

it('cuts a staged read callback at the first top-level semicolon, not one inside the returned expression', () => {
  const returned = 'Effect.gen(function* load() { const rows = yield* query(scope); return rows; }).pipe(Effect.orDie)';
  expect(callbackReturnedExpressionStaged(`(scope) => { const query = makeQuery(); return ${returned}; }`)).toBe(
    returned,
  );
  expect(callbackReturnedExpressionStaged(`(scope) => ${returned}`)).toBe(returned);
});

it('keeps the final top-level return and ignores nested ones', () => {
  expect(
    callbackReturnedExpressionStaged('(input) => { const inner = () => { return other; }; return finalValue; }'),
  ).toBe('finalValue');
  expect(callbackReturnedExpressionStaged('(input) => { inner(); }')).toBeUndefined();
});

it('reads the top-level arrow, not one inside a default parameter', () => {
  expect(callbackReturnedExpressionStaged('(make = () => fallback) => { return make(); }')).toBe('make()');
});
