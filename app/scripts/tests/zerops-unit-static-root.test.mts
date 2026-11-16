import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { workspaceRoot } from '../zerops/hosted-units.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

/**
 * The app host relays a request target exactly as received, so a unit's server, not the host, decides what a path
 * means. Every unit and the Shell serve files only through the production server's static handler. A Node child loads
 * that handler and the server's Node adapter (which turns the raw target into the request every handler sees) from the
 * very packages the Shell or a module unit resolves, and asks for files outside the unit's root with raw targets.
 */
const PROBE = String.raw`
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const [unitDirectory, root, ...targets] = process.argv.slice(1);
const appTools = fs.realpathSync(path.join(unitDirectory, 'node_modules/@modern-js/app-tools'));
const prodServer = createRequire(path.join(appTools, 'package.json')).resolve('@modern-js/prod-server');
const adapter = createRequire(prodServer).resolve('@modern-js/server-core/node');
const load = createRequire(adapter);
const { createWebRequest } = load(adapter);
const { createStaticMiddleware } = load(path.join(path.dirname(adapter), 'plugins/static.js'));
const { Hono } = load(load.resolve('hono'));
const app = new Hono();
app.use('*', createStaticMiddleware({ html: {}, output: {}, pwd: path.join(root, 'dist'), routes: [], server: {} }));
app.all('*', (context) => context.text('not found', 404));
(async () => {
  const answers = [];
  for (const target of targets) {
    const request = createWebRequest({ headers: { host: 'unit.test' }, method: 'GET', socket: {}, url: target }, new EventEmitter());
    const response = await app.fetch(request);
    answers.push({ body: await response.text(), status: response.status, target });
  }
  process.stdout.write(JSON.stringify(answers));
})();
`;

const AnswersSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ body: Schema.String, status: Schema.Number, target: Schema.String })),
);

const RAW_TARGETS = [
  '/static/%2e%2e/%2e%2e/package.json',
  '/static/%2E%2E/%2E%2E/zerops.yaml',
  '/static/..%2f..%2fzerops.yaml',
  '/static/js/..%5c..%5c..%5cpackage.json',
  String.raw`/static/..\..\package.json`,
  '/static//../../package.json',
  '//static/../../package.json',
  '/%2e%2e/package.json',
  '/..%2f..%2fzerops.yaml',
  '/static/js/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json',
];

for (const unit of ['apps/shell-super-app', 'verticals/crm']) {
  it.effect(`${unit}: raw targets never reach a file outside the unit's root`, () =>
    Effect.gen(function* rawTargets() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/dist/static/js`, { recursive: true });
      yield* fs.writeFileString(`${root}/dist/static/js/ok.js`, 'served');
      yield* fs.writeFileString(`${root}/package.json`, 'SECRET-PACKAGE');
      yield* fs.writeFileString(`${root}/zerops.yaml`, 'SECRET-ZEROPS');
      yield* fs.writeFileString(`${root}/dist/package.json`, 'SECRET-DIST-PACKAGE');
      const result = yield* collectToolingProcess(
        ChildProcess.make(process.execPath, [
          '-e',
          PROBE,
          `${workspaceRoot}/${unit}`,
          root,
          '/static/js/ok.js',
          ...RAW_TARGETS,
        ]),
      );
      expect(result.stderr).toBe('');
      const [served, ...refused] = yield* Schema.decodeEffect(AnswersSchema)(result.stdout);
      expect(served).toEqual({ body: 'served', status: 200, target: '/static/js/ok.js' });
      expect(refused.map(({ body, status, target }) => ({ secret: body.includes('SECRET'), status, target }))).toEqual(
        RAW_TARGETS.map((target) => ({ secret: false, status: 404, target })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
