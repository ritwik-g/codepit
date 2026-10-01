import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, HttpError, isHostMachine, type PairingStart } from '../api';
import { Button, Field, Icon, Input, Spinner } from '../ui';

const POLL_MS = 2000;

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; request: PairingStart }
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'use-app' }
  | { kind: 'error'; message: string };

/** Launched from the home screen: such an app keeps its own cookies, so it pairs on its own. */
const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** The ?pair= ticket from the host's QR code, taken out of the address bar: it works once only. */
function takeTicket(): string | undefined {
  const url = new URL(window.location.href);
  const ticket = url.searchParams.get('pair') || undefined;
  if (ticket) {
    url.searchParams.delete('pair');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return ticket;
}

/**
 * Shown on a device that isn't paired (or was just revoked). It asks the host to
 * let it in, shows the code to type there, and polls until the host answers. On
 * approval the poll's reply sets the device cookie, and the page reloads signed in.
 */
export const PairScreen: React.FC = () => {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [name, setName] = useState('');
  const savedName = useRef('');
  // React's dev double-run of effects must not spend the single-use ticket twice
  const ticket = useRef<string | undefined | null>(null);

  const start = useCallback(() => {
    // This computer can't pair: only the CodePit app opens it here
    if (isHostMachine()) {
      setPhase({ kind: 'use-app' });
      return;
    }
    if (ticket.current === null) ticket.current = takeTicket();
    const t = ticket.current;
    ticket.current = undefined; // a retry asks by code
    setPhase({ kind: 'starting' });
    api
      .requestPairing({ ticket: t, standalone: isStandalone() })
      .then((request) => {
        setName(request.name);
        savedName.current = request.name;
        setPhase({ kind: 'waiting', request });
      })
      .catch((err) =>
        setPhase(
          err instanceof HttpError && err.reason === 'use-app'
            ? { kind: 'use-app' }
            : { kind: 'error', message: err.message || 'Could not reach the host' }
        )
      );
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start();
  }, [start]);

  const waiting = phase.kind === 'waiting' ? phase.request : null;
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      api
        .pollPairing(waiting.requestId, waiting.pollSecret)
        .then((res) => {
          if (stopped) return;
          if (res.status === 'approved') {
            setPhase({ kind: 'approved' });
            // The reply set the cookie; load the app with it, without the ?pair= link
            window.location.replace('/');
          } else if (res.status === 'denied' || res.status === 'expired') {
            setPhase({ kind: res.status });
          } else {
            timer = setTimeout(poll, POLL_MS);
          }
        })
        .catch((err) => {
          if (stopped) return;
          // A dropped poll (Wi-Fi blip) is retried; a refusal ends the wait
          if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
            setPhase({ kind: 'error', message: err.message });
          } else {
            timer = setTimeout(poll, POLL_MS);
          }
        });
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waiting]);

  const saveName = () => {
    const next = name.trim();
    if (!waiting || !next || next === savedName.current) return;
    api.renamePairingRequest(waiting.requestId, waiting.pollSecret, next).then(
      (res) => {
        savedName.current = res.name;
        setName(res.name);
      },
      () => setName(savedName.current)
    );
  };

  const retry = (
    <Button variant="primary" size="lg" block icon="refresh" onClick={start}>
      Try again
    </Button>
  );

  return (
    <div className="auth-screen">
      <div className="auth-card pair-card">
        <span className="auth-icon" aria-hidden>
          <Icon name="lock" size={20} />
        </span>
        <h1 className="auth-title">{phase.kind === 'use-app' ? 'Open the CodePit app' : 'Pair this device'}</h1>

        {phase.kind === 'use-app' && (
          <p className="auth-desc">
            On the computer running CodePit, it opens only in the CodePit app, not in a browser. This keeps other
            programs and users on this computer out. To use a browser while testing, start the server with{' '}
            <code>CODEPIT_LOCALHOST=1</code>.
          </p>
        )}

        {phase.kind === 'starting' && (
          <p className="auth-desc pair-status">
            <Spinner size={13} /> Asking the host…
          </p>
        )}

        {waiting && (
          <>
            <p className="auth-desc">
              {waiting.viaTicket ? (
                <>Approve this device on the host computer to finish.</>
              ) : (
                <>
                  On the computer running CodePit, open <strong>LAN access</strong> and enter this code.
                  {waiting.ticketRejected && ' The QR code had already been used or had expired, so pair with the code instead.'}
                </>
              )}
            </p>
            <div className="pair-code" aria-label={`Pairing code ${waiting.code.split('').join(' ')}`}>
              {waiting.code.slice(0, 3)}
              <span className="pair-code-gap" aria-hidden />
              {waiting.code.slice(3)}
            </div>
            <p className="auth-desc pair-status" role="status">
              <Spinner size={13} /> Waiting for approval on the host…
            </p>
            <Field label="Device name" htmlFor="pair-name" hint="How this device shows up in the host's device list.">
              <Input
                id="pair-name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              />
            </Field>
          </>
        )}

        {phase.kind === 'approved' && (
          <p className="auth-desc pair-status">
            <Spinner size={13} /> Approved. Opening CodePit…
          </p>
        )}

        {phase.kind === 'denied' && (
          <>
            <p className="auth-desc">The host turned this device down.</p>
            {retry}
          </>
        )}

        {phase.kind === 'expired' && (
          <>
            <p className="auth-desc">The request ran out before the host answered. Codes last five minutes.</p>
            {retry}
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p className="auth-desc">{phase.message}</p>
            {retry}
          </>
        )}

        {phase.kind !== 'use-app' && (
          <p className="auth-foot">
            Opened from <code>{window.location.host}</code>. Only the CodePit app on the host computer can let devices
            in.
          </p>
        )}
      </div>
    </div>
  );
};
