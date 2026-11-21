import type { Store } from '@olcys/db';
import { beginRun, type EngineDeps } from './run';

export interface SchedulerOptions {
  store: Store;
  /** Engine dependencies for a case's set of sources. */
  depsFor(sources: string): EngineDeps;
  /** How often to look for due cases. */
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Repeats analyses on their schedule. Runs inside the application: no external job service is needed.
 * A case is never analysed twice at once; a slot missed while the application was down is made up once.
 */
export function startScheduler(opts: SchedulerOptions) {
  let busy = false;
  const tick = async (): Promise<string[]> => {
    if (busy) return [];
    busy = true;
    const started: string[] = [];
    try {
      for (const due of await opts.store.dueSchedules()) {
        if (await opts.store.hasRunningRun(due.case_id)) continue; // still working: try again on the next tick
        await opts.store.bumpSchedule(due.case_id, due.every_seconds);
        const run = await beginRun(opts.depsFor(due.sources), due.case_id, {}, 'schedule');
        run.done.catch((err) => opts.log?.(`scheduled run ${run.runId} failed: ${err instanceof Error ? err.message : err}`));
        started.push(run.runId);
      }
    } catch (err) {
      opts.log?.(`scheduler: ${err instanceof Error ? err.message : err}`);
    } finally {
      busy = false;
    }
    return started;
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 5000);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
