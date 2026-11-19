// A fresh Node realm selects the published React server condition before module initialization.
const {
  renderToPipeableStream,
} = require("next/dist/compiled/react-server-dom-webpack/server.node");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const { text, search = "" } = JSON.parse(input);
  const data = { r: text, p: false, v: null };
  const page = { s: "__PAGE__", d: { r: null, p: false, v: null } };
  const root = { s: "", d: data, c: new Map([["children", page]]) };
  renderToPipeableStream(
    { b: "", t: { t: root, h: { r: null, p: false, v: null } }, q: search, i: false, S: false },
    {},
  ).pipe(process.stdout);
});
