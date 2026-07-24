import "./style.css";
import {
  addNotificationListener,
  getAppInfo,
  log,
  runQuery,
} from "@beekeeperstudio/plugin";
import type { QueryResult, RunQueryResult } from "@beekeeperstudio/plugin";

// Channel 1 probe: the smallest query that proves runQuery reaches Beekeeper's
// connection and returns rows back over postMessage.
const TEST_QUERY = "SELECT 1 AS ok";

// Channel 2 probe: an outbound fetch from the sandboxed iframe to a localhost
// broker stub. Proves the plugin can pull work from an origin outside Beekeeper.
const BROKER_PING_URL = "http://localhost:9999/ping";

/** Run the Channel 1 probe query on Beekeeper's active connection. */
export async function runTestQuery(): Promise<RunQueryResult> {
  return runQuery(TEST_QUERY);
}

/** Rows of the first result set, or an empty array if the query returned none. */
export function firstResultRows(result: RunQueryResult): QueryResult["rows"] {
  return result.results[0]?.rows ?? [];
}

/** Fetch the Channel 2 broker stub and return its parsed JSON body. */
export async function pingBroker(): Promise<unknown> {
  const response = await fetch(BROKER_PING_URL);
  if (!response.ok) {
    throw new Error(`Broker responded ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/** Mirror Beekeeper's theme variables into the page so the view looks native. */
function applyTheme(cssString: string): void {
  const themeElement = document.getElementById("app-theme");
  if (themeElement) {
    themeElement.textContent = `:root { ${cssString} }`;
  }
}

/** Run an async action on click, rendering its result (or error) as JSON. */
function wireButton(
  button: HTMLButtonElement,
  output: HTMLPreElement,
  action: () => Promise<unknown>,
): void {
  const label = button.textContent;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Running...";
    output.hidden = false;
    output.classList.remove("error");
    try {
      const data = await action();
      output.textContent = JSON.stringify(data, null, 2);
    } catch (error) {
      output.classList.add("error");
      output.textContent = String(error);
      log.error(error instanceof Error ? error : String(error));
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

/** Render the two probe panels and wire their handlers onto the root element. */
export function mount(root: HTMLElement): void {
  root.innerHTML = `
    <main class="container">
      <h1>Gatekeeper</h1>
      <p class="subtitle">Spikes A and B: proving the plugin's two channels.</p>

      <section class="probe">
        <h2>Channel 1: <code>runQuery</code></h2>
        <p class="hint">Runs <code>${TEST_QUERY}</code> on Beekeeper's connection.</p>
        <button id="run-btn" class="primary-btn" type="button">Run test query</button>
        <pre id="query-output" class="output" hidden></pre>
      </section>

      <section class="probe">
        <h2>Channel 2: <code>fetch</code> broker</h2>
        <p class="hint">Fetches <code>${BROKER_PING_URL}</code> from the iframe.</p>
        <button id="ping-btn" class="primary-btn" type="button">Ping broker</button>
        <pre id="ping-output" class="output" hidden></pre>
      </section>
    </main>
  `;

  wireButton(
    root.querySelector<HTMLButtonElement>("#run-btn")!,
    root.querySelector<HTMLPreElement>("#query-output")!,
    async () => firstResultRows(await runTestQuery()),
  );
  wireButton(
    root.querySelector<HTMLButtonElement>("#ping-btn")!,
    root.querySelector<HTMLPreElement>("#ping-output")!,
    pingBroker,
  );
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    return;
  }
  mount(root);
  try {
    const appInfo = await getAppInfo();
    applyTheme(appInfo.theme.cssString);
    addNotificationListener("themeChanged", (theme) => {
      applyTheme(theme.cssString);
    });
  } catch (error) {
    // Theme sync is cosmetic; a failure here must not stop the spikes working.
    log.error(error instanceof Error ? error : String(error));
  }
}

bootstrap();
