// `console` imported from anywhere other than node:console is an ordinary binding.
import { console } from "./reporting-sink.mts";

export const emit = (message: string): void => console.log(message);
