/**
 * Runs untrusted JavaScript inside QuickJS compiled to WebAssembly. The guest gets no host APIs: no
 * require/import, process, files, network, environment or timers; only a console that returns text.
 * Executed in a worker thread (see run.ts), so a runaway guest can be killed without touching Robert.
 */
import { parentPort, workerData } from 'node:worker_threads';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';

const { code, timeoutMs, memoryBytes, maxOutput } = workerData as { code: string; timeoutMs: number; memoryBytes: number; maxOutput: number };

const qjs = await newQuickJSWASMModuleFromVariant(variant as unknown as Parameters<typeof newQuickJSWASMModuleFromVariant>[0]);
const rt = qjs.newRuntime();
rt.setMemoryLimit(memoryBytes);
rt.setMaxStackSize(1024 * 1024);
rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
const vm = rt.newContext();

let out = '';
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)) ?? String(v));
const print = vm.newFunction('log', (...args) => {
  if (out.length < maxOutput) out += args.map((a) => show(vm.dump(a))).join(' ') + '\n';
});
const consoleObj = vm.newObject();
for (const k of ['log', 'info', 'warn', 'error']) vm.setProp(consoleObj, k, print);
vm.setProp(vm.global, 'console', consoleObj);
consoleObj.dispose();
print.dispose();

const describe = (h: Parameters<typeof vm.dump>[0]) => {
  const e = vm.dump(h) as { name?: string; message?: string } | string;
  return typeof e === 'object' && e ? `${e.name ?? 'Error'}: ${e.message ?? ''}` : String(e);
};

let result = '';
try {
  const r = vm.evalCode(code, 'snippet.js');
  if (r.error) {
    result = `Threw ${describe(r.error)}`;
    r.error.dispose();
  } else {
    // Settle promises (async code), then read the value; non-promises come back as they are.
    rt.executePendingJobs();
    const state = vm.getPromiseState(r.value);
    if (state.type === 'fulfilled') {
      const v = vm.dump(state.value);
      if (v !== undefined) result = `Result: ${show(v)}`;
      if (!state.notAPromise) state.value.dispose();
    } else if (state.type === 'rejected') {
      result = `Threw ${describe(state.error)}`;
      state.error.dispose();
    } else {
      result = 'Result: a promise that never settled (timers and I/O are not available)';
    }
    r.value.dispose();
  }
} catch (err) {
  result = `Threw ${(err as Error).message}`;
}
vm.dispose();
rt.dispose();

if (out.length > maxOutput) out = `${out.slice(0, maxOutput)}\n…(output truncated)`;
parentPort!.postMessage([out.trimEnd() && `Output:\n${out.trimEnd()}`, result].filter(Boolean).join('\n') || '(no output; use console.log)');
