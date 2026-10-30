// The same stylesheets, in the same order, as src/main.ts: Tabulator's base theme first.
import "tabulator-tables/dist/css/tabulator_midnight.min.css";
import "../src/style.css";
import { getAppInfo } from "@beekeeperstudio/plugin";
import { Gatekeeper } from "../src/app";
import { loadPgParser } from "../src/sql/pg/parse";
import { wasmBytes } from "../src/sql/pg/wasm";

function applyTheme(cssString: string): void {
  const el = document.getElementById("app-theme");
  if (el) el.textContent = `:root { ${cssString} }`;
}

// crypto=0: the plugin frame of a Beekeeper with no Web Crypto, such as 6.1.6.
if (new URLSearchParams(location.search).get("crypto") === "0") {
  Object.defineProperty(crypto, "subtle", { value: undefined });
}

const root = document.querySelector<HTMLDivElement>("#app");
// Same order as src/main.ts: the grammar loads before the app parses anything.
if (root && !(await loadPgParser(wasmBytes)))
  console.error("[preview] PostgreSQL parser failed to load");
if (root) {
  void new Gatekeeper(root).start();
  void getAppInfo().then((info) => applyTheme(info.theme.cssString));
}
