import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';
import { appEnv } from './env.js';
import { localhostAllowed } from './security.js';
import { getLanHostname } from './network.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// CODEPIT_DIST_DIR lets parallel UI builds each serve their own bundle.
const distOverride = appEnv('DIST_DIR');
const DIST_DIR = distOverride ? path.resolve(distOverride) : path.resolve(__dirname, '../dist');

const handle = await startServer({ staticDir: DIST_DIR });
const { port, lan } = handle;

console.log(`\n======================================================`);
console.log(`  🚀 CodePit server running:`);
console.log(`  👉 Local:   ${handle.url}`);
if (!localhostAllowed()) {
  console.log(`  🔒 Browsers on this computer are refused: CodePit opens only in the CodePit app.`);
  console.log(`     CODEPIT_LOCALHOST=1 allows them, for testing (npm run dev sets it).`);
}
const lanHostname = lan.enabled && lan.addresses.length > 0 ? getLanHostname() : null;
if (lanHostname) {
  console.log(`  👉 Network: http://${lanHostname}:${port}  (stays the same when the IP changes)`);
}
for (const ip of lan.addresses) {
  console.log(`  👉 Network: http://${ip}:${port}`);
}
for (const { address, error } of lan.errors) {
  console.log(`  ⚠️  Network: ${address} unavailable (${error})`);
}
if (!lan.enabled) {
  console.log(
    lan.lockedReason
      ? `  🔒 LAN access disabled (HOST=${lan.host}).`
      : `  🔒 LAN access off. Turn it on from the LAN access dialog, or start with CODEPIT_LAN=1.`
  );
}
if (lan.enabled) {
  console.log(`  🔑 New devices pair from LAN access on this computer (QR code or the code they show).`);
}
console.log(`======================================================\n`);

let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  console.log('\n[codepit] Shutting down...');
  // close() ends the agents first; don't let a stuck socket hold the process open
  void handle.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', exit);
process.on('SIGTERM', exit);
