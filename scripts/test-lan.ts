import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';

// Isolate test storage from the user's real ~/.codepit directory BEFORE any imports
const testAppDir = path.join(os.tmpdir(), `codepit-lan-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
// The shared token from before device pairing: startup must delete it
fs.mkdirSync(testAppDir, { recursive: true });
fs.writeFileSync(path.join(testAppDir, 'token'), 'old-shared-token');
// The runtime switch is what's under test; startup overrides would pin it
delete process.env.CODEPIT_LAN;
delete process.env.ACP_LAN;
delete process.env.HOST;

const { startServer } = await import('../server/server.js');
const { resolveStartupNetwork, getLocalNetworkIps } = await import('../server/network.js');
const { getSettingsFile } = await import('../server/paths.js');
const { localhostAllowed } = await import('../server/security.js');
const { devices, DEVICE_IDLE_MS, MAX_PENDING, MAX_PENDING_PER_IP } = await import('../server/devices.js');
const { WebSocket } = await import('ws');

interface Reply {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

/** http.request rather than fetch: fetch will not let a test set the Host header. */
function call(
  port: number,
  method: string,
  urlPath: string,
  opts: { host?: string; headers?: Record<string, string>; body?: unknown; address?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: opts.address ?? '127.0.0.1',
        port,
        method,
        path: urlPath,
        agent: false,
        headers: {
          host: opts.host ?? `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body: any = data;
          try {
            body = JSON.parse(data);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function expect(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

/** The codepit_device value from a reply's Set-Cookie, with its attributes. */
function deviceCookieOf(reply: Reply): { value: string; attrs: string } | null {
  for (const line of reply.headers['set-cookie'] ?? []) {
    const m = line.match(/^codepit_device=([^;]*)(.*)$/);
    if (m) return { value: m[1], attrs: m[2] };
  }
  return null;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms))]);

