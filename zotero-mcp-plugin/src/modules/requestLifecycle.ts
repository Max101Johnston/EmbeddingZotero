export class TaskError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}

export function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new TaskError(-32800, "Request cancelled");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Zotero exposes the underlying XHR through requestObserver. Keep ownership until it settles. */
export async function abortableHttpRequest<T>(
  request: (observer: (xhr: { abort(): void }) => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let xhr: { abort(): void } | undefined;
  const onAbort = () => {
    try {
      xhr?.abort();
    } catch {
      /* Request already closed. */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await request((observed) => {
      xhr = observed;
      if (signal?.aborted) onAbort();
    });
    throwIfAborted(signal);
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function abortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface QueuedTask {
  start: () => void;
  reject: (reason: Error) => void;
}

/** Removes cancelled waiters immediately; an executing operation owns its slot until it settles. */
export class SerialTaskQueue {
  private active = false;
  private queue: QueuedTask[] = [];
  private idleWaiters: Array<() => void> = [];
  private closed = false;
  private readonly maxQueued: number;
  constructor(maxQueued = 16) {
    this.maxQueued = maxQueued;
  }
  get size(): number {
    return (this.active ? 1 : 0) + this.queue.length;
  }

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (this.closed)
      return Promise.reject(new TaskError(-32800, "Task queue closed"));
    if (this.active && this.queue.length >= this.maxQueued)
      return Promise.reject(
        new TaskError(-32002, "Task queue is full; retry later"),
      );
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const task: QueuedTask = {
        reject: (error) => {
          cleanup();
          reject(error);
        },
        start: () => {
          cleanup();
          this.active = true;
          Promise.resolve()
            .then(() => {
              throwIfAborted(signal);
              return operation();
            })
            .then(resolve, reject)
            .finally(() => {
              this.active = false;
              this.drain();
            });
        },
      };
      const onAbort = () => {
        const index = this.queue.indexOf(task);
        if (index >= 0) this.queue.splice(index, 1);
        task.reject(abortReason(signal));
      };
      if (this.active) {
        this.queue.push(task);
        signal?.addEventListener("abort", onAbort, { once: true });
      } else task.start();
    });
  }

  private drain(): void {
    const next = this.queue.shift();
    if (next) next.start();
    else for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  async waitForIdle(maxWaitMs: number): Promise<boolean> {
    if (this.size === 0) return true;
    let resolveIdle!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<true>((resolve) => {
      resolveIdle = () => resolve(true);
      this.idleWaiters.push(resolveIdle);
    });
    try {
      return await Promise.race([
        idle,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), maxWaitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.idleWaiters = this.idleWaiters.filter(
        (resolve) => resolve !== resolveIdle,
      );
    }
  }

  close(): void {
    this.closed = true;
    for (const task of this.queue.splice(0))
      task.reject(new TaskError(-32800, "Task queue closed"));
  }
}

/** The caller owns cancellation. Uninterruptible I/O stays counted until it actually finishes. */
export class RequestTaskManager {
  private tasks = new Map<string, AbortController>();
  private readonly limit: number;
  constructor(limit = 32) {
    this.limit = limit;
  }
  private key(session: string, id: string | number | null): string {
    return JSON.stringify([session, id]);
  }

  async run<T>(
    session: string,
    id: string | number | null,
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(callerSignal);
    const key = this.key(session, id);
    if (this.tasks.has(key))
      throw new TaskError(
        -32600,
        "Request ID is already active in this session",
      );
    if (this.tasks.size >= this.limit)
      throw new TaskError(
        -32002,
        "Too many active requests; retry after current requests finish",
      );
    // loadSubScript's plugin scope does not expose every DOM constructor.
    // The toolkit resolves missing constructors from Zotero's main window.
    const Controller =
      typeof AbortController === "function"
        ? AbortController
        : ztoolkit.getGlobal("AbortController");
    const controller = new Controller();
    this.tasks.set(key, controller);
    const onCallerAbort = () => controller.abort(abortReason(callerSignal));
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(abortReason(controller.signal));
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const work = Promise.resolve()
      .then(() => {
        throwIfAborted(controller.signal);
        return operation(controller.signal);
      })
      .finally(() => {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        controller.signal.removeEventListener("abort", onAbort);
        this.tasks.delete(key);
      });
    return Promise.race([work, cancelled]);
  }

  cancel(
    session: string,
    id: string | number | null,
    reason?: string,
  ): boolean {
    const controller = this.tasks.get(this.key(session, id));
    if (!controller) return false;
    controller.abort(
      new TaskError(-32800, reason || "Request cancelled by client"),
    );
    return true;
  }

  cancelAll(): void {
    for (const controller of this.tasks.values())
      controller.abort(new TaskError(-32800, "MCP server stopped"));
  }

  getStatus(): { active: number; draining: number; limit: number } {
    const draining = [...this.tasks.values()].filter(
      (controller) => controller.signal.aborted,
    ).length;
    return { active: this.tasks.size - draining, draining, limit: this.limit };
  }
}
