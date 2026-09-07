// expect-count: 2
import test from 'node:test';

test('a runner callback does not turn its local service into a framework boundary', () => {
  const load: () => Promise<void> = () => Promise.resolve();
  const service = {
    save: async () => {},
  };
  void load;
  void service;
});
