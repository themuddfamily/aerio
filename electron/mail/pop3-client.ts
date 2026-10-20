import { createHash } from 'node:crypto'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import type { Pop3AuthMethod, Pop3Security } from '../../src/pop3-types'
import { openProxyTunnel } from '../network-proxy-tunnel'

// A small POP3 client (RFC 1939, CAPA/RFC 2449, STLS/RFC 2595, AUTH/RFC 5034)
// built on node:net and node:tls. It exposes only what Aerio's download model
// needs: STAT, UIDL, LIST, RETR, DELE, RSET, NOOP and QUIT.

export type Pop3ErrorKind = 'auth' | 'tls' | 'connection' | 'timeout' | 'protocol' | 'unsupported' | 'command' | 'too-large' | 'in-use'

export class Pop3Error extends Error {
  constructor(readonly kind: Pop3ErrorKind, message: string) {
    super(message)
    this.name = 'Pop3Error'
  }
}

export interface Pop3ClientOptions {
  host: string
  port: number
  security: Pop3Security
  /** Must be true before Aerio connects without encryption. */
  allowPlaintext?: boolean
  username: string
  password: string
  auth?: Pop3AuthMethod
  /** Idle timeout for connecting and for each server response. */
  timeoutMs?: number
  /** Extra TLS options. Tests pass the CA of a disposable certificate; nothing disables verification. */
  tls?: Pick<ConnectionOptions, 'ca'>
}

export const POP3_DEFAULT_TIMEOUT_MS = 30_000
/** Longest single response line accepted (UIDL/LIST lines are tiny; message lines rarely exceed this). */
const MAX_LINE_BYTES = 1024 * 1024
const CRLF = Buffer.from('\r\n')

const TLS_CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_REVOKED', 'CERT_UNTRUSTED'
])

function describeSocketError(error: NodeJS.ErrnoException, host: string, port: number) {
  const code = error.code ?? ''
  if (TLS_CERTIFICATE_CODES.has(code)) return new Pop3Error('tls', `The POP3 server's TLS certificate is not trusted (${code}). Nothing was sent to the server.`)
  if (/SSL|TLS|EPROTO|wrong version|packet length/i.test(`${code} ${error.message}`)) return new Pop3Error('tls', `TLS negotiation with ${host}:${port} failed. Check that the port and security setting match the server (995 for TLS, 110 for STARTTLS).`)
  if (code === 'ECONNREFUSED') return new Pop3Error('connection', `${host}:${port} refused the POP3 connection`)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Pop3Error('connection', `The POP3 server ${host} could not be found`)
  return new Pop3Error('connection', `The POP3 connection to ${host}:${port} failed: ${error.message}`)
}

/** RFC 2449 response codes in brackets after -ERR. */
function responseCode(text: string) {
  return /^\[([A-Z/-]+)\]/i.exec(text)?.[1]?.toUpperCase()
}

/** RFC 1939: a unique-id is 1 to 70 characters in the range 0x21 to 0x7E. */
export function validUidl(value: string) {
  return /^[\x21-\x7e]{1,70}$/.test(value)
}

