import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import v8 from 'node:v8';
import { app, crashReporter } from 'electron';

import { ensurePrivateDir, FILE_MODE, getLogDir } from '../server/paths.js';

/**
 * A record of the desktop app's main process, which also hosts the server and the
 * agent connections. A packaged app's stdout goes nowhere, so without this a crash
 * leaves nothing behind to explain it. Console output, uncaught errors, child
 * process deaths and a memory sample every 10 minutes go to <app dir>/logs/main.log,
 * rotated to main.1.log past 5 MB. Writes are synchronous so the lines just before
 * a native abort are on disk. Native crashes also leave a local minidump (never
 * uploaded) in Electron's crashDumps folder.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const MEMORY_SAMPLE_MS = 10 * 60 * 1000;

let file = '';
let fd: number | null = null;
let size = 0;

function open(): void {
  fd = fs.openSync(file, 'a', FILE_MODE);
  size = fs.fstatSync(fd).size;
}

function write(level: string, text: string): void {
  if (fd === null) return;
  const line = `${new Date().toISOString()} ${level} ${text}\n`;
  try {
    if (size > MAX_BYTES) {
      fs.closeSync(fd);
      fs.renameSync(file, path.join(path.dirname(file), 'main.1.log'));
      open();
    }
    size += fs.writeSync(fd, line);
  } catch {
    // Logging must never take the app down
  }
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;

function logMemory(): void {
  const m = process.memoryUsage();
  write(
    'MEM ',
    `rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} ` +
      `heapLimit=${mb(v8.getHeapStatistics().heap_size_limit)} ` +
      `external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)} systemFree=${mb(os.freemem())}`,
  );
}

/** Call once, before anything else logs. Must run before app 'ready' for the crash reporter. */
export function startMainLog(): void {
  crashReporter.start({ uploadToServer: false });
  try {
    const dir = getLogDir();
    ensurePrivateDir(dir);
    file = path.join(dir, 'main.log');
    open();
  } catch (err: any) {
    console.warn(`[main-log] Could not open the main process log: ${err.message}`);
    return;
  }

  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERR ']] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      write(level, util.format(...args));
      original(...args);
    };
  }

  // Monitors only: they observe without changing what Electron does with the error
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    write('ERR ', `${origin}: ${err?.stack ?? err}`);
  });
  process.on('warning', (warning) => {
    write('WARN', warning.stack ?? `${warning.name}: ${warning.message}`);
  });
  app.on('child-process-gone', (_e, details) => {
    write('ERR ', `child process gone: ${details.type}${details.name ? ` (${details.name})` : ''} ${details.reason} exitCode=${details.exitCode}`);
  });
  app.on('render-process-gone', (_e, _contents, details) => {
    write('ERR ', `renderer gone: ${details.reason} exitCode=${details.exitCode}`);
  });

  write(
    'INFO',
    `CodePit ${app.getVersion()} started: pid=${process.pid} electron=${process.versions.electron} ` +
      `node=${process.versions.node} crashDumps=${app.getPath('crashDumps')}`,
  );
  logMemory();
  setInterval(logMemory, MEMORY_SAMPLE_MS).unref();
}

/** The last line of a run that ended on purpose; a run without one crashed or was killed. */
export function logMainExit(reason: string): void {
  write('INFO', `exiting: ${reason}`);
}
