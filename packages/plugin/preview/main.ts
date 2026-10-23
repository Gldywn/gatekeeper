// The same stylesheets, in the same order, as src/main.ts: Tabulator's base theme first.
import "tabulator-tables/dist/css/tabulator_midnight.min.css";
import "../src/style.css";
import { getAppInfo } from "@beekeeperstudio/plugin";
import { Gatekeeper } from "../src/app";

function applyTheme(cssString: string): void {
  const el = document.getElementById("app-theme");
  if (el) el.textContent = `:root { ${cssString} }`;
}

const root = document.querySelector<HTMLDivElement>("#app");
if (root) {
  void new Gatekeeper(root).start();
  void getAppInfo().then((info) => applyTheme(info.theme.cssString));
}
