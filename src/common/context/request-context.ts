import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestStore>();

export function runWithRequestContext<T>(store: RequestStore, fn: () => T): T {
  return storage.run(store, fn);
}

export function getRequestContext(): RequestStore | undefined {
  return storage.getStore();
}
