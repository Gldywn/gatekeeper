import bks from "@beekeeperstudio/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // The Beekeeper Studio plugin handles bundling the HTML entrypoints into dist/.
    bks({
      entrypoints: [
        {
          input: "index.html",
          output: "dist/index.html",
        },
      ],
    }),
  ],
});
