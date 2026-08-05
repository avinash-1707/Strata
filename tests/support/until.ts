/**
 * Drains microtasks until `condition` holds. The fakes are promise-based with no
 * timers, so a bounded number of turns is deterministic — unlike a `setTimeout`,
 * which would make the test's outcome depend on the machine.
 *
 * Throws rather than resolving on exhaustion: a silent give-up would leave the
 * assertions that follow to fail somewhere less informative.
 */
const MAX_TURNS = 1_000;

export async function until(condition: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`condition never held after ${String(MAX_TURNS)} turns: ${label}`);
}
