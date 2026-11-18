import { testEffectNativeRule, virtualFile } from './rule-tester.mts';

const filename = virtualFile('apps/demo/tests/unit/global-replacement.test.ts');
const replacement = (...names: readonly string[]) =>
  names.map((name) => ({ data: { name }, messageId: 'replacement' }));

testEffectNativeRule('no-global-test-replacements', {
  invalid: [
    {
      code: "Object.assign(globalThis, { 'fetch': fake }); Object.defineProperties(globalThis, { 'document': { 'value': fakeDocument } });",
      errors: replacement('fetch', 'document'),
      filename,
      name: 'noncomputed quoted keys cannot hide global replacements',
    },
    {
      code: 'let saved = globalThis.fetch; saved = fake; globalThis.fetch = saved;',
      errors: replacement('fetch'),
      filename,
      name: 'reassigned saved original is not a restoration',
    },
    {
      code: "const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch'); saved.value = fake; Object.defineProperty(globalThis, 'fetch', saved);",
      errors: replacement('fetch'),
      filename,
      name: 'mutated original descriptor is not a restoration',
    },
    {
      code: "Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } });",
      errors: replacement('document'),
      filename,
      name: 'fabricated document descriptor',
    },
    {
      code: [
        "globalThis.fetch = async () => new Response('{}');",
        'window.navigator = {} as Navigator;',
        "fetch = async () => new Response('{}');",
        "self['window'] = globalThis;",
      ].join('\n'),
      errors: replacement('fetch', 'navigator', 'fetch', 'window'),
      filename,
      name: 'assignments to global slots',
    },
    {
      code: [
        'declare const fake: typeof fetch;',
        'declare const fakeDocument: Document;',
        "Reflect.set(globalThis, 'fetch', fake);",
        'Object.assign(window, { document: fakeDocument });',
        'Object.defineProperties(globalThis, { navigator: { value: {} } });',
        "Reflect.defineProperty(global, 'window', { value: {} });",
      ].join('\n'),
      errors: replacement('fetch', 'document', 'navigator', 'window'),
      filename,
      name: 'Reflect and Object descriptor writes',
    },
    {
      code: "import { rstest } from 'effect-rstest';\nrstest.stubGlobal('fetch', async () => new Response('{}'));",
      errors: replacement('fetch'),
      filename,
      name: 'Rstest stubGlobal',
    },
    {
      code: "import * as core from '@rstest/core';\ncore.rs.stubGlobal('navigator', {});\nvi.stubGlobal(`document`, {});",
      errors: replacement('navigator', 'document'),
      filename,
      name: 'namespace and global stubGlobal',
    },
    {
      code: "import { rs } from '@rstest/core';\nrs.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));",
      errors: replacement('fetch'),
      filename,
      name: 'spy chained into a replacement',
    },
    {
      code: [
        "import { rs as runner } from 'effect-rstest';",
        "const fetchSpy = runner.spyOn(globalThis, 'fetch');",
        "fetchSpy.mockResolvedValue(new Response('{}'));",
        "runner.spyOn(window, 'navigator', 'get').mockReturnValue({} as Navigator);",
      ].join('\n'),
      errors: replacement('fetch', 'navigator'),
      filename,
      name: 'held and accessor spies replaced later',
    },
  ],
  valid: [
    {
      code: "const saved = globalThis.fetch; Object.defineProperty(globalThis, 'fetch', { 'value': saved }); Object.defineProperties(globalThis, { 'fetch': { 'value': saved } });",
      filename,
      name: 'noncomputed quoted descriptor keys preserve original restoration',
    },
    {
      code: "const saved = globalThis.fetch; Object.defineProperty(globalThis, 'fetch', { value: saved, configurable: true, writable: true }); Object.defineProperties(globalThis, { fetch: { value: saved } });",
      filename,
      name: 'restoring original value through a descriptor',
    },
    {
      code: [
        "const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');",
        'if (previousDocument === undefined) {',
        "  Reflect.deleteProperty(globalThis, 'document');",
        '} else {',
        "  Object.defineProperty(globalThis, 'document', previousDocument);",
        '}',
        'const originalFetch = globalThis.fetch;',
        'globalThis.fetch = originalFetch;',
        "Reflect.set(globalThis, 'fetch', originalFetch);",
      ].join('\n'),
      filename,
      name: 'restoring saved originals',
    },
    {
      code: [
        "document.body.innerHTML = '<main></main>';",
        "document.title = 'Orders';",
        "window.dispatchEvent(new Event('resize'));",
        "Object.defineProperty(document, Symbol.for('ontos.revision'), { configurable: true, value: 'a' });",
        "document.body.append(document.createElement('p'));",
      ].join('\n'),
      filename,
      name: 'real DOM operations',
    },
    {
      code: [
        "import { expect, rs } from '@rstest/core';",
        "const fetchSpy = rs.spyOn(globalThis, 'fetch');",
        'expect(fetchSpy).not.toHaveBeenCalled();',
      ].join('\n'),
      filename,
      name: 'observation spy on fetch',
    },
    {
      code: [
        "import { rstest } from 'effect-rstest';",
        'declare const sdkSettlement: PromiseWithResolvers<null>;',
        'interface Adapter { create(input: { model: string }): Promise<unknown> }',
        'export const delayUserCreate = (target: Adapter) => {',
        '  const create = target.create.bind(target);',
        "  rstest.spyOn(target, 'create').mockImplementation((input: { model: string }) =>",
        "    input.model === 'user' ? sdkSettlement.promise.then(() => create(input)) : create(input),",
        '  );',
        '};',
      ].join('\n'),
      filename: virtualFile('apps/shell-super-app/tests/integration/stage-accounts-bootstrap.test.ts'),
      name: 'faithful scheduling instrumentation of an injected adapter',
    },
    {
      code: [
        'declare const app: { handler(request: Request): Promise<Response> };',
        'const fetch: typeof globalThis.fetch = (input, init) => app.handler(new Request(input, init));',
        "export const client = { fetch, origin: 'https://example.test' };",
        'export function install(window: { fetch?: unknown }) { window.fetch = fetch; }',
      ].join('\n'),
      filename,
      name: 'injected fetch seams and shadowed global names',
    },
    {
      code: [
        "Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://shell.example' } });",
        "const name: string = 'document';",
        'Object.defineProperty(globalThis, name, { value: {} });',
      ].join('\n'),
      filename,
      name: 'globals outside the protected set and computed names',
    },
    {
      code: "Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });",
      filename: virtualFile('apps/demo/src/document-shim.ts'),
      name: 'non-test files',
    },
    {
      code: 'const fixture = "globalThis.fetch = () => fake; Object.defineProperty(globalThis, \'document\', { value: {} });";\nexport { fixture };',
      filename,
      name: 'replacements spelled inside fixture strings',
    },
  ],
});
