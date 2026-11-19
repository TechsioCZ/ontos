// Next initializes its real AsyncLocalStorage before any request-context modules load.
// happy-dom supplies matchMedia, scrollTo, storage and fetch itself: no platform or product replacements.
import "next/dist/server/node-environment-baseline";

// Match Next's Turbopack browser decoder alias. These are Next's actual runtime exports,
// not test implementations. Text-only Flight replies contain no bundled client references.
import { createRequire } from "node:module";
import { addHookAliases } from "next/dist/server/require-hook";
const require = createRequire(import.meta.url);
addHookAliases([
  [
    "react-server-dom-webpack/client",
    require.resolve("next/dist/compiled/react-server-dom-turbopack/client.browser"),
  ],
]);
