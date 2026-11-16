import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { hasClosedNativeGlobalConstructor, hasClosedNativeObjectNamespace } from '../scoped-proof-custody.mts';

it('distinguishes static keys and erased types from ambient namespace references', () => {
  for (const [source, expected] of [
    ['const options={global:true};', true],
    ['const options={global:record.global};', true],
    ['class Options {global(){return true;}readonly self=true;}', true],
    ['type Fn=Function;interface Options {global:Fn;}const options={global:true};', true],
    ['const options={global:true};const captured=global;', false],
    ['const options={global};', false],
    ['const options={[global]:true};', false],
    ['const options={global:global};', false],
    ['const options={global:globalThis};', false],
    ['const options={global:Reflect};', false],
    ['const options={global:Function};', false],
  ] as const) {
    const parsed = parseSync('native-custody.ts', `${source}const values=new Set();Object.freeze(values);`);
    expect(parsed.errors, source).toEqual([]);
    expect(hasClosedNativeGlobalConstructor(parsed.program, 'Set'), source).toBe(expected);
    expect(hasClosedNativeObjectNamespace(parsed.program), source).toBe(expected);
  }
});
