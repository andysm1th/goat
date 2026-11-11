import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The demo site and a plain-HTML page that embeds the custom element.
  build: { rollupOptions: { input: ["index.html", "embed.html"] } },
  plugins: [
    react(),
    {
      name: "reload-completed-animation",
      handleHotUpdate({ file, server }) {
        // The converter publishes the manifest only after all hashed assets exist;
        // a running player would otherwise keep the frames it already loaded.
        if (file.endsWith("/public/animation/manifest.json")) {
          server.ws.send({ type: "full-reload" });
          return [];
        }
      },
    },
  ],
});
