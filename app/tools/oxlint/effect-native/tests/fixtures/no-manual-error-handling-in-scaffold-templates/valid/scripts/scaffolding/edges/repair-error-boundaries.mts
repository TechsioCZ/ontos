export const rendered = `
// if (error._tag === 'Bad') {}
const guide = "switch (error._tag), error instanceof BadProblem";
const typed = Effect.catch((error) => { if (budgetRemaining > 0) { return retry(); } return Effect.fail(error); });
const observer = client.read().catch((err) => { if (budgetRemaining > 0) { record(err); } return null; });
const external = (error) => error instanceof Error || error instanceof TypeError || error instanceof AggregateError;
`;
console.log(`error._tag === 'Bad'`);
