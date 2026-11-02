import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    cacheDir: ".vitest", // git-ignored: stale-cache cleanup never touches anything else
    globals: true, // @testing-library/react auto-cleanup registers on globals
  },
});
