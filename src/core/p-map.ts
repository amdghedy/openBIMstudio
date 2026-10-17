/**
 * Bounded-concurrency async map.
 *
 * Runs at most `concurrency` tasks in parallel. Preserves input order in the
 * result array. Aborts early if the signal fires, rejecting with an
 * AbortError so the caller can distinguish a cancelled run from a failure.
 */
export class AbortError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export interface PMapOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Stop scheduling new work after this many failures. Default: reject fast. */
  continueOnError?: boolean;
}

export async function pMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  opts: PMapOptions = {},
): Promise<R[]> {
  const total = items.length;
  if (total === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, total));
  const out: R[] = new Array(total);
  let cursor = 0;
  let done = 0;
  let firstError: unknown = null;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) throw new AbortError();
      if (firstError && !opts.continueOnError) throw firstError;

      const i = cursor++;
      if (i >= total) return;

      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        if (firstError === null) firstError = err;
        if (!opts.continueOnError) throw err;
      } finally {
        done++;
        opts.onProgress?.(done, total);
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  if (firstError && !opts.continueOnError) throw firstError;
  return out;
}
