import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'effect-rstest';

const require = createRequire(import.meta.url);
const frameworkRequire = createRequire(require.resolve('@modern-js/app-tools'));
const ndepe = path.dirname(frameworkRequire.resolve('ndepe'));

for (const extension of ['js', 'mjs']) {
  it(`copies the complete deployment package once per destination, retaining last-write and export semantics (${extension})`, () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'ontos-deploy-package-'));
    try {
      const packageDirectory = path.join(fixture, 'node_modules/dependency');
      mkdirSync(path.join(packageDirectory, 'nested'), { recursive: true });
      const files = Array.from({ length: 35 }, (_, index) => {
        const file = path.join(packageDirectory, 'nested', `${index}.js`);
        writeFileSync(file, `module.exports = ${index};\n`);
        return file;
      });
      // Whole-package tracing overlaps individual file traces. A second installed location of the
      // same package version must keep the original emitter's last-write behavior, not race it.
      const last = path.join(fixture, 'another/node_modules/dependency/nested/0.js');
      mkdirSync(path.dirname(last), { recursive: true });
      writeFileSync(last, 'module.exports = 999;\n');
      const probe = `
        const { writePackage } = await import(process.argv[1]);
        const { readFileSync } = await import('node:fs');
        const input = JSON.parse(process.argv[2]);
        await writePackage({
          pkg: { name: 'dependency', versions: { '1.0.0': {
            path: input.packageDirectory,
            files: [...input.files, ...input.files, input.last],
            pkgJSON: { name: 'dependency', version: '1.0.0', publishConfig: { exports: { '.': './nested/0.js' } } },
          } } },
          version: '1.0.0', projectDir: input.output,
          transformPackageJson: ({ pkgJSON }) => ({ ...pkgJSON, private: true }),
          packageJsonCache: new Map(),
        });
      `;
      const output = path.join(fixture, 'output');
      execFileSync(process.execPath, [
        '--input-type=module',
        '--eval',
        probe,
        pathToFileURL(path.join(ndepe, `utils.${extension}`)).href,
        JSON.stringify({ files, last, output, packageDirectory }),
      ]);
      for (let index = 0; index < files.length; index += 1) {
        expect(readFileSync(path.join(output, 'node_modules/dependency/nested', `${index}.js`), 'utf-8')).toBe(
          `module.exports = ${index === 0 ? 999 : index};\n`,
        );
      }
      expect(
        JSON.parse(readFileSync(path.join(output, 'node_modules/dependency/package.json'), 'utf-8')),
      ).toMatchObject({ exports: { '.': './nested/0.js' }, name: 'dependency', private: true, version: '1.0.0' });
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });
}
