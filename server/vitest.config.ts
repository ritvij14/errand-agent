import { defineConfig } from "vitest/config";

// The transform cache lives in `.vitest/` (git-ignored) so a stale-cache cleanup never
// has to target anything that matters (see scripts/verify-*.sh usage notes).
export default defineConfig({
  test: {
    cacheDir: ".vitest",
  },
});
