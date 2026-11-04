import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    typecheck: {
      tsconfig: "./tsconfig.vitest.json",
    },
    environment: "jsdom",
    // Node 25+ ships a global Web Storage API that shadows jsdom's
    // localStorage (undefined without --localstorage-file). Disable it in
    // test workers so jsdom's implementation is used.
    execArgv: ["--no-webstorage"],
    setupFiles: ["./src/setupTests.ts"],
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**"],
    benchmark: {
      includeSamples: true,
    },
  },
});
