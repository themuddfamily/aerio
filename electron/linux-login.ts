import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

const ownership = 'X-Aerio-Autostart=com.aerio.desktop'

export interface LinuxLoginOptions {
  home: string
  configHome?: string
  executable: string
  appImage?: string
}

// Desktop Exec values undergo both string unescaping and argument unquoting.
// Never invoke a shell or point startup at an AppImage's temporary mount.
export function linuxLoginEntry(options: LinuxLoginOptions): string {
  const executable = options.appImage || options.executable
  if (!isAbsolute(executable) || /[\x00-\x1f\x7f=]/.test(executable)) throw new Error('Aerio startup requires a valid absolute executable path')
  const quoted = executable.replace(/([\\"`$])/g, '\\$1').replace(/\\/g, '\\\\').replace(/%/g, '%%')
  // GLib validates argv[0] before expanding %% field escapes. Keep the
  // executable fixed and pass Aerio's absolute path to env as an argument.
  return `[Desktop Entry]\nType=Application\nName=Aerio\nExec=/usr/bin/env "${quoted}" --aerio-login\nIcon=aerio\nTerminal=false\nStartupWMClass=aerio\n${ownership}\n`
}

export function setLinuxLoginItem(enabled: boolean, options: LinuxLoginOptions): void {
  if (!isAbsolute(options.home)) throw new Error('Aerio startup requires an absolute home directory')
  const config = options.configHome && isAbsolute(options.configHome) ? options.configHome : join(options.home, '.config')
  const directory = join(config, 'autostart')
  const target = join(directory, 'aerio.desktop')
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) {
    throw new Error('Aerio will not modify a linked or invalid autostart directory')
  }
  let present = false
  try {
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8_192 ||
        !readFileSync(target, 'utf8').split(/\r?\n/).includes(ownership)) {
      throw new Error('Aerio will not replace an autostart entry it does not own')
    }
    present = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!enabled) {
    if (present) unlinkSync(target)
    return
  }
  const content = linuxLoginEntry(options)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.aerio-${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    try { writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor) } finally { closeSync(descriptor) }
    renameSync(temporary, target)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
