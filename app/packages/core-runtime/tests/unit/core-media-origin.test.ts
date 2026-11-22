import { expect, it } from 'effect-rstest';

import { isOriginConsistentWithPrincipalKind } from '../../src/media/origin.ts';
import { MediaIngestionSourceSchema } from '../../src/media/public-contract.ts';

/*
 * BR-06 of #1430: the recorded `ingestionSource` corresponds to the true origin. The carrier that admitted the upload
 * is the one trusted fact about the origin, so a stated origin that contradicts it is refused. The four origins are
 * otherwise equal: this decides nothing about permission.
 */

const sources = MediaIngestionSourceSchema.literals;

it('admits a person or an agent only as the origin `user`', () => {
  for (const kind of ['human', 'agent'] as const) {
    expect(sources.filter((source) => isOriginConsistentWithPrincipalKind(kind, source))).toEqual(['user']);
  }
});

it('admits a workload principal as `system`, `integration` or `import`, never as `user`', () => {
  for (const kind of ['system', 'integration', 'service'] as const) {
    expect(sources.filter((source) => isOriginConsistentWithPrincipalKind(kind, source)).toSorted()).toEqual([
      'import',
      'integration',
      'system',
    ]);
  }
});

it('refuses a principal kind it does not know, whatever the stated origin', () => {
  for (const source of sources) {
    expect(isOriginConsistentWithPrincipalKind('robot', source)).toBe(false);
    expect(isOriginConsistentWithPrincipalKind('', source)).toBe(false);
  }
});
