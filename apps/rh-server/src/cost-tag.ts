// The work a Jev or embedding call belongs to (for example "sweep:12"), carried through async calls so ledgers can
// record it without threading it through every function. Calls outside any scope have no tag.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

export function withCostTag<T>(tag: string, run: () => Promise<T>): Promise<T> {
  return storage.run(tag, run);
}

export function currentCostTag(): string | undefined {
  return storage.getStore();
}
