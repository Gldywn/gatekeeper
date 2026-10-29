// Tabulator's dark base theme first, so our token overrides in style.css cascade last.
// The light default bled white through the rows; midnight starts dark, so we only re-tint.
import "tabulator-tables/dist/css/tabulator_midnight.min.css";
import "./style.css";
import { addNotificationListener, getAppInfo, log } from "@beekeeperstudio/plugin";
import { Gatekeeper } from "./app";
import { loadPgParser } from "./sql/pg/parse";
import { instantiateWasm } from "./sql/pg/wasm";

function applyTheme(cssString: string): void {
  const el = document.getElementById("app-theme");
  if (el) {
    el.textContent = `:root { ${cssString} }`;
  }
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    return;
  }
  if (!(await loadPgParser(instantiateWasm))) {
    log.error("PostgreSQL parser failed to load");
  }
  const app = new Gatekeeper(root);
  void app.start();
  try {
    const appInfo = await getAppInfo();
    applyTheme(appInfo.theme.cssString);
    addNotificationListener("themeChanged", (theme) => applyTheme(theme.cssString));
  } catch (err) {
    log.error(err instanceof Error ? err : String(err));
  }
}

void bootstrap();
