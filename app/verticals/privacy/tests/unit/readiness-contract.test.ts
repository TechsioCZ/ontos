import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { privacyReadinessSchema } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

it('accepts the complete delivery-unit marker in the strict readiness response', () => {
  const response = {
    checks: { api: 'ready', moduleFederation: 'ready', ssr: 'ready', translations: 'ready' },
    marker: ultramodernApiMarker,
    status: 'ready',
    versionSkew: 'none',
  };

  expect(Schema.decodeUnknownSync(privacyReadinessSchema, { onExcessProperty: 'error' })(response)).toEqual(response);
});
