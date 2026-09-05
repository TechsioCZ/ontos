// Even the pathological alias of the effect Console service is never reported.
import { Console as console } from "effect";

export const emit = (report: string) => console.log(report);
