import { defineConfig } from "vite";

// The embeddable builds, each a single self-contained file:
//   --mode element  ->  lib/text-goat.js  (<text-goat> + createTextGoat, no dependencies)
//   --mode react    ->  lib/react.js      (<TextGoat />, React left to the host app)
//   --mode site     ->  dist/text-goat.js (the element build again, published with
//                                          the demo so other sites can load it)
export default defineConfig(({ mode }) => {
  const react = mode === "react";
  const site = mode === "site";
  return {
    publicDir: false,
    // A <script> tag loads text-goat.js straight from its host, so it finds the
    // frames in animation/ beside itself. React builds are bundled into the host
    // app instead, and keep looking for /animation/ on the page's own site.
    define: react ? {} : { "import.meta.env.TEXT_GOAT_STANDALONE": "true" },
    build: {
      outDir: site ? "dist" : "lib",
      // Only the first lib build starts afresh; site adds to the built demo.
      emptyOutDir: mode === "element",
      target: "es2022",
      lib: {
        entry: react ? "src/react/index.ts" : "src/element/index.ts",
        formats: ["es"],
        fileName: () => (react ? "react.js" : "text-goat.js"),
      },
      rollupOptions: {
        external: react ? ["react", "react/jsx-runtime"] : [],
        // The component uses effects, so Next.js must treat it as a client module.
        output: { banner: react ? "'use client';" : "" },
      },
    },
  };
});
