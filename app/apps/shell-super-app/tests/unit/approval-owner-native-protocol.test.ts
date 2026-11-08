import { Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { NativeOwnerApprovalConfigurationSchema } from '../support/approval-owner-native-protocol.ts';

for (const field of ['databaseEnvironment', 'spiceDbEnvironment'] as const) {
  it(`round-trips the private ${field} through child stdin and redacts the decoded value`, () => {
    const schema = Schema.fromJsonString(NativeOwnerApprovalConfigurationSchema.fields[field]);
    const environment = { CONTROL: 'non-secret-round-trip-control' };
    const encoded = Schema.encodeSync(schema)(Redacted.make(environment));
    const decoded = Schema.decodeUnknownSync(schema)(encoded);
    expect(Redacted.value(decoded)).toEqual(environment);
    expect(Redacted.isRedacted(decoded)).toBe(true);
    expect(JSON.stringify(decoded)).not.toContain(environment.CONTROL);
  });
}
