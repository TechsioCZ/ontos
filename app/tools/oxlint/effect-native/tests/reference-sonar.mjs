// Reference only: exercise Sonar's released rules with their own ESLint peer and TypeScript parser.
// Do not use this runner for production lint; it exists to measure differences from the tsrs backend.
import { createRequire } from 'node:module';
import path from 'node:path';

const sonarRequire = createRequire(import.meta.resolve('eslint-plugin-sonarjs'));
const { ESLint } = sonarRequire('eslint');
const { default: sonar } = await import('eslint-plugin-sonarjs');
const parser = sonarRequire('@typescript-eslint/parser');
const [cwd, ...files] = process.argv.slice(2);
const reference = new ESLint({
  cwd,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.ts'],
      languageOptions: { parser, parserOptions: { project: ['*/tsconfig.json'], tsconfigRootDir: cwd } },
      plugins: { sonarjs: sonar },
      rules: { 'sonarjs/no-redundant-optional': 'error', 'sonarjs/no-inconsistent-returns': 'error' },
    },
  ],
});
const results = await reference.lintFiles(files);
for (const { filePath, messages } of results) {
  for (const message of messages) {
    if (message.fatal || !message.ruleId) throw new Error(message.message);
    console.log(path.relative(cwd, filePath), message.ruleId);
  }
}
