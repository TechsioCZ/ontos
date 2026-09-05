// expect-count: 4
import { Effect } from "effect";
import { Client } from "pg";

const client = new Client({ connectionString: "postgres://localhost/ontos" });

// Each of these runs during module evaluation with no fiber, no Scope, no error channel.
await client.connect();
const { rows } = await client.query("select 1");
console.log(rows.length);
await client.end();

const module_ = await import("node:os");
void module_;
void Effect.void;
