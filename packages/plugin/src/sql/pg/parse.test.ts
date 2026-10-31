import { loadModule } from "libpg-query";
import { describe, expect, it } from "vitest";
import { readPg } from "./parse";

describe("loading PostgreSQL's grammar", () => {
  // A libpg-query that ignored the bytes would resolve: Beekeeper would then fetch the WASM.
  it("compiles the bytes it is given, and bad bytes leave the loaded parser intact", async () => {
    await expect(loadModule({ wasm: new Uint8Array([0]) })).rejects.toBeInstanceOf(
      WebAssembly.CompileError,
    );
    expect(readPg("SELECT 1")).toMatchObject({ tokens: expect.any(Array) });
  });
});
