import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminateChild } from './lease-fixture.ts';

export interface ProcessResult { code: number | null; signal: string | null; stderr: string; timedOut: boolean; messages: unknown[] }
export function reconciliationChild(args: string[]): ChildProcess {
  return fork(fileURLToPath(new URL('./reconciliation-process-child.ts', import.meta.url)), args, {
    execArgv: ['--experimental-transform-types', '--loader', fileURLToPath(new URL('./ts-loader.mjs', import.meta.url))],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}
export function processResult(child: ChildProcess, timeoutMs = 20_000): Promise<ProcessResult> {
  let stderr = '', timedOut = false;
  const messages: unknown[] = [];
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.on('message', message => messages.push(message));
  const timeout = setTimeout(() => { timedOut = true; terminateChild(child); }, timeoutMs);
  return new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stderr, timedOut, messages }); });
  });
}
export function ready(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Reconciliation child readiness timeout')), timeoutMs);
    child.on('message', (message: { ready?: boolean }) => { if (message.ready) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(Error(`Reconciliation child exited before readiness: ${code}/${signal}`)); });
  });
}
