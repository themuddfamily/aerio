export function updateSupport(input: { packaged: boolean; platform: NodeJS.Platform; portable: boolean }) {
  if (!input.packaged) return { supported: false, reason: 'Updates are available in installed release builds.' }
  if (input.platform !== 'win32') return { supported: false, reason: 'Automatic updates are currently configured for Windows.' }
  if (input.portable) return { supported: false, reason: 'Portable builds do not install updates automatically. Download the next portable version from GitHub.' }
  return { supported: true }
}
