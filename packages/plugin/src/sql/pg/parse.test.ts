import { loadModule } from "libpg-query";
import { describe, expect, it } from "vitest";
import { instantiateWasm } from "./wasm";

describe("loading PostgreSQL's grammar", () => {
  // Unpatched, libpg-query ignores the options and this resolves: Beekeeper would fetch the WASM.
  it("takes the bundled WASM through the patched loader (constructive-io/libpg-query-node#191)", async () => {
    await expect(loadModule({ instantiateWasm })).rejects.toThrow(/already started/);
  });
});
