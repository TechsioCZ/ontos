import { Schema } from "effect";
const fake = { NullOr: (value: string) => value };
let namespace = Schema;
namespace = fake as unknown as typeof Schema;
export const value = namespace.NullOr("ordinary value");
