// The same stylesheets, in the same order, as src/main.ts: Tabulator's base theme first.
import "tabulator-tables/dist/css/tabulator_midnight.min.css";
import "../src/style.css";
import { getAppInfo } from "@beekeeperstudio/plugin";
import { Gatekeeper } from "../src/app";
import type { HistItem } from "../src/types";
import { seededHistory } from "./fixtures";

function applyTheme(cssString: string): void {
  const el = document.getElementById("app-theme");
  if (el) el.textContent = `:root { ${cssString} }`;
}

const root = document.querySelector<HTMLDivElement>("#app");
if (root) {
  const app = new Gatekeeper(root);
  // Preview only: the history field is private to the app, and no production seam exists for it.
  (app as unknown as { history: HistItem[] }).history.push(...seededHistory());
  void app.start();
  void getAppInfo().then((info) => applyTheme(info.theme.cssString));
}
