import "./style.css";
import { addNotificationListener, getAppInfo, log } from "@beekeeperstudio/plugin";
import { Gatekeeper } from "./app";

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
