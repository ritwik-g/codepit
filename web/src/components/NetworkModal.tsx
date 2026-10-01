import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  api,
  type LanInterface,
  type NetworkInfo,
  type PairedDevice,
  type PairingRequestInfo,
  type PairingTicket,
} from '../api';
import { makeQr, type QrShape } from '../qr';
import { Modal } from './Modal';
import { relativeTime } from './Sidebar';
import { Badge, Button, Card, Icon, IconButton, Input, Segmented, Spinner, Switch, type IconName, type Tone } from '../ui';

interface NetworkModalProps {
  onClose: () => void;
  /** Bumped by App when the server says devices or pairing requests changed. */
  devicesVersion?: number;
}

const Callout: React.FC<{
  tone: Tone;
  icon: IconName;
  title: string;
  children: React.ReactNode;
}> = ({ tone, icon, title, children }) => (
  <div className={`net-callout tone-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
    <Icon name={icon} size={16} className="net-callout-icon" />
    <div>
      <div className="net-callout-title">{title}</div>
      <div className="net-callout-body">{children}</div>
    </div>
  </div>
);

/** Networks a phone on the same Wi-Fi usually can't reach. */
const isUnlikelyReachable = (link: LanInterface) => link.kind === 'virtual' || link.kind === 'vpn';

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ts: number) => (relativeTime(ts) === 'now' ? 'just now' : `${relativeTime(ts)} ago`);

/** Two physical ports can share a label ("Ethernet"); the interface name tells them apart. */
const labelFor = (links: LanInterface[]) => (link: LanInterface) =>
  link.name && links.filter((l) => l.label === link.label).length > 1 ? `${link.label} (${link.name})` : link.label;

/**
 * A pairing link as a QR code, generated in the browser. Always dark on
 * light with a quiet zone, whatever the theme: phone scanners expect that.
 */
const QrCode: React.FC<{ url: string; label: string }> = ({ url, label }) => {
  const [shape, setShape] = useState<QrShape | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setShape(null);
    setError(null);
    makeQr(url).then(
      (s) => !cancelled && setShape(s),
      (err) => !cancelled && setError(err?.message || 'Could not draw the QR code')
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="net-qr-code" role="img" aria-label={label}>
      {shape ? (
        <svg viewBox={`0 0 ${shape.size} ${shape.size}`} shapeRendering="crispEdges" aria-hidden>
          <rect width={shape.size} height={shape.size} fill="#ffffff" />
          <path d={shape.path} fill="#000000" />
        </svg>
      ) : error ? (
        <span className="net-qr-status">{error}</span>
      ) : (
        <Spinner size={16} />
      )}
    </div>
  );
};

/** One paired device: rename in place, or revoke after a second click. */
const DeviceRow: React.FC<{ device: PairedDevice; onChanged: () => void }> = ({ device, onChanged }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (p: Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    p.then(
      () => {
        after?.();
        onChanged();
      },
      (err) => setError(err.message || 'That did not work')
    ).finally(() => setBusy(false));
  };

  const saveName = () => {
    const next = name.trim();
    if (!next || next === device.name) {
      setName(device.name);
      setEditing(false);
      return;
    }
    run(api.renameDevice(device.id, next), () => setEditing(false));
  };

  const daysLeft = Math.max(0, Math.ceil((device.expiresAt - Date.now()) / DAY_MS));

  return (
    <div className="net-device">
      <Icon name="monitor" size={15} className="net-row-icon" />
      <div className="net-device-main">
        {editing ? (
          <Input
            value={name}
            maxLength={60}
            autoFocus
            aria-label="Device name"
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(device.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <div className="net-device-name">{device.name}</div>
        )}
        <div className="net-device-meta">
          Last used {ago(device.lastSeenAt)}
          {device.lastIp && <> from {device.lastIp}</>} · access ends in {daysLeft} {daysLeft === 1 ? 'day' : 'days'} if
          unused
        </div>
        {error && <div className="net-device-error">{error}</div>}
      </div>
      {confirming ? (
        <>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => run(api.revokeDevice(device.id))}>
            Revoke
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <IconButton icon="edit" label="Rename" size="sm" disabled={busy || editing} onClick={() => setEditing(true)} />
          <IconButton icon="trash" label={`Revoke ${device.name}`} size="sm" disabled={busy} onClick={() => setConfirming(true)} />
        </>
      )}
    </div>
  );
};

/**
 * The host's side of pairing: a QR code with a one-time ticket, a box for the
 * code a device shows, devices waiting for an answer, and the paired devices.
 */
const PairDevices: React.FC<{ devicesVersion?: number }> = ({ devicesVersion }) => {
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [qrAddress, setQrAddress] = useState<string | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pending, setPending] = useState<PairingRequestInfo[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeResult, setCodeResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const ticketIssuedAt = useRef(0);

  const issueTicket = useCallback(() => {
    setTicketError(null);
    ticketIssuedAt.current = Date.now();
    api.createPairingTicket().then(setTicket, (err) => setTicketError(err.message || 'Could not make a QR code'));
  }, []);

  const loadDevices = useCallback(() => {
    api.getDevices().then(
      (res) => {
        setDevices(res.devices);
        setPending(res.pending);
        setListError(null);
        // Someone opened the QR link: it is spent, so show a fresh one for the next device
        if (res.pending.some((r) => r.viaTicket && r.createdAt >= ticketIssuedAt.current)) issueTicket();
      },
      (err) => setListError(err.message || 'Could not load devices')
    );
  }, [issueTicket]);

  useEffect(issueTicket, [issueTicket]);

  // A ticket lasts five minutes; swap it for a new one just before it runs out
  useEffect(() => {
    if (!ticket) return;
    const timer = setTimeout(issueTicket, Math.max(1000, ticket.expiresAt - Date.now() - 5000));
    return () => clearTimeout(timer);
  }, [ticket, issueTicket]);

  // Reload on every change the server reports, and now and then for requests that ran out
  useEffect(loadDevices, [loadDevices, devicesVersion]);
  useEffect(() => {
    const timer = setInterval(loadDevices, 10_000);
    return () => clearInterval(timer);
  }, [loadDevices]);

  const approveCode = (e: React.FormEvent) => {
    e.preventDefault();
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) return;
    setCodeBusy(true);
    setCodeResult(null);
    api
      .approvePairing({ code: digits })
      .then(
        (res) => {
          setCode('');
          setCodeResult({ ok: true, text: `${res.device.name} can now connect.` });
          loadDevices();
        },
        (err) => setCodeResult({ ok: false, text: err.message || 'That code did not match' })
      )
      .finally(() => setCodeBusy(false));
  };

  const answer = (p: Promise<unknown>) => {
    setActionError(null);
    p.then(loadDevices, (err) => {
      setActionError(err.message || 'That did not work');
      loadDevices();
    });
  };

  const links = ticket?.lanInterfaces ?? [];
  const qrLink = links.find((l) => l.address === qrAddress) ?? links[0];
  const linkLabel = labelFor(links);

  return (
    <>
      {pending.length > 0 && (
        <section className="net-section">
          <div className="net-label">Waiting for you</div>
          <div className="net-rows">
            {pending.map((r) => (
              <div key={r.id} className="net-device is-pending">
                <Icon name="bell" size={15} className="net-row-icon" />
                <div className="net-device-main">
                  <div className="net-device-name">{r.name}</div>
                  <div className="net-device-meta">
                    {r.ip} · {r.viaTicket ? 'opened your QR code' : 'type the code it shows below to allow it'}
                  </div>
                </div>
                {r.viaTicket && (
                  <Button size="sm" variant="primary" icon="check" onClick={() => answer(api.approvePairing({ requestId: r.id }))}>
                    Allow
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => answer(api.denyPairing(r.id))}>
                  Deny
                </Button>
              </div>
            ))}
          </div>
          {actionError && <p className="net-device-error">{actionError}</p>}
        </section>
      )}

      <section className="net-section">
        <div className="net-label">Pair a device</div>
        {ticketError ? (
          <Callout tone="danger" icon="alert" title="Could not make a QR code">
            {ticketError}.{' '}
            <Button size="sm" variant="secondary" icon="refresh" onClick={issueTicket}>
              Try again
            </Button>
          </Callout>
        ) : (
          <div className="net-qr">
            {qrLink ? (
              <QrCode url={qrLink.url} label={`QR code to pair a device over ${qrLink.label}, ${qrLink.address}`} />
            ) : (
              <div className="net-qr-code">
                <Spinner size={16} />
              </div>
            )}
            <div className="net-qr-side">
              <div className="net-qr-title">Scan with the device's camera</div>
              <p className="net-hint">
                The device must be on the same network; you then allow it here. Each code works once, and a new one
                appears on its own.
              </p>
              {qrLink && links.length > 1 && links.length <= 3 && (
                <Segmented
                  label="Network to connect over"
                  size="sm"
                  block
                  value={qrLink.address}
                  onChange={setQrAddress}
                  options={links.map((l) => ({ value: l.address, label: linkLabel(l), title: l.address }))}
                />
              )}
              {qrLink && links.length > 3 && (
                <select
                  className="net-qr-select"
                  aria-label="Network to connect over"
                  value={qrLink.address}
                  onChange={(e) => setQrAddress(e.target.value)}
                >
                  {links.map((l) => (
                    <option key={l.address} value={l.address}>
                      {linkLabel(l)}: {l.address}
                    </option>
                  ))}
                </select>
              )}
              {qrLink && (
                <div className="net-qr-address">
                  <Badge tone={isUnlikelyReachable(qrLink) ? 'neutral' : 'accent'}>{linkLabel(qrLink)}</Badge>
                  <code>{qrLink.address}</code>
                </div>
              )}
              {qrLink && isUnlikelyReachable(qrLink) && (
                <p className="net-qr-warn">
                  <Icon name="alert" size={13} />
                  <span>
                    Phones usually can't reach a {qrLink.kind === 'vpn' ? 'VPN' : 'virtual machine'} address. Pick your
                    Wi-Fi or Ethernet link if the phone can't connect.
                  </span>
                </p>
              )}
            </div>
          </div>
        )}

        <form className="net-code-form" onSubmit={approveCode}>
          <label className="net-hint" htmlFor="net-pair-code">
            Or open one of the addresses below on the device, and type the code it shows:
          </label>
          <div className="net-code-row">
            <Input
              id="net-pair-code"
              mono
              inputMode="numeric"
              autoComplete="off"
              placeholder="123 456"
              maxLength={7}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setCodeResult(null);
              }}
            />
            <Button type="submit" variant="secondary" disabled={codeBusy || code.replace(/\D/g, '').length !== 6}>
              Allow
            </Button>
          </div>
          {codeResult && <p className={codeResult.ok ? 'net-code-ok' : 'net-device-error'}>{codeResult.text}</p>}
        </form>
      </section>

      <section className="net-section">
        <div className="net-label">Paired devices</div>
        {listError ? (
          <p className="net-device-error">{listError}</p>
        ) : devices.length === 0 ? (
          <p className="net-hint">None yet. Only this computer can connect until you pair a device.</p>
        ) : (
          <div className="net-rows">
            {devices.map((d) => (
              <DeviceRow key={`${d.id}:${d.name}`} device={d} onChanged={loadDevices} />
            ))}
          </div>
        )}
        <p className="net-hint">A device unused for 30 days has to pair again. Revoking one disconnects it at once.</p>
      </section>
    </>
  );
};

/** What a paired device sees: which device it is, and a way to sign itself out. */
const ThisDevice: React.FC<{ device: PairedDevice | null | undefined }> = ({ device }) => {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = () => {
    setError(null);
    api.forgetSelfDevice().then(
      () => window.location.replace('/'),
      (err) => setError(err.message || 'Could not forget this device')
    );
  };

  return (
    <section className="net-section">
      <div className="net-label">This device</div>
      <div className="net-device">
        <Icon name="monitor" size={15} className="net-row-icon" />
        <div className="net-device-main">
          <div className="net-device-name">{device?.name ?? 'Paired device'}</div>
          {device && (
            <div className="net-device-meta">Paired {ago(device.createdAt)}. Unused for 30 days, it has to pair again.</div>
          )}
        </div>
        {confirming ? (
          <>
            <Button size="sm" variant="danger" onClick={forget}>
              Forget
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" icon="logout" onClick={() => setConfirming(true)}>
            Forget this device
          </Button>
        )}
      </div>
      {error && <p className="net-device-error">{error}</p>}
      <p className="net-hint">Only the computer running CodePit can pair, rename or revoke devices.</p>
    </section>
  );
};

export const NetworkModal: React.FC<NetworkModalProps> = ({ onClose, devicesVersion }) => {
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [self, setSelf] = useState<{ local: boolean; device?: PairedDevice | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Promise.all([api.getNetworkInfo(), api.getSelfDevice()])
      .then(([info, me]) => {
        setNetworkInfo(info);
        setSelf(me);
      })
      .catch((err) => setLoadError(err.message || 'Failed to load network info'))
      .finally(() => setLoading(false));
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(key);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), 2000);
      },
      () => setCopied(null)
    );
  };

  const setLan = (enabled: boolean) => {
    setSwitching(true);
    setSwitchError(null);
    api
      .setLanAccess(enabled)
      .then(setNetworkInfo)
      .catch((err) => setSwitchError(err.message || 'Failed to change LAN access'))
      .finally(() => setSwitching(false));
  };

  const isHost = self?.local === true;

  // Why the switch is read-only, if it is: HOST pins the bind address, or this
  // page is open on another device, which must not be able to change who connects.
  const switchNote = networkInfo?.lockedReason
    ? networkInfo.lockedReason
    : networkInfo && !networkInfo.canToggle
      ? 'Only the computer running CodePit can turn this on or off.'
      : networkInfo?.lanEnabled
        ? 'Devices you pair below can connect. Turning this off disconnects them; they stay paired.'
        : 'Only this computer can connect. Takes effect right away, no restart needed.';

  const links = networkInfo?.lanInterfaces ?? [];
  const linkLabel = labelFor(links);

  return (
    <Modal
      onClose={onClose}
      heading="LAN access"
      description="Open this workspace from a phone, tablet or another computer on your network."
      icon="wifi"
      size="md"
      className="net-modal"
      bodyClassName="net-body"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {loading ? (
        <div className="net-loading">
          <Spinner size={14} /> Looking up network interfaces…
        </div>
      ) : loadError ? (
        <Callout tone="danger" icon="alert" title="Could not load network info">
          {loadError}. Check that the server is still running, then reopen this dialog.
        </Callout>
      ) : !networkInfo ? null : (
        <>
          <Card padding="sm">
            <Switch
              checked={networkInfo.lanEnabled}
              onChange={setLan}
              disabled={!networkInfo.canToggle || switching}
              label={
                <span className="net-switch-label">
                  Allow devices on your network
                  {switching && <Spinner size={12} />}
                </span>
              }
              description={switchNote}
            />
          </Card>

          {switchError && (
            <Callout tone="danger" icon="alert" title="Could not change LAN access">
              {switchError}.
            </Callout>
          )}

          {!isHost && <ThisDevice device={self?.device} />}

          {isHost && networkInfo.lanEnabled && networkInfo.lanErrors.length > 0 && (
            <Callout tone="warn" icon="alert" title="Some network interfaces are not reachable">
              <ul className="net-error-list">
                {networkInfo.lanErrors.map((e) => (
                  <li key={e.address}>
                    <code>{e.address}</code>: {e.error}
                  </li>
                ))}
              </ul>
              Reopen this dialog to try again.
            </Callout>
          )}

          {isHost && networkInfo.lanEnabled && networkInfo.ips.length === 0 && networkInfo.lanErrors.length === 0 && (
            <Callout tone="danger" icon="wifi" title="No local network found">
              This computer has no active network interface. Connect it to Wi-Fi or Ethernet, then reopen this dialog.
            </Callout>
          )}

          {isHost && networkInfo.lanEnabled && networkInfo.ips.length > 0 && (
            <>
              <PairDevices devicesVersion={devicesVersion} />

              <section className="net-section">
                <div className="net-label">Addresses</div>
                <div className="net-rows">
                  {links.map((link) => {
                    const url = `http://${link.address}:${networkInfo.port}`;
                    return (
                      <div key={link.address} className="net-row">
                        <Badge tone={isUnlikelyReachable(link) ? 'neutral' : 'accent'}>{linkLabel(link)}</Badge>
                        <code className="net-value" title={url}>
                          {url}
                        </code>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={copied === link.address ? 'check' : 'copy'}
                          onClick={() => copy(url, link.address)}
                        >
                          {copied === link.address ? 'Copied' : 'Copy'}
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <p className="net-hint">
                  A new device that opens an address shows a pairing code. Pairing holds for the address it was made on;
                  switching to another address means pairing again.
                </p>
              </section>

              <section className="net-section net-tips">
                <div className="net-label">If a device can't connect</div>
                <ul className="net-tip-list">
                  <li>
                    <Icon name="wifi" size={13} />
                    <span>Both devices must be on the same Wi-Fi network or router.</span>
                  </li>
                  <li>
                    <Icon name="shield" size={13} />
                    <span>
                      If your firewall asks whether the app may accept incoming connections, choose <strong>Allow</strong>.
                    </span>
                  </li>
                  <li>
                    <Icon name="lock" size={13} />
                    <span>A device that was revoked, or went unused for 30 days, shows a new code. Pair it again.</span>
                  </li>
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </Modal>
  );
};
