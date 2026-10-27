import { Worker } from 'node:worker_threads';

export interface SandboxLimits {
  timeoutMs?: number;
  memoryBytes?: number;
  maxOutput?: number;
}

/**
 * Runs JavaScript written by the model in an isolated QuickJS/WebAssembly engine on a worker thread
 * with no environment. QuickJS stops the guest at the deadline; if that ever fails, the worker is
 * terminated a little later.
 */
export function runJs(code: string, limits: SandboxLimits = {}): Promise<string> {
  const timeoutMs = limits.timeoutMs ?? 5000;
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: { code, timeoutMs, memoryBytes: limits.memoryBytes ?? 64 * 1024 * 1024, maxOutput: limits.maxOutput ?? 8000 },
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    stdout: true,
    stderr: true,
  });
  return new Promise((resolve) => {
    let settled = false;
    const done = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      void worker.terminate();
      resolve(text);
    };
    const kill = setTimeout(() => done(`Stopped: the code ran longer than ${timeoutMs / 1000}s.`), timeoutMs + 3000);
    worker.once('message', (m: string) =>
      done(m.replace(/Threw InternalError: interrupted/, `Stopped: the code ran longer than ${timeoutMs / 1000}s.`)));
    worker.once('error', (err: Error) => done(`Error: ${err.message}`));
    worker.once('exit', (codeNum) => done(`Error: the sandbox stopped unexpectedly (exit ${codeNum}).`));
  });
}
