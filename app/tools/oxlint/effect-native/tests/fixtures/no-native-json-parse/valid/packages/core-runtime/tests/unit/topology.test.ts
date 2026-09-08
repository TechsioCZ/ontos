// D tier: external fixture APIs that need a body string, and deliberately malformed payloads
// proving rejection behaviour, stay legal. `ignoreTestFiles` defaults to true.
const body = JSON.stringify({ version: 1 });
const echoed: unknown = JSON.parse(body);
const malformed = () => JSON.parse("{ not json");

export { echoed, malformed };