async function runTests() {
  console.log('🧪 [Test Suite] LAN access switch and device pairing\n');
  console.log(`📁 Using isolated test storage: ${testAppDir}\n`);

  // 1. Startup precedence: saved setting, then CODEPIT_LAN (or the older ACP_LAN), and HOST pins everything
  console.log('1️⃣ Resolving startup network settings...');
  expect(resolveStartupNetwork(false, {}).lanEnabled === false, 'LAN must default to off');
  expect(resolveStartupNetwork(true, {}).lanEnabled === true, 'Saved setting should turn LAN on');
  expect(resolveStartupNetwork(true, { CODEPIT_LAN: '0' }).lanEnabled === false, 'CODEPIT_LAN=0 should override the saved setting');
  expect(resolveStartupNetwork(true, { ACP_LAN: '0' }).lanEnabled === false, 'the older ACP_LAN=0 should still override the saved setting');
  expect(resolveStartupNetwork(false, { CODEPIT_LAN: '1', ACP_LAN: '0' }).lanEnabled === true, 'CODEPIT_LAN should win over ACP_LAN');
  expect(resolveStartupNetwork(false, { CODEPIT_LAN: '1' }).lanEnabled === true, 'CODEPIT_LAN=1 should override the saved setting');
  const pinned = resolveStartupNetwork(true, { HOST: '127.0.0.1', CODEPIT_LAN: '1' });
  expect(pinned.host === '127.0.0.1' && !pinned.lanEnabled && pinned.lockedReason, 'Explicit HOST must win and lock the switch');
  console.log('   ✅ Saved setting, CODEPIT_LAN and HOST applied in order\n');

  const APP_KEY = 'test-app-key-0123456789';
  const handle = await startServer({ port: 0, appKey: APP_KEY });
  const { port } = handle;
  const devicesFile = path.join(testAppDir, 'devices.json');
  const lanHost = `192.168.1.5:${port}`;
  /** A simulated LAN client at `ip`, optionally carrying a device cookie. */
  const lanAs = (ip: string, cookie?: string) => ({
    host: lanHost,
    headers: { 'x-test-remote-ip': ip, ...(cookie ? { cookie: `codepit_device=${cookie}` } : {}) },
  });
  const lan = lanAs('192.168.1.50');
  const openSockets: InstanceType<typeof WebSocket>[] = [];
  const openWs = (ip: string, cookie?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { host: lanHost, 'x-test-remote-ip': ip, ...(cookie ? { cookie: `codepit_device=${cookie}` } : {}) },
    });
    openSockets.push(ws);
    // A refused upgrade also emits an error; the tests look at the response instead
    ws.on('error', () => {});
    return ws;
  };
  const localWs = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    openSockets.push(ws);
    return ws;
  };
  /** Collects the WebSocket messages of one type. */
  const messagesOf = (ws: InstanceType<typeof WebSocket>, type: string) => {
    const got: any[] = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) got.push(msg);
    });
    return got;
  };
  /** Asks to pair from a simulated LAN address; the code path unless a ticket is given. */
  const requestPairing = (ip: string, body: Record<string, unknown> = {}) =>
    call(port, 'POST', '/api/pair/request', { ...lanAs(ip), headers: { ...lanAs(ip).headers, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }, body });
  const poll = (ip: string, id: string, secret: string) =>
    call(port, 'GET', `/api/pair/request/${id}?secret=${encodeURIComponent(secret)}`, lanAs(ip));
  /** Pairs a simulated device by code and returns its cookie and id. */
  const pairByCode = async (ip: string) => {
    const req = await requestPairing(ip);
    expect(req.status === 200, `Pair request from ${ip}: ${req.status} ${JSON.stringify(req.body)}`);
    const ok = await call(port, 'POST', '/api/pair/approve', { body: { code: req.body.code } });
    expect(ok.status === 200, `Approve by code: ${ok.status} ${JSON.stringify(ok.body)}`);
    const done = await poll(ip, req.body.requestId, req.body.pollSecret);
    const cookie = deviceCookieOf(done);
    expect(done.body.status === 'approved' && cookie, `Poll after approval should set the cookie: ${JSON.stringify(done.body)}`);
    return { cookie: cookie!.value, id: ok.body.device.id as string };
  };

  try {
    expect(!fs.existsSync(path.join(testAppDir, 'token')), 'The old shared token file must be deleted on startup');
    console.log('   ✅ Old shared token file removed on startup\n');

    // 2. Starts off, and the host machine may switch it
    console.log('2️⃣ Reading network info from loopback...');
    const initial = await call(port, 'GET', '/api/network');
    expect(initial.status === 200, `GET /api/network should be 200, got ${initial.status}`);
    expect(initial.body.lanEnabled === false && initial.body.ips.length === 0, 'LAN should start off with no addresses');
    expect(initial.body.canToggle === true, 'Loopback client should be allowed to toggle');
    expect(initial.body.token === undefined, 'Network info must not carry a token any more');
    console.log('   ✅ LAN off, loopback client can toggle\n');

    // 2b. The web app manifest (home-screen install): open to anyone, start link never signed
    console.log('2️⃣b Serving the web app manifest...');
    const plain = await call(port, 'GET', '/manifest.webmanifest', lan);
    expect(plain.status === 200 && plain.body.start_url === '/' && plain.body.display === 'standalone', `Manifest: ${plain.status} ${JSON.stringify(plain.body)}`);
    expect(plain.body.icons?.some((i: { sizes: string }) => i.sizes === '512x512'), 'Manifest should list a 512 px icon');
    const asked = await call(port, 'GET', '/manifest.webmanifest?token=anything', lan);
    expect(asked.body.start_url === '/', `The start link must not carry anything from the query: ${asked.body.start_url}`);
    console.log('   ✅ Manifest served with a plain start link\n');

    // 3. An unpaired LAN client gets nothing, the old shared token included
    console.log('3️⃣ Refusing unpaired LAN clients...');
    const unpaired = await call(port, 'GET', '/api/sessions', lan);
    expect(unpaired.status === 401, `Unpaired LAN request should be 401, got ${unpaired.status}`);
    const oldHeader = await call(port, 'GET', '/api/sessions', { ...lan, headers: { ...lan.headers, 'x-codepit-token': 'old-shared-token' } });
    const oldQuery = await call(port, 'GET', '/api/sessions?token=old-shared-token', lan);
    expect(oldHeader.status === 401 && oldQuery.status === 401, `The old token must not sign in: ${oldHeader.status} ${oldQuery.status}`);
    const forged = await call(port, 'GET', '/api/sessions', lanAs('192.168.1.50', 'not-a-real-device-credential'));
    expect(forged.status === 401, `A made-up cookie should be 401, got ${forged.status}`);
    const lanToggle = await call(port, 'POST', '/api/network/lan', { ...lan, headers: { ...lan.headers, origin: `http://${lanHost}` }, body: { enabled: true } });
    expect(lanToggle.status === 401, `Unpaired LAN toggle should be 401, got ${lanToggle.status}`);
    const rebinding = await call(port, 'POST', '/api/network/lan', { host: `evil.example:${port}`, body: { enabled: true } });
    expect(rebinding.status === 401, `Loopback client with a foreign Host should get no loopback trust, got ${rebinding.status}`);
    const crossOrigin = await call(port, 'POST', '/api/network/lan', { headers: { origin: 'http://evil.example' }, body: { enabled: true } });
    expect(crossOrigin.status === 403, `Cross-origin toggle should be 403, got ${crossOrigin.status}`);
    const unchanged = await call(port, 'GET', '/api/network');
    expect(unchanged.body.lanEnabled === false, 'Rejected toggles must not change the state');
    expect(!fs.existsSync(getSettingsFile()), 'Rejected toggles must not write the setting');
    const lanOffPair = await requestPairing('192.168.1.50');
    expect(lanOffPair.status === 409, `Pairing with LAN off should be 409, got ${lanOffPair.status}`);
    const hostPair = await call(port, 'POST', '/api/pair/request', { body: {} });
    expect(hostPair.status === 400, `The host itself should not pair, got ${hostPair.status}`);
    const unpairedWs = openWs('192.168.1.50');
    const wsRefused = await withTimeout(
      new Promise<number>((resolve) => unpairedWs.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))),
      2000,
      'unpaired WebSocket refusal'
    );
    expect(wsRefused === 401, `Unpaired WebSocket should be refused with 401, got ${wsRefused}`);
    console.log('   ✅ Unpaired, old-token, forged-cookie, rebinding and cross-origin requests rejected\n');

    // 3b. Only the CodePit app opens it on this machine; plain localhost is for testing
    console.log('3️⃣b Refusing browsers on this machine outside the app...');
    expect(localhostAllowed({ NODE_ENV: 'test' }) && !localhostAllowed({}), 'Localhost is allowed in tests only by default');
    expect(localhostAllowed({ CODEPIT_LOCALHOST: '1' }) && !localhostAllowed({ NODE_ENV: 'test', CODEPIT_LOCALHOST: '0' }), 'CODEPIT_LOCALHOST overrides');
    process.env.CODEPIT_LOCALHOST = '0';
    try {
      const app = { cookie: `codepit_app=${APP_KEY}` };
      const browser = await call(port, 'GET', '/api/sessions');
      expect(browser.status === 401 && browser.body.reason === 'use-app', `Browser on this machine should be 401 use-app: ${browser.status} ${JSON.stringify(browser.body)}`);
      const viaApp = await call(port, 'GET', '/api/network', { headers: app });
      expect(viaApp.status === 200 && viaApp.body.canToggle === true, `The app is the host: ${viaApp.status} ${JSON.stringify(viaApp.body)}`);
      expect((await call(port, 'GET', '/api/devices', { headers: app })).status === 200, 'The app may manage devices');
      const wrongKey = await call(port, 'GET', '/api/sessions', { headers: { cookie: 'codepit_app=guess' } });
      expect(wrongKey.status === 401, `A wrong app key should be 401, got ${wrongKey.status}`);
      const keyFromLan = await call(port, 'GET', '/api/sessions', { ...lan, headers: { ...lan.headers, ...app } });
      expect(keyFromLan.status === 401, `The app key is only good on loopback, got ${keyFromLan.status}`);
      const keyRebinding = await call(port, 'GET', '/api/sessions', { host: `evil.example:${port}`, headers: app });
      expect(keyRebinding.status === 401, `The app key must not help a rebinding Host, got ${keyRebinding.status}`);
      const browserPair = await call(port, 'POST', '/api/pair/request', { body: {} });
      expect(browserPair.status === 403 && browserPair.body.reason === 'use-app', `A browser on this machine cannot pair: ${browserPair.status}`);
      const browserToggle = await call(port, 'POST', '/api/network/lan', { body: { enabled: true } });
      expect(browserToggle.status === 401, `A browser on this machine cannot switch LAN, got ${browserToggle.status}`);
      const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      openSockets.push(browserWs);
      browserWs.on('error', () => {});
      const wsStatus = await withTimeout(
        new Promise<number>((resolve) => browserWs.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))),
        2000,
        'browser WebSocket refusal'
      );
      expect(wsStatus === 401, `A browser WebSocket on this machine should be 401, got ${wsStatus}`);
      const appWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: app });
      openSockets.push(appWs);
      await withTimeout(once(appWs, 'open'), 2000, 'app WebSocket');
      const page = await call(port, 'GET', '/manifest.webmanifest');
      expect(page.status === 200, 'Static files stay public, so the page can say to open the app');
    } finally {
      delete process.env.CODEPIT_LOCALHOST;
    }
    console.log('   ✅ Browser, wrong key, key from LAN or rebinding Host refused; the app key gets in and is the host\n');

    const bad = await call(port, 'POST', '/api/network/lan', { body: { enabled: 'yes' } });
    expect(bad.status === 400, `Non-boolean enabled should be 400, got ${bad.status}`);

    // 4. Turning it on from loopback binds the interfaces, persisted privately
    console.log('4️⃣ Turning LAN on from loopback...');
    const on = await call(port, 'POST', '/api/network/lan', { body: { enabled: true } });
    expect(on.status === 200 && on.body.lanEnabled === true, `Toggle on should succeed, got ${on.status} ${JSON.stringify(on.body)}`);
    const expected = getLocalNetworkIps();
    const reached = [...on.body.ips, ...on.body.lanErrors.map((e: { address: string }) => e.address)].sort();
    expect(JSON.stringify(reached) === JSON.stringify([...expected].sort()), `Every interface should be listening or reported: ${JSON.stringify(on.body)}`);
    const labelled: { address: string; label: string; url?: string }[] = on.body.lanInterfaces;
    expect(
      Array.isArray(labelled) && JSON.stringify(labelled.map((l) => l.address).sort()) === JSON.stringify([...on.body.ips].sort()),
      `lanInterfaces should list every listening address: ${JSON.stringify(labelled)}`
    );
    expect(labelled.every((l) => l.label && l.url === undefined), 'Labelled addresses carry a label and no sign-in link');
    const settings = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
    expect(settings.lanEnabled === true, 'Setting should be saved');
    expect((fs.statSync(getSettingsFile()).mode & 0o777) === 0o600, 'Settings file must be private (0600)');
    console.log(`   ✅ Listening on ${on.body.ips.join(', ') || '(no interfaces on this machine)'}, setting saved with mode 0600\n`);

    // 5. Code path: the device shows a code, the host types it, the poll hands over the cookie
    console.log('5️⃣ Pairing by code...');
    const hostWs = localWs();
    await once(hostWs, 'open');
    const hostHeard = messagesOf(hostWs, 'pairingRequest');
    const req = await requestPairing('192.168.1.50');
    expect(req.status === 200 && /^\d{6}$/.test(req.body.code) && req.body.pollSecret && req.body.viaTicket === false, `Pair request: ${JSON.stringify(req.body)}`);
    expect(req.body.name === 'iPhone · Safari', `Default name from the user agent: ${req.body.name}`);
    const pending = await poll('192.168.1.50', req.body.requestId, req.body.pollSecret);
    expect(pending.body.status === 'pending' && !deviceCookieOf(pending), `Poll before approval: ${JSON.stringify(pending.body)}`);
    const renamed = await call(port, 'PATCH', `/api/pair/request/${req.body.requestId}`, { ...lan, body: { secret: req.body.pollSecret, name: 'Test phone' } });
    expect(renamed.status === 200 && renamed.body.name === 'Test phone', `Device renames its request: ${JSON.stringify(renamed.body)}`);
    const wrongSecret = await poll('192.168.1.50', req.body.requestId, 'wrong');
    expect(wrongSecret.body.status === 'expired' && !deviceCookieOf(wrongSecret), 'A wrong poll secret must learn nothing');
    const list = await call(port, 'GET', '/api/devices');
    const listed = list.body.pending.find((r: any) => r.id === req.body.requestId);
    expect(listed && listed.name === 'Test phone' && listed.pollSecret === undefined, `Host sees the request, without its secret: ${JSON.stringify(list.body)}`);
    const byId = await call(port, 'POST', '/api/pair/approve', { body: { requestId: req.body.requestId } });
    expect(byId.status === 400, `A code-path request must not be approvable by id alone, got ${byId.status}`);
    const wrongCode = await call(port, 'POST', '/api/pair/approve', { body: { code: req.body.code === '000000' ? '000001' : '000000' } });
    expect(wrongCode.status === 404, `A wrong code should be 404, got ${wrongCode.status}`);
    const lanApprove = await call(port, 'POST', '/api/pair/approve', { ...lan, body: { code: req.body.code } });
    expect(lanApprove.status === 401, `An unpaired LAN client cannot approve, got ${lanApprove.status}`);
    const approved = await call(port, 'POST', '/api/pair/approve', { body: { code: `${req.body.code.slice(0, 3)} ${req.body.code.slice(3)}` } });
    expect(approved.status === 200 && approved.body.device.name === 'Test phone', `Approve by code: ${JSON.stringify(approved.body)}`);
    const done = await poll('192.168.1.50', req.body.requestId, req.body.pollSecret);
    const cookie = deviceCookieOf(done);
    expect(done.body.status === 'approved' && cookie, `Poll after approval: ${JSON.stringify(done.body)}`);
    expect(/HttpOnly/i.test(cookie!.attrs) && /SameSite=Strict/i.test(cookie!.attrs) && /Path=\//.test(cookie!.attrs) && /Max-Age=\d+/.test(cookie!.attrs), `Cookie attributes: ${cookie!.attrs}`);
    const again = await poll('192.168.1.50', req.body.requestId, req.body.pollSecret);
    expect(again.body.status === 'expired' && !deviceCookieOf(again), 'The credential is handed over once only');
    expect(hostHeard.length === 1 && hostHeard[0].request.id === req.body.requestId, `Host socket hears of the request: ${JSON.stringify(hostHeard)}`);
    expect(hostHeard[0].request.code === undefined && listed.code === undefined, 'The host is never sent the code; it must be typed in from the device');
    const stored = fs.readFileSync(devicesFile, 'utf8');
    expect(!stored.includes(cookie!.value), 'devices.json must not hold the credential itself');
    expect((fs.statSync(devicesFile).mode & 0o777) === 0o600, 'devices.json must be private (0600)');
    console.log('   ✅ Code shown, host approved, cookie set once (HttpOnly, SameSite=Strict), only its hash stored\n');

    // 6. The paired device can use the app, but not manage devices or LAN access
    console.log('6️⃣ Using the app as a paired device...');
    const phone = lanAs('192.168.1.50', cookie!.value);
    const sessions = await call(port, 'GET', '/api/sessions', phone);
    expect(sessions.status === 200, `Paired device API call should be 200, got ${sessions.status}`);
    const netInfo = await call(port, 'GET', '/api/network', phone);
    expect(netInfo.status === 200 && netInfo.body.canToggle === false, 'Paired device sees the switch as read-only');
    const self = await call(port, 'GET', '/api/devices/self', phone);
    expect(self.body.local === false && self.body.device?.name === 'Test phone' && self.body.device.tokenHash === undefined, `Self: ${JSON.stringify(self.body)}`);
    for (const [method, url, body] of [
      ['POST', '/api/network/lan', { enabled: false }],
      ['GET', '/api/devices', undefined],
      ['POST', '/api/pair/ticket', undefined],
      ['POST', '/api/pair/approve', { code: '123456' }],
      ['POST', '/api/pair/deny', { requestId: 'x' }],
      ['DELETE', `/api/devices/${approved.body.device.id}`, undefined],
      ['PATCH', `/api/devices/${approved.body.device.id}`, { name: 'mine now' }],
    ] as const) {
      const r = await call(port, method, url, { ...phone, body });
      expect(r.status === 403, `${method} ${url} from a paired LAN device should be 403, got ${r.status}`);
    }
    const phoneWs = openWs('192.168.1.50', cookie!.value);
    const phoneHeard = messagesOf(phoneWs, 'pairingRequest');
    await withTimeout(once(phoneWs, 'open'), 2000, 'paired device WebSocket');
    console.log('   ✅ API and WebSocket work with the cookie; switch, ticket, approve, deny, revoke and rename are 403\n');

    // 7. QR path: a single-use ticket, approvable with one click
    console.log('7️⃣ Pairing by QR ticket...');
    const lanTicket = await call(port, 'POST', '/api/pair/ticket', phone);
    expect(lanTicket.status === 403, 'Only the host can make a ticket');
    const ticket = await call(port, 'POST', '/api/pair/ticket');
    expect(ticket.status === 200 && ticket.body.ticket, `Ticket: ${JSON.stringify(ticket.body)}`);
    expect(
      ticket.body.lanInterfaces.every((l: { address: string; url: string }) => l.url === `http://${l.address}:${port}/?pair=${ticket.body.ticket}`),
      `Ticket links: ${JSON.stringify(ticket.body.lanInterfaces)}`
    );
    const viaQr = await requestPairing('192.168.1.51', { ticket: ticket.body.ticket });
    expect(viaQr.status === 200 && viaQr.body.viaTicket === true && !viaQr.body.ticketRejected, `Ticket request: ${JSON.stringify(viaQr.body)}`);
    const reused = await requestPairing('192.168.1.52', { ticket: ticket.body.ticket });
    expect(reused.status === 200 && reused.body.viaTicket === false && reused.body.ticketRejected === true, `A used ticket falls back to the code: ${JSON.stringify(reused.body)}`);
    const oneClick = await call(port, 'POST', '/api/pair/approve', { body: { requestId: viaQr.body.requestId } });
    expect(oneClick.status === 200, `Ticket request approvable by id: ${oneClick.status} ${JSON.stringify(oneClick.body)}`);
    const qrDone = await poll('192.168.1.51', viaQr.body.requestId, viaQr.body.pollSecret);
    const qrCookie = deviceCookieOf(qrDone);
    expect(qrDone.body.status === 'approved' && qrCookie, 'QR-paired device gets its cookie');
    expect(phoneHeard.length === 0, 'Paired LAN devices must not hear of pairing requests');
    console.log('   ✅ Ticket works once, approved with one click; LAN devices never hear of requests\n');

    // 8. Deny, and requests that run out
    console.log('8️⃣ Denying and expiring requests...');
    const denyLan = await call(port, 'POST', '/api/pair/deny', { ...lan, body: { requestId: reused.body.requestId } });
    expect(denyLan.status === 401, `Unpaired LAN client cannot deny, got ${denyLan.status}`);
    const denied = await call(port, 'POST', '/api/pair/deny', { body: { requestId: reused.body.requestId } });
    expect(denied.status === 200, `Deny: ${denied.status}`);
    const deniedPoll = await poll('192.168.1.52', reused.body.requestId, reused.body.pollSecret);
    expect(deniedPoll.body.status === 'denied' && !deviceCookieOf(deniedPoll), `Denied poll: ${JSON.stringify(deniedPoll.body)}`);
    const deniedApprove = await call(port, 'POST', '/api/pair/approve', { body: { code: reused.body.code } });
    expect(deniedApprove.status === 404, 'A denied request cannot be approved afterwards');
    const late = await requestPairing('192.168.1.53');
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      const expiredPoll = await poll('192.168.1.53', late.body.requestId, late.body.pollSecret);
      expect(expiredPoll.body.status === 'expired', `Poll after five minutes: ${JSON.stringify(expiredPoll.body)}`);
      const lateApprove = await call(port, 'POST', '/api/pair/approve', { body: { code: late.body.code } });
      expect(lateApprove.status === 404, 'An expired request cannot be approved');
    } finally {
      Date.now = realNow;
    }
    console.log('   ✅ Denied and expired requests end without a cookie\n');

    // 9. Caps on waiting requests, per address and overall
    console.log('9️⃣ Capping pending requests...');
    devices.cancelPairing();
    for (let i = 0; i < MAX_PENDING_PER_IP; i++) {
      expect((await requestPairing('192.168.1.60')).status === 200, `Request ${i + 1} from one address should pass`);
    }
    const perIp = await requestPairing('192.168.1.60');
    expect(perIp.status === 429, `Request ${MAX_PENDING_PER_IP + 1} from one address should be 429, got ${perIp.status}`);
    for (let i = MAX_PENDING_PER_IP; i < MAX_PENDING; i++) {
      expect((await requestPairing(`192.168.1.${70 + i}`)).status === 200, `Request ${i + 1} overall should pass`);
    }
    const overall = await requestPairing('192.168.1.99');
    expect(overall.status === 429, `Request ${MAX_PENDING + 1} overall should be 429, got ${overall.status}`);
    devices.cancelPairing();
    console.log(`   ✅ ${MAX_PENDING_PER_IP} per address, ${MAX_PENDING} overall\n`);

    // 10. Rename, revoke (live), forget, and sliding expiry
    console.log('🔟 Managing paired devices...');
    const rename = await call(port, 'PATCH', `/api/devices/${approved.body.device.id}`, { body: { name: '  Work   phone ' } });
    expect(rename.status === 200 && rename.body.device.name === 'Work phone', `Rename: ${JSON.stringify(rename.body)}`);
    const phoneClosed = withTimeout(
      new Promise<number>((resolve) => phoneWs.on('close', (code) => resolve(code))),
      2000,
      'revoked device WebSocket close'
    );
    const revoke = await call(port, 'DELETE', `/api/devices/${approved.body.device.id}`);
    expect(revoke.status === 200, `Revoke: ${revoke.status}`);
    expect((await phoneClosed) === 4401, 'Revoked device socket closes with 4401');
    const afterRevoke = await call(port, 'GET', '/api/sessions', phone);
    expect(afterRevoke.status === 401, `Revoked device should get 401, got ${afterRevoke.status}`);

    const tablet = lanAs('192.168.1.51', qrCookie!.value);
    const forget = await call(port, 'DELETE', '/api/devices/self', tablet);
    expect(forget.status === 200 && /codepit_device=;.*Max-Age=0/.test(String(forget.headers['set-cookie'])), `Forget clears the cookie: ${JSON.stringify(forget.headers['set-cookie'])}`);
    expect((await call(port, 'GET', '/api/sessions', tablet)).status === 401, 'A forgotten device is signed out');

    const laptop = await pairByCode('192.168.1.54');
    const backdate = (ms: number) => {
      const data = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
      for (const d of data.devices) if (d.id === laptop.id) d.lastSeenAt = Date.now() - ms;
      fs.writeFileSync(devicesFile, JSON.stringify(data));
      // Make sure the change is seen even within the file system's timestamp resolution
      const later = new Date(Date.now() + 5000 + Math.random() * 1000);
      fs.utimesSync(devicesFile, later, later);
    };
    backdate(2 * 60 * 60 * 1000);
    const refreshed = await call(port, 'GET', '/api/sessions', lanAs('192.168.1.54', laptop.cookie));
    expect(refreshed.status === 200 && deviceCookieOf(refreshed)?.value === laptop.cookie, 'A device in use gets its cookie sent again (sliding)');
    backdate(DEVICE_IDLE_MS + 60_000);
    const stale = await call(port, 'GET', '/api/sessions', lanAs('192.168.1.54', laptop.cookie));
    expect(stale.status === 401, `A device unused for 30 days should be 401, got ${stale.status}`);
    expect(!JSON.parse(fs.readFileSync(devicesFile, 'utf8')).devices.some((d: { id: string }) => d.id === laptop.id), 'The stale device is pruned from devices.json');
    console.log('   ✅ Renamed; revoke drops the socket at once; forget signs out; 30 idle days expire and prune\n');

    // 11. A real connection over a LAN interface, then LAN off
    const address: string | undefined = on.body.ips[0];
    if (address) {
      console.log('1️⃣1️⃣ Over a real interface...');
      const desk = await pairByCode('192.168.1.55');
      const deskCookie = { cookie: `codepit_device=${desk.cookie}` };
      const noCookie = await call(port, 'GET', '/api/sessions', { address, host: `${address}:${port}` });
      expect(noCookie.status === 401, `LAN request without a cookie should be 401, got ${noCookie.status}`);
      const withCookie = await call(port, 'GET', '/api/network', { address, host: `${address}:${port}`, headers: deskCookie });
      expect(withCookie.status === 200 && withCookie.body.canToggle === false, 'Real LAN request should work with the cookie and be read-only');
      const ws = new WebSocket(`ws://${address}:${port}/ws`, { headers: deskCookie });
      openSockets.push(ws);
      await once(ws, 'open');
      console.log(`   ✅ ${address} serves the API and WebSocket to a paired device\n`);

      console.log('1️⃣2️⃣ Turning LAN off...');
      const closed = once(ws, 'close');
      const off = await call(port, 'POST', '/api/network/lan', { body: { enabled: false } });
      expect(off.status === 200 && off.body.lanEnabled === false && off.body.ips.length === 0, 'Toggle off should succeed');
      await withTimeout(closed, 2000, 'LAN WebSocket survived LAN being turned off');
      const refused = await call(port, 'GET', '/api/network', { address, host: `${address}:${port}`, headers: deskCookie }).then(
        () => false,
        () => true
      );
      expect(refused, 'LAN address must refuse connections once LAN is off');
      console.log('   ✅ Open WebSocket dropped and the interface refuses new connections');
    } else {
      console.log('   ⚠️  No network interface on this machine, skipping the live LAN connection checks');
      const off = await call(port, 'POST', '/api/network/lan', { body: { enabled: false } });
      expect(off.status === 200 && off.body.lanEnabled === false, 'Toggle off should succeed');
    }
    expect(JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8')).lanEnabled === false, 'Off should be saved');
    expect((await call(port, 'GET', '/api/devices')).body.pending.length === 0, 'Turning LAN off cancels waiting requests');
    const local = await call(port, 'GET', '/api/network');
    expect(local.status === 200, 'Loopback listener must keep serving after LAN is turned off');
    console.log('   ✅ Setting saved, pending requests cancelled, loopback still served\n');

    console.log('🎉 ALL LAN TESTS PASSED!');
  } finally {
    for (const ws of openSockets) ws.terminate();
    await handle.close();
    fs.rmSync(testAppDir, { recursive: true, force: true });
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ LAN test suite failed:', err);
    process.exit(1);
  });
