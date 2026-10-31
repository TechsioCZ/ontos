import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { noReflectGetRule } from '../../anti-slop/rules/no-reflect-get.ts';
import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleCode = 'anti-slop(no-reflect-get)';

it('accepts only unchanged native Proxy get-trap arguments in their original order', () => {
  withTemporaryWorkspace((directory) => {
    const valid = {
      'arrow.ts': 'new Proxy({}, { get: (object, property, proxy) => Reflect.get(object, property, proxy) });',
      'computed.ts':
        'new Proxy({}, { ["get"]: function(target, key, receiver) { return Reflect["get"](target, key, receiver); } });',
      'intercept.ts':
        'new Proxy({}, { get: (target, key, receiver) => { if (key === "private") return undefined; const value = Reflect.get(target, key, receiver); return value; } });',
      'method.ts': 'new Proxy({}, { get(target, key, receiver) { return Reflect.get(target, key, receiver); } });',
    };
    const invalid = {
      'default-parameter.ts':
        'new Proxy({}, { get(target, key, receiver = {}) { return Reflect.get(target, key, receiver); } });',
      'lookalike-handler.ts':
        'const handler = { get(target, key, receiver) { return Reflect.get(target, key, receiver); } };',
      'missing-receiver.ts': 'new Proxy({}, { get(target, key, receiver) { return Reflect.get(target, key); } });',
      'nested-callback.ts':
        'new Proxy({}, { get(target, key, receiver) { return () => Reflect.get(target, key, receiver); } });',
      'ordinary.ts': 'Reflect.get({}, "key", {});',
      'reassigned-receiver.ts':
        'new Proxy({}, { get(target, key, receiver) { receiver = {}; return Reflect.get(target, key, receiver); } });',
      'reassigned-target.ts':
        'new Proxy({}, { get(target, key, receiver) { target = {}; return Reflect.get(target, key, receiver); } });',
      'shadowed-argument.ts':
        'new Proxy({}, { get(target, key, receiver) { { const target = {}; return Reflect.get(target, key, receiver); } } });',
      'shadowed-proxy.ts':
        'const Proxy = class {}; new Proxy({}, { get(target, key, receiver) { return Reflect.get(target, key, receiver); } });',
      'wrong-key.ts':
        'new Proxy({}, { get(target, key, receiver) { return Reflect.get(target, "secret", receiver); } });',
      'wrong-receiver.ts':
        'new Proxy({}, { get(target, key, receiver) { return Reflect.get(target, key, target); } });',
      'wrong-target.ts': 'new Proxy({}, { get(target, key, receiver) { return Reflect.get({}, key, receiver); } });',
    };
    const files = Object.entries({ ...valid, ...invalid }).map(([name, source]) => {
      const filename = path.join(directory, name);
      writeFileSync(filename, source);
      return filename;
    });
    const run = runOxlint(path.join(appRoot, 'oxlint.config.ts'), files, directory);
    expect(run.numberOfFiles).toBe(files.length);
    for (const name of Object.keys(valid)) {
      expect(
        run.diagnostics.filter(({ code, filename }) => code === ruleCode && path.basename(filename) === name),
        name,
      ).toEqual([]);
    }
    for (const name of Object.keys(invalid)) {
      expect(
        run.diagnostics.filter(({ code, filename }) => code === ruleCode && path.basename(filename) === name),
        name,
      ).toHaveLength(1);
      expect(
        run.diagnostics.find(({ code, filename }) => code === ruleCode && path.basename(filename) === name)?.message,
        name,
      ).toBe(noReflectGetRule.meta?.messages?.reflectGet);
    }
  });
});

it('preserves the Proxy receiver when forwarding native getters', () => {
  const target = {
    label: 'target',
    get name() {
      return this.label;
    },
  };
  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      return key === 'label' ? 'proxy' : value;
    },
  });
  expect(proxy.name).toBe('proxy');
  expect(target.name).toBe('target');
});
