# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/ritwik-g/codepit/security/advisories/new)
rather than opening a public issue.

This is a personal project maintained in spare time. Expect an acknowledgement
within a week. There is no bounty.

## Trust model

- The server listens on `127.0.0.1` unless you turn on LAN access. On this
  machine only the CodePit app gets in. It mints a random key at each launch,
  hands it to its built-in server, and sends it as an HttpOnly cookie, so other
  users and programs reaching `127.0.0.1` are refused. `CODEPIT_LOCALHOST=1`
  lifts this for testing. Any other device must first be paired, and only the
  app can approve it: by a six-digit code read off the device, or with one
  click for a request made through a single-use QR code shown on this machine.
  Each paired device holds its own random credential in an HttpOnly,
  `SameSite=Strict` cookie. Only its SHA-256 is stored, in `~/.codepit/devices.json`
  (owner-only). A device unused for 30 days expires, and revoking one closes its
  open connections at once. Cross-origin requests are refused.
- The agents run as you, with your logins, in the folders you open. CodePit
  carries out the file reads, writes and terminal commands they ask for, so
  anything an agent could do in your terminal it can do here. Approvals and the
  approval mode are the control, as they are in each agent's own CLI.
- Credentials you enter (API keys, MCP secrets) are stored owner-only in
  `~/.codepit/` and masked in the API and the UI after saving.
- CodePit itself sends no telemetry. The network traffic is the agents talking to
  their vendors, MCP servers you configure, and usage lookups made through the
  agents' own CLIs.
