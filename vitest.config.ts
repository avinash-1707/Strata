import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    /* Phase 1 is pure logic with no I/O, so the default thread pool is fine.
       When integration tests against real Postgres arrive (Phase 4), they get
       their own project with a longer timeout — pure tests must stay fast. */
    testTimeout: 5_000,
  },
});
