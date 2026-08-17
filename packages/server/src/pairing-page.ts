import type { PairingCode } from "./store.js";

const STYLE = `
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: oklch(18.5% 0.006 250); color: oklch(93% 0.006 250);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 460px; padding: 40px 24px; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 17px; font-weight: 660; }
  p { margin: 0 0 16px; color: oklch(70% 0.009 250); font-size: 14px; line-height: 1.55; }
  .code {
    margin: 22px 0 14px; padding: 18px 12px; border-radius: 10px;
    background: oklch(14.5% 0.005 250); border: 1px solid oklch(82% 0.145 88 / 0.35);
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    font-size: 40px; font-weight: 600; letter-spacing: 0.22em; text-indent: 0.22em;
    color: oklch(82% 0.145 88);
  }
  .note { font-size: 12.5px; color: oklch(53% 0.01 250); }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

// The code is read by the human and typed into the plugin; nothing on this page is
// scripted or fetched, so a strict CSP can forbid everything but the inline style.
export function pairingPage(code: PairingCode | null, now: number): string {
  if (!code) {
    return page(
      "Gatekeeper pairing",
      `<h1>Nothing to pair right now</h1>
       <p>A Gatekeeper plugin is already talking to this broker, so no code is being handed out.</p>
       <p class="note">To pair a different one, close that Beekeeper Studio tab, wait a couple of minutes, then reload this page.</p>`,
    );
  }
  const minutes = Math.max(1, Math.round((code.expiresAt - now) / 60_000));
  return page(
    "Gatekeeper pairing code",
    `<h1>Your pairing code</h1>
     <p>Type it into the Gatekeeper tab in Beekeeper Studio.</p>
     <div class="code">${code.code}</div>
     <p>It works once and expires in about ${minutes} minute${minutes > 1 ? "s" : ""}. Reload this page to get a fresh one.</p>
     <p class="note">Keep it to yourself: whoever enters it can read the queries your agents propose.</p>`,
  );
}
