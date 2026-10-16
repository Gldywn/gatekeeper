// Dev-only: scripts/dev-server.mjs keeps the public broker port for its whole life and relays
// each connection to the server tsx restarts behind it, so a restart never frees the port for
// another Gatekeeper server to take. Bytes pass untouched: the server still checks Host itself.

import { createConnection, createServer } from "node:net";

export function holdBrokerPort(port, socketPath) {
  // Half-open on both legs, so a caller's FIN after its request never cuts the reply short.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = createConnection({ path: socketPath, allowHalfOpen: true });
    client.pipe(upstream).pipe(client);
    // A restart in progress refuses the connect: drop this pair only, keep the port.
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
