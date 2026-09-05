// expect-count: 4
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Command } from "commander";

const meow = import("meow");

export { Command, hideBin, meow, yargs };
