import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
export { delay };
export async function untilExpired(expiresAt: number) { await delay(Math.max(0, expiresAt - Date.now()) + 40); }
export async function leaseChild(t: TestContext, path: string, ttl = 1000) {
  const child = fork(fileURLToPath(new URL('./lease-child.ts', import.meta.url)), [path, String(ttl)], {
    execArgv: ['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs', import.meta.url))],
    stdio: ['ignore','ignore','pipe','ipc'],
  });
  let serial = 0, runtimeInstanceId = '';
  const pending = new Map<number, { resolve(v: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let readyResolve!: () => void, readyReject!: (e: Error) => void, stageResolve!: (v: any) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const stage = new Promise<any>(resolve => { stageResolve = resolve; });
  const closed = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const startupTimer = setTimeout(() => readyReject(Error('Lease child startup timeout')), 10_000);
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  child.on('message', (message: any) => {
    if (message.ready) { clearTimeout(startupTimer); runtimeInstanceId = message.runtimeInstanceId; readyResolve(); }
    else if (message.stage) stageResolve(message.stage);
    else { const entry = pending.get(message.requestId); if (entry) { clearTimeout(entry.timer); pending.delete(message.requestId); entry.resolve(message); } }
  });
  child.on('error', readyReject);
  child.on('exit', () => {
    clearTimeout(startupTimer); readyReject(Error(`Lease child exited: ${stderr}`));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ exited: true }); }
    pending.clear();
  });
  const kill = async () => {
    // Linux SIGKILL and the portable Node forced termination path are named separately in tests.
    if (child.exitCode === null && child.signalCode === null) child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    await closed;
  };
  t.after(kill);
  await ready;
  return { child, runtimeInstanceId, stage, closed, kill,
    request(command: string, options: Record<string, unknown> = {}): Promise<any> {
      const requestId = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`Lease command timeout: ${command}`)); }, 10_000);
        pending.set(requestId, { resolve, reject, timer }); child.send({ requestId, command, ...options });
      });
    },
  };
}

/** Test harness waits for expiry; it never grants ownership or resumes a Workflow. */
export async function waitForLeaseAvailability(path: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const row = raw.prepare("SELECT expires_at FROM runtime_leases WHERE lease_state='ACTIVE'").get();
    if (row) await untilExpired(Number(row.expires_at));
  } finally { raw.close(); }
}
export const terminationName = process.platform === 'win32' ? 'Windows forced termination' : 'Linux SIGKILL';
export function terminateChild(child: import('node:child_process').ChildProcess): void {
  child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
}
