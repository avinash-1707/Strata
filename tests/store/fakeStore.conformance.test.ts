import { createFakeStore } from "../fakes/fakeStore.js";
import { describeMemoryStore } from "./conformance.js";

/**
 * The fake, run through the shared `MemoryStore` contract suite. Phase 4 adds a
 * sibling file pointing the same suite at real Postgres; the two passing the same
 * assertions is what makes Phase 3's tool tests meaningful evidence about production
 * behavior rather than evidence about the fake (DD-032 item 10).
 */
describeMemoryStore("fake store", () => Promise.resolve({ store: createFakeStore() }));
