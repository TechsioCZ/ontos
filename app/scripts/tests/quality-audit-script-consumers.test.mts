import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { buildKnipRuntimeEvidence } from '../../quality-audit/knip-runtime-model.mts';

const fixture = Effect.gen(function* nativeScriptFixture() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-script-consumers-' });
  const root = path.join(directory, 'app');
  const write = Effect.fn('ScriptConsumerFixture.write')(function* write(file: string, source: string) {
    const target = path.join(root, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, source);
  });
  yield* write('package.json', '{"name":"native-script-fixture","private":true,"type":"module"}');
  return { root, write };
});
const unusedModule = 'export const stillAudited = 1;';
const calledScript = 'scripts/called.mts';
const workflowFile = '../.github/workflows/proof.yml';
const demoFile = 'scripts/demo/up.sh';
const workerFile = 'scripts/core-system-outbox-worker.generated.mts';
const registryFile = 'scripts/outbox-worker-delivery.mjs';
const materializerFile = 'scripts/materialize-outbox-worker.mjs';
const appDirectory = `APP="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP"`;
const wrappers = `step() {
  local name="$1"
  shift
  if ! "$@" >"$name.log" 2>&1; then
    exit 1
  fi
}
start() {
  local name="$1"
  shift
  nohup "$@" >"$name.log" 2>&1 &
}
WITH_ENV=(mise exec --)`;
const registry = `export const CORE_SYSTEM_OUTBOX_WORKER = Object.freeze({
  entry: '${workerFile}',
  id: 'core-system-worker'
});
const unusedNeighbor = { entry: 'scripts/unused-worker.mts' };`;
const materializer = `import { build } from 'esbuild';
import { CORE_SYSTEM_OUTBOX_WORKER } from './outbox-worker-delivery.mjs';
const resolveOutboxWorkerEffect = ({appId}) => Effect.gen(function* resolveWorker() {
  const dedicatedCore = appId === CORE_SYSTEM_OUTBOX_WORKER.id;
  const entryPoint = dedicatedCore ? CORE_SYSTEM_OUTBOX_WORKER.entry : host.entry;
  return { entryPoint };
});
const materializeOutboxWorkerEffect = (identity) => Effect.gen(function* materializeWorker() {
  const delivery = yield* resolveOutboxWorkerEffect(identity);
  yield* Effect.tryPromise(() => build({ entryPoints: [delivery.entryPoint] }));
});`;

it.effect('workflow consumers require an actual run step in the app working directory', () =>
  Effect.gen(function* nativeWorkflowCommands() {
    const { root, write } = yield* fixture;
    for (const file of [
      calledScript,
      'scripts/comment.mts',
      'scripts/inert.mts',
      'scripts/heredoc.mts',
      'scripts/function.mts',
      'scripts/wrong-directory.mts',
    ]) {
      yield* write(file, unusedModule);
    }
    yield* write(
      workflowFile,
      `name: Native proof
jobs:
  proof:
    steps:
      - working-directory: app
        env:
          INERT: node scripts/inert.mts
        run: |
          # node scripts/comment.mts
          echo "node scripts/inert.mts"
          ignored=(node scripts/inert.mts)
          unused() {
            node scripts/function.mts
          }
          cat <<'DOCUMENT'
          node scripts/heredoc.mts
          DOCUMENT
          mise exec -- node --experimental-strip-types scripts/called.mts
      - working-directory: another-workspace
        run: node scripts/wrong-directory.mts
`,
    );
    const facts = yield* buildKnipRuntimeEvidence(root);
    expect(facts.map(({ kind, target }) => ({ kind, target }))).toEqual([{ kind: 'file', target: calledScript }]);
    expect(facts[0]?.source).toBe(workflowFile);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('workflow cwd changes and native Node flags do not turn nearby strings into entries', () =>
  Effect.gen(function* nativeWorkflowDirectories() {
    const { root, write } = yield* fixture;
    for (const file of [calledScript, 'scripts/after-cd.mts', 'scripts/evaluated.mts', 'scripts/quoted.mts']) {
      yield* write(file, unusedModule);
    }
    yield* write(
      workflowFile,
      `defaults:
  run:
    working-directory: app
jobs:
  proof:
    steps:
      - run: |
          note='multiline text
          node scripts/quoted.mts
          '
          node --eval 'node scripts/evaluated.mts'
          env FIXTURE=yes mise exec -- node --env-file=.env scripts/called.mts
          cd ../other
          node scripts/after-cd.mts
`,
    );
    expect((yield* buildKnipRuntimeEvidence(root)).map(({ target }) => target)).toEqual([calledScript]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('demo wrappers must change to app and actually forward their shifted command arguments', () =>
  Effect.gen(function* nativeDemoWrappers() {
    const { root, write } = yield* fixture;
    for (const file of ['scripts/seed.mts', 'scripts/server.mts', 'scripts/inert.mts']) {
      yield* write(file, unusedModule);
    }
    const source = `${appDirectory}
${wrappers}
unused() {
  node scripts/inert.mts
}
# step ignored node scripts/inert.mts
examples=(node scripts/inert.mts)
step seed env "FIXTURE=value" \\
  "\${WITH_ENV[@]}" node scripts/seed.mts --apply
start server "\${WITH_ENV[@]}" node scripts/server.mts
`;
    yield* write(demoFile, source);
    expect((yield* buildKnipRuntimeEvidence(root)).map(({ target }) => target)).toEqual([
      'scripts/seed.mts',
      'scripts/server.mts',
    ]);

    yield* write(demoFile, source.replace('if ! "$@"', 'if ! echo "$@"').replace('nohup "$@"', 'echo "$@"'));
    expect(yield* buildKnipRuntimeEvidence(root)).toEqual([]);
    yield* write(demoFile, source.replace('cd "$APP"', 'cd /unrelated'));
    expect(yield* buildKnipRuntimeEvidence(root)).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('the Core worker is consumed only through its imported identity resolver and native esbuild option', () =>
  Effect.gen(function* nativeWorkerBundle() {
    const { root, write } = yield* fixture;
    yield* write(workerFile, unusedModule);
    yield* write('scripts/unused-worker.mts', unusedModule);
    yield* write(registryFile, registry);
    yield* write(materializerFile, materializer);
    const facts = yield* buildKnipRuntimeEvidence(root);
    expect(facts.map(({ kind, target }) => ({ kind, target }))).toEqual([{ kind: 'file', target: workerFile }]);
    expect(facts[0]?.source).toBe(materializerFile);

    for (const source of [
      materializer.replace("from 'esbuild'", "from 'unrelated-builder'"),
      materializer.replace('build({ entryPoints:', 'inert({ entryPoints:'),
      materializer.replace('CORE_SYSTEM_OUTBOX_WORKER.entry', 'unusedNeighbor.entry'),
      materializer.replace('const delivery =', 'const build = inert; const delivery ='),
      `const inert = ${JSON.stringify(materializer)};`,
    ]) {
      yield* write(materializerFile, source);
      expect(yield* buildKnipRuntimeEvidence(root)).toEqual([]);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
