import { RequestTaskManager, TaskError } from "../src/modules/requestLifecycle";

/** The client owns this timer. The server manager only receives its cancellation signal. */
export function runWithClientDeadline<T>(
  manager: RequestTaskManager,
  session: string,
  id: string | number,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const caller = new AbortController();
  const timer = setTimeout(
    () => caller.abort(new TaskError(-32001, "Client request timed out")),
    timeoutMs,
  );
  return manager
    .run(session, id, operation, caller.signal)
    .finally(() => clearTimeout(timer));
}
