import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

export default {
  root: fileURLToPath(new URL('../../', import.meta.url)),
  pool: { maxWorkers: 1 },
  projects: [
    {
      name: 'integration',
      testEnvironment: 'node',
      setupFiles: [],
      include: [
        'tests/integration/reviewed-match-reuse.test.ts',
        'tests/integration/official-identifier-original-input.test.ts',
        'tests/integration/guest-party-evidence-authority.test.ts',
        'tests/integration/official-identifier-correction-reuse.test.ts',
      ],
      testTimeout: 30_000,
    },
  ],
};
