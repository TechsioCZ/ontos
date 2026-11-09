import { NodeServices } from '@effect/platform-node';
import { DateTime, Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadNativeHumanSessionsFactory } from '../support/native-human-sessions.ts';

it.layer(NodeServices.layer, { excludeTestServices: true })('owned native session module loader', (suite) => {
  suite.effect('requires the exact owned manifest, real file, and factory export without any ambient fallback', () =>
    Effect.gen(function* ownedModuleContract() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const owned = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-native-session-loader-' });
      const root = yield* fs.realPath(owned);
      const created = Math.floor((yield* DateTime.nowAsDate).getTime() / 1000);
      yield* fs.writeFileString(
        path.join(root, '.disk-guardian-owner'),
        `version=1\nowner_pid=${process.pid}\ncreated_epoch=${created}\nexpires_epoch=${created + 60}\npath=${root}\n`,
      );
      const modulePath = path.join(root, 'native-human-sessions.mjs');
      const manifestPath = path.join(root, '.native-human-sessions.json');
      const url = yield* path.toFileUrl(modulePath);
      yield* fs.writeFileString(modulePath, 'export const makeNativeHumanSessionProvider = () => null;');
      expect((yield* Effect.flip(loadNativeHumanSessionsFactory(root, url.href)))._tag).toBe(
        'NativeHumanSessionFixtureError',
      );
      const encode = (factoryExport: string, moduleUrl: string) =>
        `{"factoryExport":"${factoryExport}","moduleUrl":"${moduleUrl}","ownerDirectory":"${root}"}`;
      yield* fs.writeFileString(manifestPath, encode('wrongExport', url.href));
      expect((yield* Effect.flip(loadNativeHumanSessionsFactory(root, url.href)))._tag).toBe(
        'NativeHumanSessionFixtureError',
      );
      yield* fs.writeFileString(manifestPath, encode('makeNativeHumanSessionProvider', url.href));
      expect((yield* loadNativeHumanSessionsFactory(root, url.href)).make).toBeDefined();
      for (const candidate of [
        'https://example.invalid/native-human-sessions.mjs',
        `${url.href}?alternate`,
        (yield* path.toFileUrl(path.join(root, '..', 'native-human-sessions.mjs'))).href,
      ]) {
        expect((yield* Effect.flip(loadNativeHumanSessionsFactory(root, candidate)))._tag).toBe(
          'NativeHumanSessionFixtureError',
        );
      }
      const linked = path.join(root, 'linked-provider');
      yield* fs.makeDirectory(linked);
      const linkedModule = path.join(linked, 'native-human-sessions.mjs');
      yield* fs.symlink(modulePath, linkedModule);
      expect(
        (yield* Effect.flip(loadNativeHumanSessionsFactory(root, (yield* path.toFileUrl(linkedModule)).href)))._tag,
      ).toBe('NativeHumanSessionFixtureError');
    }),
  );
});
