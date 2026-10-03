import { execFile } from 'node:child_process'

type Probe = () => Promise<string>
const queryHost: Probe = () => new Promise((resolve, reject) => {
  execFile('gdbus', ['call', '--session', '--dest', 'org.kde.StatusNotifierWatcher', '--object-path', '/StatusNotifierWatcher',
    '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered'],
  { timeout: 1_000, maxBuffer: 1_024, encoding: 'utf8', windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
})

// A constructed Tray does not establish that Linux has a reachable tray host.
// Missing D-Bus/tools, malformed replies and unsupported desktops all fall back
// to a taskbar window; no subprocess is allowed to hang a close action.
export async function linuxTrayHostAvailable(probe: Probe = queryHost): Promise<boolean> {
  try { return /^\s*\(<true>,\)\s*$/.test(await probe()) } catch { return false }
}
