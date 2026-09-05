// expect-count: 1
// Evasion: the class capability slot is declared with the TS 5 `accessor` keyword, which parses as
// `AccessorProperty` rather than `PropertyDefinition`.
const actionHandlerSlot: unique symbol = Symbol('@app/core-runtime/actions/accessor/handler');

export class ActionRegistry {
  accessor [actionHandlerSlot]: (payload: unknown) => Promise<void> = async () => {};
}
