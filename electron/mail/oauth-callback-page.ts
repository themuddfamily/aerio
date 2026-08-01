import type { ServerResponse } from 'node:http'

export const OAUTH_CALLBACK_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
} as const

type CallbackKind = 'success' | 'denied' | 'invalid-state' | 'not-found'
type CallbackProvider = 'Google' | 'Microsoft'

interface CallbackPageOptions {
  kind: CallbackKind
  provider?: CallbackProvider
}

const content = ({ kind, provider }: CallbackPageOptions) => {
  if (kind === 'success') return {
    tone: 'success',
    eyebrow: `${provider} sign-in`,
    title: 'You’re all set',
    summary: 'Authorization received',
    detail: 'Aerio is finishing the connection securely in the desktop app.',
    footnote: 'You can safely close this tab and return to Aerio.'
  }
  if (kind === 'denied') return {
    tone: 'error',
    eyebrow: `${provider} sign-in`,
    title: 'Connection not completed',
    summary: 'Aerio wasn’t authorized',
    detail: 'No account was connected. Return to Aerio when you’re ready to try again.',
    footnote: 'You can safely close this tab.'
  }
  if (kind === 'invalid-state') return {
    tone: 'error',
    eyebrow: 'Sign-in protection',
    title: 'This request couldn’t be verified',
    summary: 'The sign-in session didn’t match',
    detail: 'Aerio stopped the connection to protect your account. Start sign-in again from the desktop app.',
    footnote: 'You can safely close this tab.'
  }
  return {
    tone: 'neutral',
    eyebrow: 'Aerio',
    title: 'Nothing to see here',
    summary: 'This local page is only used during sign-in',
    detail: 'Return to Aerio to connect an account.',
    footnote: 'You can safely close this tab.'
  }
}

