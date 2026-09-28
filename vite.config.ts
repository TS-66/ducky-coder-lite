import { defineConfig } from "vite";

// Ducky Coder Lite frontend build.
// Deliberately plain Vite (esbuild) with no framework runtime: a virtual-DOM
// framework is dead weight when the target machine has 2 GB of RAM, and every
// kilobyte of retained heap is memory the editor could spend on documents.
export default defineConfig({
  // Tauri serves the bundle from a custom protocol.
  base: "./",
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Chromium on low-end machines chokes on very modern syntax.
    target: ["es2021", "chrome100", "safari15"],
    outDir: "dist",
    emptyOutDir: true,
    minify: "esbuild",
    cssMinify: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split the heavy editor engine out of the boot chunk so the first
        // paint (activity bar + welcome screen) does not wait on CodeMirror.
        manualChunks(id) {
          if (id.includes("node_modules/@codemirror")) return "editor-engine";
          if (id.includes("node_modules/")) return "vendor";
          return undefined;
        },
      },
    },
  },
});
