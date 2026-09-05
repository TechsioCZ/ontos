import { Effect, Schema } from 'effect';

// Patterns the audit explicitly preserves must never be reported by this rule.
export const CustomerPayload = Schema.Struct({ name: Schema.String });

const runtimeAdapter = <A,>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

export const fixtureResponse = (rows: readonly string[]) =>
  new Response(JSON.stringify({ rows: rows.map((row) => row.trim()).filter((row) => row.length > 0) }));

export const decodePayload = Schema.decodeUnknownSync(CustomerPayload);

const BlessedPage = () => {
  const href = new URL('/api/customers', 'https://example.test').toString();
  return <a href={href}>{String(runtimeAdapter)}</a>;
};

export default BlessedPage;