export function oauthCallbackPage(options: CallbackPageOptions) {
  const copy = content(options)
  const icon = copy.tone === 'success'
    ? '<path d="m7.5 12.4 3 3L17 8.8"/>'
    : copy.tone === 'error'
      ? '<path d="M12 8.2v4.5m0 3.1h.01"/>'
      : '<path d="M12 8.5v3.8m0 3.3h.01"/>'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${copy.title} — Aerio</title>
  <style>
    :root{color-scheme:light;--bg:#f0f1f6;--surface:rgba(255,255,255,.9);--text:#242531;--soft:#5d6070;--line:rgba(71,68,108,.13);--accent:#6558e8;--accent-2:#438f78;--success:#217451;--success-bg:#edf8f3;--error:#b52f43;--error-bg:#fff1f3;--neutral:#6257c7;--neutral-bg:#f0eeff;--shadow:0 28px 90px rgba(31,29,59,.16),0 4px 18px rgba(31,29,59,.07)}
    *{box-sizing:border-box}
    html,body{min-height:100%;margin:0}
    body{display:grid;place-items:center;padding:32px 20px;color:var(--text);background:radial-gradient(circle at 16% 8%,rgba(101,88,232,.17),transparent 32rem),radial-gradient(circle at 88% 88%,rgba(67,143,120,.14),transparent 28rem),var(--bg);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-rendering:optimizeLegibility}
    .shell{width:min(100%,560px)}
    .brand{display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 20px;color:var(--soft);font-size:15px;font-weight:700;letter-spacing:-.02em}
    .brand-mark{width:34px;height:34px;display:grid;place-items:center;border-radius:11px;color:#fff;background:linear-gradient(145deg,#786bf8,#5245d6);box-shadow:0 8px 20px rgba(82,69,214,.28);font-size:19px;font-weight:800}
    main{position:relative;overflow:hidden;padding:48px 46px 40px;border:1px solid var(--line);border-radius:24px;background:var(--surface);box-shadow:var(--shadow);text-align:center;backdrop-filter:blur(18px)}
    main:before{content:"";position:absolute;inset:0 0 auto;height:4px;background:linear-gradient(90deg,var(--accent),var(--accent-2))}
    .status-icon{width:66px;height:66px;display:grid;place-items:center;margin:0 auto 27px;border-radius:20px}
    .status-icon svg{width:34px;height:34px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
    .success .status-icon{color:var(--success);background:var(--success-bg)}
    .error .status-icon{color:var(--error);background:var(--error-bg)}
    .neutral .status-icon{color:var(--neutral);background:var(--neutral-bg)}
    .eyebrow{margin:0 0 9px;color:var(--accent);font-size:11px;font-weight:780;letter-spacing:.13em;text-transform:uppercase}
    h1{margin:0;color:var(--text);font-size:clamp(30px,7vw,40px);font-weight:720;letter-spacing:-.045em;line-height:1.08}
    .lead{max-width:410px;margin:17px auto 28px;color:var(--soft);font-size:16px;line-height:1.6}
    .result{display:flex;align-items:flex-start;gap:13px;padding:16px 17px;border:1px solid var(--line);border-radius:14px;background:rgba(247,247,250,.78);text-align:left}
    .dot{width:9px;height:9px;flex:0 0 auto;margin-top:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px currentColor}
    .success .dot{color:rgba(33,116,81,.13);background:var(--success)}
    .error .dot{color:rgba(181,47,67,.12);background:var(--error)}
    .neutral .dot{color:rgba(101,88,232,.12);background:var(--neutral)}
    .result strong{display:block;margin-bottom:4px;color:var(--text);font-size:13px}
    .result span:last-child{color:var(--soft);font-size:12.5px;line-height:1.5}
    .footnote{margin:28px 0 0;color:var(--soft);font-size:13px;line-height:1.55}
    .shortcut{display:inline-flex;align-items:center;gap:6px;margin-top:14px;color:var(--soft);font-size:11px}
    kbd{min-width:26px;padding:4px 7px;border:1px solid var(--line);border-bottom-width:2px;border-radius:6px;background:rgba(255,255,255,.65);font:600 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
    footer{margin-top:18px;color:var(--soft);font-size:10.5px;text-align:center;opacity:.78}
    @media(max-width:520px){body{padding:18px 12px}.brand{margin-bottom:14px}main{padding:38px 22px 30px;border-radius:20px}.status-icon{width:58px;height:58px;margin-bottom:23px}.lead{font-size:15px}.shortcut{display:none}}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#17181e;--surface:rgba(32,33,38,.93);--text:#f1f1f5;--soft:#b6b8c3;--line:rgba(220,218,244,.13);--accent:#a99fff;--success:#66c79d;--success-bg:#203b32;--error:#ff8993;--error-bg:#44282d;--neutral:#b6afff;--neutral-bg:#353047;--shadow:0 28px 90px rgba(0,0,0,.42),0 4px 18px rgba(0,0,0,.28)}.result{background:rgba(42,43,51,.82)}kbd{background:rgba(23,24,30,.72)}}
  </style>
</head>
<body>
  <div class="shell">
    <div class="brand"><span class="brand-mark" aria-hidden="true">a</span><span>aerio</span></div>
    <main class="${copy.tone}" aria-labelledby="callback-title">
      <div class="status-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></div>
      <p class="eyebrow">${copy.eyebrow}</p>
      <h1 id="callback-title">${copy.title}</h1>
      <p class="lead">${copy.footnote}</p>
      <div class="result" role="status"><span class="dot" aria-hidden="true"></span><span><strong>${copy.summary}</strong>${copy.detail}</span></div>
      <p class="footnote">Return to the Aerio desktop app to continue.</p>
      <span class="shortcut" aria-label="Press Control W or Command W to close this tab"><kbd>Ctrl</kbd><span>+</span><kbd>W</kbd><span>or</span><kbd>⌘</kbd><span>+</span><kbd>W</kbd></span>
    </main>
    <footer>Secure local sign-in callback · No account details are shown here</footer>
  </div>
</body>
</html>`
}

export function sendOAuthCallbackPage(response: ServerResponse, statusCode: number, options: CallbackPageOptions) {
  response.writeHead(statusCode, OAUTH_CALLBACK_HEADERS).end(oauthCallbackPage(options))
}