export class Pop3Session {
  private socket: Socket | TLSSocket
  private buffer: Buffer = Buffer.alloc(0)
  private failure?: Pop3Error
  private waiter?: () => void
  private closed = false
  private readonly timeoutMs: number
  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    this.waiter?.()
  }
  private readonly onError = (error: Error) => {
    this.failure ??= describeSocketError(error as NodeJS.ErrnoException, this.options.host, this.options.port)
    this.waiter?.()
  }
  private readonly onClose = () => {
    this.failure ??= new Pop3Error('connection', 'The POP3 server closed the connection')
    this.closed = true
    this.waiter?.()
  }

  capabilities: string[] = []
  authMethod: Exclude<Pop3AuthMethod, 'auto'> = 'user'
  encrypted = false

  private constructor(private readonly options: Pop3ClientOptions, socket: Socket | TLSSocket) {
    this.timeoutMs = options.timeoutMs ?? POP3_DEFAULT_TIMEOUT_MS
    this.socket = socket
    this.attach(socket)
  }

  /** Connects, negotiates TLS and authenticates. The password is never sent unencrypted unless plaintext was explicitly allowed. */
  static async open(options: Pop3ClientOptions) {
    if (options.security === 'none' && !options.allowPlaintext) {
      throw new Pop3Error('tls', 'Unencrypted POP3 is turned off for this account. Use TLS or STARTTLS, or explicitly allow an unencrypted connection.')
    }
    const socket = await Pop3Session.connectSocket(options)
    const session = new Pop3Session(options, socket)
    session.encrypted = options.security === 'tls'
    try {
      const greeting = await session.status()
      const timestamp = /<[^<>\s]+@[^<>\s]+>/.exec(greeting)?.[0]
      session.capabilities = await session.capa()
      if (options.security === 'starttls') {
        await session.startTls()
        session.capabilities = await session.capa()
      }
      await session.authenticate(timestamp)
      return session
    } catch (error) {
      session.close()
      if (error instanceof Pop3Error) throw error
      throw new Pop3Error('protocol', error instanceof Error ? error.message : String(error))
    }
  }

  private static async connectSocket(options: Pop3ClientOptions) {
    const timeoutMs = options.timeoutMs ?? POP3_DEFAULT_TIMEOUT_MS
    const tunnel = await openProxyTunnel(options.host, options.port, timeoutMs)
    if (tunnel && options.security !== 'tls') return tunnel
    return new Promise<Socket | TLSSocket>((resolve, reject) => {
      const socket: Socket | TLSSocket = options.security === 'tls'
        ? tlsConnect({ ...(tunnel ? { socket: tunnel } : { host: options.host, port: options.port }), ...(isIP(options.host) ? {} : { servername: options.host }), ...(options.tls ?? {}) })
        : netConnect({ host: options.host, port: options.port })
      const ready = options.security === 'tls' ? 'secureConnect' : 'connect'
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Pop3Error('timeout', `Connecting to ${options.host}:${options.port} timed out after ${Math.round(timeoutMs / 1000)} seconds`))
      }, timeoutMs)
      const fail = (error: Error) => {
        clearTimeout(timer)
        socket.destroy()
        reject(describeSocketError(error as NodeJS.ErrnoException, options.host, options.port))
      }
      socket.once('error', fail)
      socket.once(ready, () => {
        clearTimeout(timer)
        socket.removeListener('error', fail)
        resolve(socket)
      })
    })
  }

  private attach(socket: Socket | TLSSocket) {
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  private detach(socket: Socket | TLSSocket) {
    socket.removeListener('data', this.onData)
    socket.removeListener('error', this.onError)
    socket.removeListener('close', this.onClose)
  }

  private fail(error: Pop3Error): never {
    this.failure ??= error
    this.close()
    throw error
  }

  private waitForData() {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        this.failure ??= new Pop3Error('timeout', `The POP3 server did not respond within ${Math.round(this.timeoutMs / 1000)} seconds`)
        this.close()
        resolve()
      }, this.timeoutMs)
      this.waiter = () => {
        clearTimeout(timer)
        this.waiter = undefined
        resolve()
      }
    })
  }

  /** One response line without its line ending (CRLF, or a bare LF from lenient servers). */
  private async readLine(): Promise<Buffer> {
    while (true) {
      const index = this.buffer.indexOf(0x0a)
      if (index >= 0) {
        const end = index > 0 && this.buffer[index - 1] === 0x0d ? index - 1 : index
        const line = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(index + 1)
        return line
      }
      if (this.buffer.length > MAX_LINE_BYTES) this.fail(new Pop3Error('protocol', 'The POP3 server sent a response line longer than 1 MB'))
      if (this.failure) throw this.failure
      await this.waitForData()
    }
  }

  private write(line: string) {
    if (this.failure) throw this.failure
    this.socket.write(`${line}\r\n`)
  }

  /** Reads a +OK/-ERR status line and returns the text after +OK. */
  private async status() {
    const line = (await this.readLine()).toString('utf8')
    if (line === '+OK' || line.startsWith('+OK ')) return line.slice(4)
    if (line === '-ERR' || line.startsWith('-ERR ')) throw new Pop3Error('command', line.slice(5).trim() || 'The POP3 server reported an error')
    this.fail(new Pop3Error('protocol', 'The POP3 server sent an unexpected response'))
  }

  private async command(line: string) {
    this.write(line)
    return this.status()
  }

  /**
   * Reads a multi-line response body up to the terminating "." line and
   * removes dot-stuffing. Bytes are kept exactly; lines end in CRLF. When
   * `maxBytes` is exceeded the rest is read and discarded so the session
   * stays usable, then a `too-large` error is thrown.
   */
  private async multiLine(maxBytes = Number.POSITIVE_INFINITY) {
    const parts: Buffer[] = []
    let size = 0
    let overflow = false
    while (true) {
      let line = await this.readLine()
      if (line.length === 1 && line[0] === 0x2e) break
      if (line[0] === 0x2e) line = line.subarray(1)
      size += line.length + 2
      if (size > maxBytes) overflow = true
      if (!overflow) parts.push(line, CRLF)
    }
    if (overflow) throw new Pop3Error('too-large', `The message is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`)
    return Buffer.concat(parts)
  }

  private async capa() {
    try {
      await this.command('CAPA')
    } catch (error) {
      if (error instanceof Pop3Error && error.kind === 'command') return []
      throw error
    }
    return (await this.multiLine(64 * 1024)).toString('utf8').split('\r\n').map((line) => line.trim()).filter(Boolean)
  }

  private hasCapability(name: string) {
    return this.capabilities.some((line) => line.split(/\s+/)[0].toUpperCase() === name)
  }

  private saslMechanisms() {
    const line = this.capabilities.find((item) => item.split(/\s+/)[0].toUpperCase() === 'SASL')
    return line ? line.split(/\s+/).slice(1).map((value) => value.toUpperCase()) : []
  }

  private async startTls() {
    try {
      await this.command('STLS')
    } catch (error) {
      if (error instanceof Pop3Error && error.kind === 'command') this.fail(new Pop3Error('tls', 'The POP3 server does not offer STARTTLS (STLS). Your password was not sent.'))
      throw error
    }
    // Anything sent after +OK but before the handshake could be injected by an attacker.
    if (this.buffer.length) this.fail(new Pop3Error('tls', 'The POP3 server sent data before the TLS handshake. Your password was not sent.'))
    const plain = this.socket
    this.detach(plain)
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Pop3Error('timeout', 'The STARTTLS handshake timed out')) }, this.timeoutMs)
      const socket = tlsConnect({ socket: plain, ...(isIP(this.options.host) ? {} : { servername: this.options.host }), ...(this.options.tls ?? {}) })
      socket.once('error', (error) => {
        clearTimeout(timer)
        socket.destroy()
        reject(describeSocketError(error as NodeJS.ErrnoException, this.options.host, this.options.port))
      })
      socket.once('secureConnect', () => { clearTimeout(timer); socket.removeAllListeners('error'); resolve(socket) })
    }).catch((error: Pop3Error) => this.fail(error))
    this.socket = secure
    this.attach(secure)
    this.encrypted = true
  }

  private chooseAuth(timestamp: string | undefined): Exclude<Pop3AuthMethod, 'auto'> {
    const requested = this.options.auth ?? 'auto'
    const plain = this.saslMechanisms().includes('PLAIN')
    // Servers without CAPA predate it but still accept USER/PASS (RFC 1939).
    const user = !this.capabilities.length || this.hasCapability('USER')
    if (requested === 'plain') {
      if (!plain) throw new Pop3Error('unsupported', 'The POP3 server does not advertise AUTH PLAIN. Choose another sign-in method.')
      return 'plain'
    }
    if (requested === 'apop') {
      if (!timestamp) throw new Pop3Error('unsupported', 'The POP3 server does not support APOP. Choose another sign-in method.')
      return 'apop'
    }
    if (requested === 'user') return 'user'
    // On an unencrypted connection APOP avoids sending the password itself.
    if (!this.encrypted && timestamp) return 'apop'
    if (plain) return 'plain'
    if (user) return 'user'
    if (timestamp) return 'apop'
    return 'user'
  }

  private async authenticate(timestamp: string | undefined) {
    const method = this.chooseAuth(timestamp)
    this.authMethod = method
    const { username, password } = this.options
    try {
      if (method === 'apop') {
        const digest = createHash('md5').update(`${timestamp}${password}`).digest('hex')
        await this.command(`APOP ${username} ${digest}`)
      } else if (method === 'plain') {
        this.write('AUTH PLAIN')
        const line = (await this.readLine()).toString('utf8')
        if (line.startsWith('-ERR')) throw new Pop3Error('command', line.slice(5).trim())
        if (!line.startsWith('+')) this.fail(new Pop3Error('protocol', 'The POP3 server sent an unexpected AUTH response'))
        await this.command(Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64'))
      } else {
        await this.command(`USER ${username}`)
        await this.command(`PASS ${password}`)
      }
    } catch (error) {
      if (!(error instanceof Pop3Error) || error.kind !== 'command') throw error
      const code = responseCode(error.message)
      if (code === 'IN-USE') this.fail(new Pop3Error('in-use', 'The POP3 mailbox is in use by another session. Close other mail apps checking this account and try again.'))
      if (code === 'SYS/TEMP') this.fail(new Pop3Error('connection', `The POP3 server is temporarily unavailable: ${error.message}`))
      this.fail(new Pop3Error('auth', `Authentication failed: ${error.message.replace(/^\[[^\]]+\]\s*/, '') || 'the server rejected the username or password'}`))
    }
  }

  async stat() {
    const [count, bytes] = (await this.command('STAT')).split(/\s+/).map(Number)
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(bytes)) this.fail(new Pop3Error('protocol', 'The POP3 server sent an invalid STAT response'))
    return { count, bytes }
  }

  /** Message number → unique id for every message in the maildrop. */
  async uidl() {
    try {
      await this.command('UIDL')
    } catch (error) {
      if (error instanceof Pop3Error && error.kind === 'command') throw new Pop3Error('unsupported', 'The POP3 server does not support UIDL, which Aerio needs to download each message exactly once')
      throw error
    }
    const result = new Map<number, string>()
    const seen = new Set<string>()
    for (const line of (await this.multiLine(16 * 1024 * 1024)).toString('latin1').split('\r\n')) {
      if (!line) continue
      const [number, uidl] = line.trim().split(/\s+/)
      const index = Number(number)
      if (!Number.isSafeInteger(index) || index < 1 || !uidl || !validUidl(uidl)) this.fail(new Pop3Error('protocol', 'The POP3 server sent an invalid UIDL listing'))
      if (seen.has(uidl)) this.fail(new Pop3Error('protocol', 'The POP3 server listed the same UIDL for two messages, so messages cannot be told apart safely'))
      seen.add(uidl)
      result.set(index, uidl)
    }
    return result
  }

  /** Message number → size in octets. */
  async list() {
    await this.command('LIST')
    const result = new Map<number, number>()
    for (const line of (await this.multiLine(16 * 1024 * 1024)).toString('latin1').split('\r\n')) {
      if (!line) continue
      const [number, size] = line.trim().split(/\s+/).map(Number)
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(size)) this.fail(new Pop3Error('protocol', 'The POP3 server sent an invalid LIST response'))
      result.set(number, size)
    }
    return result
  }

  /** The message exactly as stored on the server, with dot-stuffing removed. */
  async retr(message: number, maxBytes?: number) {
    await this.command(`RETR ${message}`)
    return this.multiLine(maxBytes)
  }

  /** Marks a message for deletion; the server removes it only after a successful QUIT. */
  async dele(message: number) {
    await this.command(`DELE ${message}`)
  }

  async rset() {
    await this.command('RSET')
  }

  async noop() {
    await this.command('NOOP')
  }

  /**
   * Ends the session. Returns true when the server confirmed the UPDATE
   * state, which is when messages marked with DELE are actually removed.
   */
  async quit() {
    try {
      await this.command('QUIT')
      return true
    } catch (error) {
      if (error instanceof Pop3Error && error.kind === 'command') return false
      throw error
    } finally {
      this.close()
    }
  }

  get isOpen() {
    return !this.closed && !this.failure
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.socket.end()
    this.socket.destroy()
  }
}
