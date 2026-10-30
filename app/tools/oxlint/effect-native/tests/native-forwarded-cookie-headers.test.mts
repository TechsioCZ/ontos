import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleName = 'no-manual-cookie-serialization';
const ruleCode = `effect-native(${ruleName})`;
const declaration = 'const headers = new Headers(response.headers);';
const forwarding = "adapted.headers.append('set-cookie', cookie);";
const cookieGetter = 'headers.getSetCookie()';
const native = `import { HttpServerResponse } from 'effect/http';
export const adapt = (response: Response) => {
  ${declaration}
  const adapted = HttpServerResponse.raw(response.body, { headers }).pipe(HttpServerResponse.toWeb);
  adapted.headers.delete('set-cookie');
  for (const cookie of headers.getSetCookie()) {
    ${forwarding}
  }
  return adapted;
};
`;

it('proves unchanged native cookie forwarding in the production adapters without allowing serialization', () => {
  withTemporaryWorkspace((directory) => {
    const productionPaths = [
      'apps/shell-super-app/api/auth/cimd-transport.workerd.ts',
      'apps/shell-super-app/api/auth/oauth-server/forward.ts',
    ];
    const cases = [
      ...productionPaths.map((filename, index) => {
        const source = readFileSync(path.join(appRoot, filename), 'utf-8');
        expect(source).not.toMatch(/(?:eslint|oxlint)-disable[^\n]*no-manual-cookie-serialization/u);
        return { name: `production-${index}`, source, valid: true };
      }),
      { name: 'native', source: native, valid: true },
      {
        name: 'unrelated-headers-key',
        source: `${native}\nconst unrelated = { Headers: 'not a constructor' };\nconsume(unrelated.Headers);`,
        valid: true,
      },
      {
        name: 'constant-header',
        source: native
          .replace('export const adapt', "const SET_COOKIE_HEADER = 'set-cookie';\nexport const adapt")
          .replaceAll("'set-cookie',", 'SET_COOKIE_HEADER,'),
        valid: true,
      },
      {
        name: 'non-cookie-header-adjustment',
        source: native.replace(declaration, `${declaration}\nheaders.delete('content-length');`),
        valid: true,
      },
      {
        name: 'aliased-effect-import',
        source: native
          .replaceAll('HttpServerResponse', 'ResponseAdapter')
          .replace('{ ResponseAdapter }', '{ HttpServerResponse as ResponseAdapter }'),
        valid: true,
      },
      {
        name: 'empty-native-response',
        source: native.replace('HttpServerResponse.raw(response.body,', 'HttpServerResponse.empty('),
        valid: true,
      },
      {
        name: 'fake-getter',
        source: native.replace(declaration, 'const headers = { getSetCookie: () => cookies };'),
        valid: false,
      },
      {
        name: 'typed-opaque-producer',
        source: native.replace(declaration, 'const headers: Headers = opaque();'),
        valid: false,
      },
      {
        name: 'response-property-not-local-copy',
        source: native.replace(cookieGetter, 'response.headers.getSetCookie()'),
        valid: false,
      },
      {
        name: 'shadowed-constructor',
        source: `const Headers = FakeHeaders;\n${native}`,
        valid: false,
      },
      {
        name: 'parameter-shadowed-constructor',
        source: native.replace('(response: Response)', '(response: Response, Headers: typeof FakeHeaders)'),
        valid: false,
      },
      { name: 'imported-constructor', source: `import { Headers } from './fake.ts';\n${native}`, valid: false },
      { name: 'reassigned-global-constructor', source: `${native}\nHeaders = FakeHeaders;`, valid: false },
      { name: 'global-object-constructor', source: `${native}\nglobalThis.Headers = FakeHeaders;`, valid: false },
      {
        name: 'computed-global-constructor',
        source: `${native}\nconst constructorKey = 'Headers';\nglobalThis[constructorKey] = FakeHeaders;`,
        valid: false,
      },
      {
        name: 'defined-global-constructor',
        source: `${native}\nObject.defineProperty(globalThis, 'Headers', { value: FakeHeaders });`,
        valid: false,
      },
      {
        name: 'assigned-global-constructor',
        source: `${native}\nObject.assign(globalThis, { Headers: FakeHeaders });`,
        valid: false,
      },
      {
        name: 'aliased-global-constructor',
        source: `${native}\nconst world = globalThis;\nworld.Headers = FakeHeaders;`,
        valid: false,
      },
      { name: 'prototype-getter', source: `${native}\nHeaders.prototype.getSetCookie = fake;`, valid: false },
      {
        name: 'computed-prototype-getter',
        source: `${native}\nHeaders['prototype']['getSetCookie'] = fake;`,
        valid: false,
      },
      {
        name: 'prototype-define-property',
        source: `${native}\nObject.defineProperty(Headers.prototype, 'getSetCookie', { value: fake });`,
        valid: false,
      },
      {
        name: 'prototype-through-other-instance',
        source: `${native}\nconst other = new Headers();\nObject.getPrototypeOf(other).getSetCookie = fake;`,
        valid: false,
      },
      {
        name: 'prototype-defined-through-other-instance',
        source: `${native}\nconst other = new Headers();\nObject.defineProperty(Object.getPrototypeOf(other), 'getSetCookie', { value: fake });`,
        valid: false,
      },
      { name: 'constructor-escape', source: `${native}\nopaque(Headers);`, valid: false },
      { name: 'constructor-alias', source: `${native}\nconst Alias = Headers;`, valid: false },
      {
        name: 'mutable-source',
        source: native.replace('const headers =', 'let headers ='),
        valid: false,
      },
      {
        name: 'reassigned-source',
        source: native.replace(declaration, `${declaration}\nheaders = opaque();`),
        valid: false,
      },
      {
        name: 'replaced-getter',
        source: native.replace(declaration, `${declaration}\nheaders.getSetCookie = fake;`),
        valid: false,
      },
      {
        name: 'deleted-getter',
        source: native.replace(declaration, `${declaration}\ndelete headers.getSetCookie;`),
        valid: false,
      },
      {
        name: 'assigned-getter',
        source: native.replace(declaration, `${declaration}\nObject.assign(headers, { getSetCookie: fake });`),
        valid: false,
      },
      {
        name: 'escaped-source',
        source: native.replace(declaration, `${declaration}\nopaque(headers);`),
        valid: false,
      },
      {
        name: 'aliased-source',
        source: native.replace(declaration, `${declaration}\nconst alias = headers;\nalias.getSetCookie = fake;`),
        valid: false,
      },
      {
        name: 'extracted-getter',
        source: native.replace(declaration, `${declaration}\nconst getter = headers.getSetCookie;`),
        valid: false,
      },
      {
        name: 'prototype-through-instance',
        source: native.replace(declaration, `${declaration}\nObject.getPrototypeOf(headers).getSetCookie = fake;`),
        valid: false,
      },
      {
        name: 'mutable-cookie',
        source: native.replace('const cookie of', 'let cookie of'),
        valid: false,
      },
      {
        name: 'awaited-loop',
        source: native
          .replace('export const adapt =', 'export const adapt = async')
          .replace('for (const', 'for await (const'),
        valid: false,
      },
      {
        name: 'reassigned-cookie',
        source: native.replace(forwarding, `cookie = opaque();\n${forwarding}`),
        valid: false,
      },
      {
        name: 'shadowed-cookie',
        source: native.replace(forwarding, `{ const cookie = opaque(); ${forwarding} }`),
        valid: false,
      },
      {
        name: 'transformed-cookie',
        source: native.replace(forwarding, "adapted.headers.append('set-cookie', cookie.trim());"),
        valid: false,
      },
      {
        name: 'opaque-cookie',
        source: native.replace(forwarding, "adapted.headers.append('set-cookie', opaque(cookie));"),
        valid: false,
      },
      {
        name: 'cookie-attributes',
        source: native.replace(forwarding, "adapted.headers.append('set-cookie', cookie + '; Path=/');"),
        valid: false,
      },
      {
        name: 'manual-cookie',
        source: native.replace(forwarding, "adapted.headers.append('set-cookie', 'session=manual');"),
        valid: false,
      },
      {
        name: 'mapped-getter-result',
        source: native.replace(cookieGetter, `${cookieGetter}.map(transform)`),
        valid: false,
      },
      {
        name: 'opaque-iterator',
        source: native.replace(cookieGetter, `opaque(${cookieGetter})`),
        valid: false,
      },
      {
        name: 'spread-iterator',
        source: native.replace(cookieGetter, `[...${cookieGetter}]`),
        valid: false,
      },
      {
        name: 'different-cookie-binding',
        source: native.replace(forwarding, "adapted.headers.append('set-cookie', otherCookie);"),
        valid: false,
      },
      { name: 'extra-cookie-use', source: native.replace(forwarding, `opaque(cookie);\n${forwarding}`), valid: false },
      {
        name: 'non-append-writer',
        source: native.replace(forwarding, "adapted.headers.set('set-cookie', cookie);"),
        valid: false,
      },
      {
        name: 'foreign-effect-adapter',
        source: native.replace("'effect/http'", "'./fake-http.ts'"),
        valid: false,
      },
      {
        name: 'escaped-response-adapter',
        source: `${native}\nopaque(HttpServerResponse);`,
        valid: false,
      },
      {
        name: 'mutated-response-adapter',
        source: `${native}\nHttpServerResponse.raw = fake;`,
        valid: false,
      },
      {
        name: 'opaque-response',
        source: native.replace(
          'HttpServerResponse.raw(response.body, { headers }).pipe(HttpServerResponse.toWeb)',
          'opaque({ headers })',
        ),
        valid: false,
      },
      {
        name: 'opaque-options',
        source: native.replace('{ headers }', '{ headers, ...opaqueOptions }'),
        valid: false,
      },
      {
        name: 'mutated-target-writer',
        source: native.replace(forwarding, `adapted.headers.append = fake;\n${forwarding}`),
        valid: false,
      },
      {
        name: 'escaped-target-headers',
        source: native.replace(forwarding, `opaque(adapted.headers);\n${forwarding}`),
        valid: false,
      },
      {
        name: 'mutated-header-name',
        source: native
          .replace(
            'export const adapt',
            "const SET_COOKIE_HEADER = 'set-cookie';\nSET_COOKIE_HEADER = opaque();\nexport const adapt",
          )
          .replaceAll("'set-cookie',", 'SET_COOKIE_HEADER,'),
        valid: false,
      },
      { name: 'unrelated-hand-built-cookie', source: `${native}\nother.append('set-cookie', value);`, valid: false },
    ];
    const files = cases.map((entry) => {
      const folder = path.join(directory, 'apps/demo/api', entry.name);
      mkdirSync(folder, { recursive: true });
      const filename = path.join(folder, 'adapter.ts');
      writeFileSync(filename, entry.source);
      return filename;
    });
    const result = runOxlint(fixtureConfigPath(ruleName), files, appRoot);
    expect(result.numberOfFiles).toBe(cases.length);
    expect(result.diagnostics.filter(({ code }) => code !== ruleCode)).toEqual([]);
    for (const [index, entry] of cases.entries()) {
      const diagnostics = result.diagnostics.filter(({ filename }) => path.resolve(appRoot, filename) === files[index]);
      const label = `${entry.name}: ${JSON.stringify(diagnostics)}`;
      if (entry.valid) {
        expect(diagnostics, label).toHaveLength(0);
      } else {
        expect(diagnostics, label).not.toHaveLength(0);
      }
    }
  });
});
