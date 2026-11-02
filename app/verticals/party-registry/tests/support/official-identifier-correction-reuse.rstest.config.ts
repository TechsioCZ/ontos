export default {
  projects: [
    {
      name: 'integration',
      testEnvironment: 'node',
      include: ['tests/integration/official-identifier-correction-reuse.test.ts'],
      testTimeout: 30_000,
    },
  ],
};
