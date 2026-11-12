import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// No browser-supplied method or params ever reach this client directly.
export const ALLOWED = new Set(['initialize', 'thread/start', 'thread/list', 'thread/resume', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt']);
export class Rpc extends EventEmitter {
  child = spawn('qiri', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
  serial = 0;
  pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  ready: Promise<any>;
  constructor() {
    super();
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const x = JSON.parse(line);
        if (x.method) this.emit('message', x);
        else {
          const p = this.pending.get(x.id);
          if (p) { clearTimeout(p.timer); this.pending.delete(x.id); x.error ? p.reject(new Error(x.error.message)) : p.resolve(x.result); }
        }
      } catch { this.emit('protocolError', new Error('Invalid app-server JSON')); }
    });
    this.child.on('error', () => this.fail(new Error('Unable to start qiri app-server')));
    this.child.on('exit', () => this.fail(new Error('qiri app-server exited')));
    this.ready = this.call('initialize', { clientInfo: { name: 'qiri_web', version: '0.1.0' }, capabilities: { experimentalApi: true } }).then(() => this.write({ method: 'initialized', params: {} }));
  }
  fail(e: Error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); this.emit('offline', e); }
  write(x: any) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(x) + '\n'); }
  call(method: string, params: any): Promise<any> {
    if (!ALLOWED.has(method)) return Promise.reject(new Error('RPC method not allowed'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('app-server request timeout')); }, 60_000);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  reply(id: string | number, result: any) { this.write({ id, result }); }
  close() { this.child.kill('SIGTERM'); }
}
