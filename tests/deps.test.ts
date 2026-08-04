import { describe, expect, it, vi } from "vitest";

import type { LogContext, Logger } from "../src/logger.js";
import { createBackgroundRunner } from "../src/deps.js";

function recordingLogger(): { log: Logger; warns: { context: LogContext; message: string }[] } {
  const warns: { context: LogContext; message: string }[] = [];
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (context, message) => warns.push({ context, message }),
    error: () => undefined,
    child: () => log,
  };
  return { log, warns };
}

describe("createBackgroundRunner", () => {
  it("returns before the work settles, so the response path is not delayed", async () => {
    const { log } = recordingLogger();
    const run = createBackgroundRunner(log);
    let done = false;

    run("touch-usage", async () => {
      await Promise.resolve();
      done = true;
    });

    expect(done).toBe(false);
    await vi.waitFor(() => {
      expect(done).toBe(true);
    });
  });

  it("swallows a rejection and warns, rather than surfacing an unhandled rejection", async () => {
    const { log, warns } = recordingLogger();
    const run = createBackgroundRunner(log);

    run("touch-usage", () => Promise.reject(new Error("redis gone")));

    await vi.waitFor(() => {
      expect(warns).toHaveLength(1);
    });
    expect(warns[0]?.message).toBe("background task failed");
    expect(warns[0]?.context).toMatchObject({ label: "touch-usage", error: "redis gone" });
  });

  it("warns on a synchronous throw, which a bare .catch() would miss", async () => {
    const { log, warns } = recordingLogger();
    const run = createBackgroundRunner(log);

    expect(() => {
      run("bad", () => {
        throw new Error("sync boom");
      });
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(warns).toHaveLength(1);
    });
    expect(warns[0]?.context).toMatchObject({ error: "sync boom" });
  });

  it("renders a thrown non-Error rather than logging [object Object]", async () => {
    const { log, warns } = recordingLogger();
    const run = createBackgroundRunner(log);

    // Rejecting with a non-Error is the whole point of this case: a thrown
    // non-Error is entirely possible and must not log as "[object Object]".
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    run("odd", () => Promise.reject({ nope: true }));

    await vi.waitFor(() => {
      expect(warns).toHaveLength(1);
    });
    expect(warns[0]?.context).toMatchObject({ error: '{"nope":true}' });
  });

  it("keeps tasks independent — one failing does not stop another", async () => {
    const { log, warns } = recordingLogger();
    const run = createBackgroundRunner(log);
    let second = false;

    run("first", () => Promise.reject(new Error("x")));
    run("second", async () => {
      await Promise.resolve();
      second = true;
    });

    await vi.waitFor(() => {
      expect(second).toBe(true);
      expect(warns).toHaveLength(1);
    });
  });
});
