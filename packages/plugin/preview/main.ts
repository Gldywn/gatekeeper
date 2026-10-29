// The same stylesheets, in the same order, as src/main.ts: Tabulator's base theme first.
import "tabulator-tables/dist/css/tabulator_midnight.min.css";
import "../src/style.css";
import { getAppInfo } from "@beekeeperstudio/plugin";
import { Gatekeeper } from "../src/app";
import { loadPgParser } from "../src/sql/pg/parse";
import { instantiateWasm } from "../src/sql/pg/wasm";

function applyTheme(cssString: string): void {
  const el = document.getElementById("app-theme");
  if (el) el.textContent = `:root { ${cssString} }`;
}

const root = document.querySelector<HTMLDivElement>("#app");
// Same order as src/main.ts: the grammar loads before the app parses anything.
if (root && !(await loadPgParser(instantiateWasm)))
  console.error("[preview] PostgreSQL parser failed to load");
if (root) {
  void new Gatekeeper(root).start();
  void getAppInfo().then((info) => applyTheme(info.theme.cssString));
}
