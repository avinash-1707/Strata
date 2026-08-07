import { afterEach, describe, expect, it, vi } from "vitest";

import { SHUTDOWN_FLOOR_MS } from "../src/config/budgets.js";
import { withShutdownFloor } from "../src/shutdown.js";
import { createRecordingLogger } from "./support/recordingLogger.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Replaced, not called: the floor's whole job is to end the process. */
function stubExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
}

describe("the shutdown floor", () => {
  it("exits non-zero when teardown outlives it", async () => {
    vi.useFakeTimers();
    const exit = stubExit();
    const log = createRecordingLogger();

    // Deliberately never settles: this is `pool.end()` waiting behind a repair pass
    // that is holding a pooled connection through a model call.
    const running = withShutdownFloor(log, () => new Promise<void>(() => undefined));
    void running;

    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLOOR_MS + 1);

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.messages("error")).toContain("shutdown exceeded its floor; exiting");
  });

  /* `unref()` alone would leave this timer live in any process that keeps running —
     a test host, or a stdio session that tore one server down and carried on — and it
     would take the exit long after the teardown it was watching had succeeded. */
  it("stops watching once teardown finishes", async () => {
    vi.useFakeTimers();
    const exit = stubExit();
    const log = createRecordingLogger();

    await withShutdownFloor(log, () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLOOR_MS * 3);

    expect(exit).not.toHaveBeenCalled();
    expect(log.messages("error")).toEqual([]);
  });

  it("stops watching when teardown throws, and lets the failure propagate", async () => {
    vi.useFakeTimers();
    const exit = stubExit();
    const log = createRecordingLogger();

    await expect(
      withShutdownFloor(log, () => Promise.reject(new Error("close failed"))),
    ).rejects.toThrow("close failed");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLOOR_MS * 3);

    expect(exit).not.toHaveBeenCalled();
  });
});
