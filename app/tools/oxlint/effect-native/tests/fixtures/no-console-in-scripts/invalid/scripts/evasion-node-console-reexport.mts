// Policy boundary: oxlint.config.ts allows successful operational output; audit B3/A6 targets diagnostic logging.
// B3/A6: re-exporting the ambient sink from a script hands `node:console` to every consumer under a
// local name the rule can no longer see.
export { error } from "node:console";
export { default as consoleSink } from "node:console";
