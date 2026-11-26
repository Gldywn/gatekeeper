// The plugin's stylesheets in the order of its own entry point: Tabulator's base theme first.
import "../../../packages/plugin/node_modules/tabulator-tables/dist/css/tabulator_midnight.min.css";
import "../../../packages/plugin/src/style.css";
import type { Proposal } from "@gatekeeper/shared";
import type * as Broker from "./broker";
import type * as Scenario from "./scenario";
import type { Read } from "./scenario";

// The real plugin, driven like a person would: Auto mode and Schema access are turned on with
// their own toggles and each arriving read is opened, so the plugin itself shows the
// evaluation and the approval. Visitors can use it too; the script waits while they do.

const root = document.querySelector<HTMLDivElement>("#app");
const html = document.documentElement;
const still = window.matchMedia("(prefers-reduced-motion: reduce)");
// A narrow plugin shows the list or one item, never both. There the list tells the story (the
// dot turning into the bolt), so items are opened only when the frame is wide.
const wide = window.matchMedia("(min-width: 700px)");
const QUIET_MS = 12_000;
// A waiting request that ended (it expired, or a visitor decided it) is asked again this long
// after, by the same agent.
const ASK_AGAIN_MS = 30_000;
// What would change how the plugin runs stays out of a visitor's reach: menus open, their
// switches and Settings do not. The AUTO MODE chip's ✕ is one of the Auto mode toggles.
const LOCKED =
  "#settingsAll, #verDock, #settingsPop .switch-row, [data-mode-trigger], [data-auto-toggle], [data-schema-toggle]";
const HINTS = "[data-auto-settings], [data-schema-settings]";
// A read now and then, sometimes a second close behind it.
const GAP_MS: [number, number] = [4_000, 11_000];
const PAIR_MS: [number, number] = [600, 1_600];
const PAIR_ODDS = 0.3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);

// A read is not asked again before five others have come.
const asked: Read[] = [];
function nextRead(): Read {
  const pool = scenario.ARRIVALS.filter((r) => !asked.includes(r));
  const read = pool[Math.floor(Math.random() * pool.length)];
  asked.push(read);
  if (asked.length > 5) asked.shift();
  return read;
}

async function until<T extends Element>(find: () => T | null, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(60)) {
    const el = find();
    if (el) return el;
  }
  throw new Error("replay step timed out");
}

let visible = false;
let touchedAt = 0;
// Set once the replay has turned Auto mode on with the plugin's own toggle.
let auto = false;
// Loaded with the plugin once the frame is on screen: the fake host they reach pulls in the
// plugin's SQL analysis, most of the demo's weight.
let broker: typeof Broker;
let scenario: typeof Scenario;
const shown: (() => void)[] = [];
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting;
  if (visible) for (const go of shown.splice(0)) go();
}).observe(html);
const onScreen = () => (visible ? Promise.resolve() : new Promise<void>((r) => shown.push(r)));

// Only a person's input counts: the script's own clicks are untrusted events.
// An open dialog or menu counts as use too, for a minute: a visitor may be reading it without
// touching anything, or may have scrolled on and left it open.
const HELD_MS = 60_000;
const busy = () =>
  [...html.querySelectorAll('[role="dialog"]')].some((d) => d.getClientRects().length > 0) ||
  html.querySelector(
    '[data-flyout-trigger][aria-expanded="true"], #settingsGear[aria-expanded="true"], [data-demo-open]',
  ) !== null;
const touched = () => {
  const since = Date.now() - touchedAt;
  return since < QUIET_MS || (since < HELD_MS && busy());
};
for (const type of ["pointerdown", "keydown"]) {
  html.addEventListener(type, (e) => {
    if (e.isTrusted) touchedAt = Date.now();
  });
}
// The plugin focuses a control it re-renders, for keyboard users. In this frame, a focus the
// visitor did not just cause would take the keyboard and the scroll from the landing page.
const focus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (options?: FocusOptions) {
  if (Date.now() - touchedAt < 1_000) focus.call(this, options);
};
const closeHints = (keep?: Element | null) => {
  for (const wrap of html.querySelectorAll<HTMLElement>("[data-demo-open]")) {
    if (wrap !== keep) wrap.removeAttribute("data-demo-open");
  }
};
html.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHints();
});
html.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const wrap = e.target.closest(".sa-hint-wrap");
    closeHints(wrap);
    const hint = e.target.closest(HINTS);
    if (!hint && !e.target.closest(LOCKED)) return;
    e.preventDefault();
    e.stopPropagation();
    if (hint && wrap) {
      wrap.toggleAttribute("data-demo-open");
      // The plugin's own outside-click handlers close its other menus.
      document.body.click();
    }
  },
  true,
);

