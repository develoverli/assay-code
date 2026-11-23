import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Unit tests only: everything under test is pure, so no browser, no Tauri.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
