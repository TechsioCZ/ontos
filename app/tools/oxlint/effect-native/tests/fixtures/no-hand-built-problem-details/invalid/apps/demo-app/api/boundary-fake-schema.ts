// expect-count: 2
// A4: neither a suffix nor a shadowed namespace grants contract ownership.
import { Schema } from 'effect';
const FakeSchema = (value: unknown) => value;
export const fake = FakeSchema({status: 500, title: 'Failure', type: 'https://example.test/problems/internal'});
export function shadow(Schema: {annotations: (value: unknown) => unknown}) {
 return Schema.annotations({status: 500, title: 'Failure', type: 'https://example.test/problems/internal'});
}