/** Waits until the replay is on screen and nobody has used it for a while. */
async function free(): Promise<void> {
  for (;;) {
    await onScreen();
    if (!touched()) return;
    await sleep(Math.max(500, touchedAt + QUIET_MS - Date.now()));
  }
}

// The two requests that wait for a person. When one ends, its agent asks again a little later,
// so there is always a write and a sensitive read waiting, as in a real session.
const waits: Proposal[] = [];
const endedAt = new Map<number, number>();
function askAgain(): void {
  waits.forEach((p, slot) => {
    if (broker.isOpen(p.id)) return;
    const since = endedAt.get(slot) ?? Date.now();
    endedAt.set(slot, since);
    if (Date.now() - since < ASK_AGAIN_MS) return;
    endedAt.delete(slot);
    waits[slot] = scenario.askedAgain(p);
    broker.offer(waits[slot]);
  });
}

async function replay(el: HTMLDivElement): Promise<void> {
  const q = (selector: string) => el.querySelector<HTMLElement>(selector);
  const row = (id: string, done = false) =>
    q(`.ix-row.${done ? "done" : "pend"}[data-row="${id}"]`);
  const onQueue = () => q("#tabQueue")?.getAttribute("aria-selected") === "true";
  const open = async (id: string) => {
    if (!wide.matches) return;
    const target = await until(() => row(id));
    // The row shows on the plugin's next poll; a visitor may have taken over meanwhile, or be
    // reading the Audit Trail, which a click on a queue row would leave.
    if (!touched() && onQueue()) target.click();
  };
  try {
    (await until(() => q("#autoHint .sa-off [data-auto-toggle]"))).click();
    await until(() => q(".armed-chip.auto"));
    auto = true;
    (await until(() => q("#schemaHint .sa-off [data-schema-toggle]"))).click();
    await until(() => q('#schemaHint[data-on="true"]'));
    await open(waits[0].id);
  } catch (err) {
    // The plugin's markup no longer matches the script: reads still arrive for a person to decide.
    report("setup failed")(err);
  } finally {
    html.dataset.ready = "";
  }
  for (let first = true, sinceAudit = 0; ; first = false) {
    await free();
    await sleep(first ? 2_600 : between(GAP_MS));
    await free();
    askAgain();
    // Under reduced motion nothing arrives; the loop only keeps the waiting requests.
    if (still.matches) continue;
    const burst = (Math.random() < PAIR_ODDS ? [nextRead(), nextRead()] : [nextRead()]).map(
      scenario.arrival,
    );
    try {
      broker.offer(burst[0]);
      const opened = open(burst[0].id);
      if (burst[1]) {
        await sleep(between(PAIR_MS));
        // The second read of a pair passes the same checks as the first, after its delay.
        if (visible && !touched() && !still.matches) broker.offer(burst[1]);
        else burst.pop();
      }
      await opened;
      // Auto mode evaluates one read at a time, so the second of a pair waits its turn. Without
      // Auto mode the reads wait for a person, so the loop does not wait on them.
      if (auto) for (const p of burst) await until(() => row(p.id, true), 30_000);
    } catch {
      // A read that never settles in time is left to the plugin; the next one comes anyway.
    }
    await sleep(2_500);
    sinceAudit += burst.length;
    if (sinceAudit < 10) continue;
    // Every ten reads, a look at the Audit Trail, where they join the past week's decisions.
    sinceAudit = 0;
    await free();
    // A visitor already on the Audit Trail is left there, and one who used it meanwhile too.
    if (!onQueue()) continue;
    q("#tabAudit")?.click();
    const visitedAt = Date.now();
    await sleep(7000);
    if (touchedAt < visitedAt) q("#tabQueue")?.click();
    await sleep(1500);
  }
}

// The fake SDK's logger keeps nothing, so failures go to the frame's console.
const report = (step: string) => (err: unknown) => console.error(`Gatekeeper demo: ${step}`, err);

// Mounted once the frame is on screen, so the waiting requests count down from then. The plugin,
// the fake host and the PostgreSQL grammar (most of the demo's weight) load only then.
if (root) {
  void onScreen()
    .then(async () => {
      const [{ Gatekeeper }, { loadPgParser }, { wasmBytes }, b, s] = await Promise.all([
        import("../../../packages/plugin/src/app"),
        import("../../../packages/plugin/src/sql/pg/parse"),
        import("../../../packages/plugin/src/sql/pg/wasm"),
        import("./broker"),
        import("./scenario"),
      ]);
      broker = b;
      scenario = s;
      // As in the plugin's own entry point: the grammar loads before anything is parsed.
      if (!(await loadPgParser(wasmBytes))) report("parser")("failed to load");
      waits.push(...scenario.waiting());
      for (const p of waits) broker.offer(p);
      new Gatekeeper(root).start().catch(report("plugin start failed"));
      replay(root).catch(report("replay stopped"));
    })
    .catch(report("failed to load"));
}
