# Authenticated network proxies

Open **Settings → Network proxy**. Choose **System / environment settings**, **Direct connection**, or **Manual HTTP(S) proxy**. A manual server is an origin such as `http://proxy.example.com:8080` or `https://proxy.example.com:8443`. Put the optional username and password in their separate fields; credentials embedded in the server URL are rejected. HTTP CONNECT proxies must permit the destination ports used by IMAP, SMTP and POP3.

**Save proxy settings**, then quit and reopen Aerio. The saved route is applied before provider networking begins in the main process and mail worker, and to default and subsequently created Chromium sessions. Existing connections keep their current configuration until restart. Settings displays a pending restart notice. Every application profile has its own proxy settings.

| Connection | Manual proxy coverage |
| --- | --- |
| Node fetch and default Node HTTP/HTTPS agents | Gmail, Microsoft Graph, OAuth HTTP, AI, CalDAV/CardDAV, subscriptions, cloud services, tasks and hosted meetings share the configured route. |
| Exchange EWS / Autodiscover | The transport's custom keep-alive agents receive the same proxy environment, retaining connection-bound authentication and TLS certificate checks. |
| IMAP and SMTP | ImapFlow and Nodemailer receive the authenticated proxy URL; TLS and STARTTLS still validate the destination server. |
| POP3 | A bounded HTTP(S) CONNECT handshake opens the TCP tunnel, then ordinary TLS/STARTTLS and POP3 authentication proceed. |
| Browser sessions | Chromium session proxy configuration plus an authentication callback restricted to the exact configured proxy host and port. Origin authentication challenges never receive proxy credentials. |
| Main-process remote image/favicon requests | Authenticated manual requests use the Node transport because Chromium `net.fetch` has no per-request login callback. Their existing URL, redirect and image checks still apply. |

System mode uses the operating system's proxy settings for Chromium and standard proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) for Node HTTP. IMAP, SMTP and POP3 use direct connections in system mode; choose a manual proxy to route those protocols. Node does not import the operating system's PAC script. Direct mode explicitly disables proxying for covered connections. External applications opened by Aerio, OS browser sign-in windows, native LDAP directory traffic and external helpers retain their own network settings.

Bypass entries are comma-separated exact hostnames, IPv4 addresses or `*.domain` patterns. A wildcard suffix matches subdomains, not the bare domain; enter both when needed. Loopback (`localhost`, `127.*`, `::1`) always bypasses, preserving local OAuth callbacks and local services. CIDR ranges, bypass ports, SOCKS, manual PAC and NTLM/Kerberos proxy credentials are not supported by this shared configuration. Basic username/password authentication works across the covered transports. HTTPS proxy connections and destination TLS use normal certificate verification; no certificate checks are disabled.

The username and password are encrypted together using Electron OS secure storage inside `network-proxy.json`; neither is returned by settings/status IPC, placed in environment variables, or passed to the renderer or browser authentication challenges for another host. New credentials require OS encryption; an unauthenticated proxy can be saved without it. Leaving both fields empty keeps existing credentials only for the same manual endpoint. Changing the endpoint, selecting another mode, or **Remove saved proxy credentials** clears them. The settings file is outside the profile-backup allowlist. It is not portable to a different OS account. Malformed settings, unreadable credentials or proxy setup failures stop startup with an explanation rather than falling back to a direct route; repair or remove the profile's `network-proxy.json` before restarting if necessary.

Verification:

- `electron/network-proxy-store.test.ts`: validation, encrypted persistence, redacted status, endpoint credential isolation and failure behavior.
- `electron/network-proxy-routing.test.ts`: actual authenticated local proxy with Node fetch/HTTP, verified HTTPS CONNECT, custom agents, real IMAP/SMTP STARTTLS, POP3, bypass and rejected credentials.
- `electron/network-proxy.test.ts`, `src/components/ProxySettings.test.tsx`, `electron/preload.test.ts`: startup/session/auth restrictions, settings IPC, lock enforcement, editing and restart notices.
- `node scripts/desktop-network-proxy-audit.mjs`: hidden native Electron audit using the production store/runtime, OS encryption, authenticated main HTTP and a new browser session. It creates an isolated disposable profile and never uses real accounts.

Implementation follows the official [Node proxy API](https://nodejs.org/download/release/v24.17.0/docs/api/http.html#httpsetglobalproxyfromenvproxyenv), [Electron session proxy configuration](https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig), [Electron proxy authentication event](https://www.electronjs.org/docs/latest/api/app#event-login), [ImapFlow options](https://imapflow.com/docs/api/imapflow-client/), and [Nodemailer proxy support](https://nodemailer.com/smtp/proxies). The packaged Electron runtime provides Node 24.21; the dynamic Node proxy API requires Node 24.14 or newer.
