import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live outside src/ so that src/ is production code only and the build
    // needs no exclude list.
    include: ["tests/**/*.test.ts"],
    /* Pure logic and fake-backed tool tests need no I/O. The subprocess tests that
       spawn a server set their own longer timeout inline; when integration tests
       against real Postgres arrive (Phase 4) they get their own project, because
       these must stay fast. */
    testTimeout: 5_000,
  },
});
