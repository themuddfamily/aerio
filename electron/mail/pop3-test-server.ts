import { createHash } from 'node:crypto'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { TLSSocket, createServer as createTlsServer } from 'node:tls'

// A disposable POP3 server for tests only. It binds to 127.0.0.1 on an
// operating-system-assigned port, keeps its maildrop in memory, and can inject
// the failures the download model must survive. It is never packaged or used
// outside the test suite.

export interface FakePop3Message {
  uidl: string
  raw: Buffer | string
}

export interface FakePop3Options {
  /** 'tls' is implicit TLS; 'plain' listens unencrypted and offers STLS unless `stls` is false. */
  mode: 'tls' | 'plain'
  certificate?: { key: string; cert: string }
  users?: Record<string, string>
  messages?: FakePop3Message[]
  stls?: boolean
  capa?: boolean
  uidl?: boolean
  /** Include an APOP timestamp in the greeting. */
  apop?: boolean
  sasl?: string[]
  /** Advertise USER in CAPA. */
  user?: boolean
}

export interface FakePop3Failures {
  /** Close the connection halfway through sending this message (once). */
  dropDuringRetr?: string
  /** Answer RETR for this message with -ERR. */
  errorOnRetr?: string
  /** Stop answering after this command (the client times out). */
  silentAfter?: string
  /** Reject login with [IN-USE]. */
  inUse?: boolean
  /** Close the connection instead of answering QUIT, so deletions are rolled back. */
  dropOnQuit?: boolean
}

interface StoredMessage {
  uidl: string
  raw: Buffer
}

const toCrlf = (raw: Buffer | string) => Buffer.from(Buffer.from(raw).toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1')

export class FakePop3Server {
  readonly maildrop: StoredMessage[]
  readonly commands: string[] = []
  readonly failures: FakePop3Failures = {}
  sessions = 0
  completedQuits = 0
  private server?: Server
  private readonly sockets = new Set<Socket>()

  constructor(private readonly options: FakePop3Options) {
    this.maildrop = (options.messages ?? []).map((message) => ({ uidl: message.uidl, raw: toCrlf(message.raw) }))
  }

  get port() {
    return (this.server?.address() as AddressInfo).port
  }

  add(message: FakePop3Message) {
    this.maildrop.push({ uidl: message.uidl, raw: toCrlf(message.raw) })
  }

  uidls() {
    return this.maildrop.map((message) => message.uidl)
  }

  async start() {
    const handler = (socket: Socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => undefined)
      this.session(socket)
    }
    this.server = this.options.mode === 'tls'
      ? createTlsServer({ key: this.options.certificate!.key, cert: this.options.certificate!.cert }, handler)
      : createServer(handler)
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    return this.port
  }

  async close() {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve())
  }

  private session(initial: Socket) {
    this.sessions += 1
    const users = this.options.users ?? { ada: 'secret' }
    const timestamp = `<${process.pid}.${Date.now()}.${this.sessions}@fake.pop3.test>`
    let socket: Socket = initial
    let buffer = ''
    let user: string | undefined
    let authenticated = false
    let tls = this.options.mode === 'tls'
    let silent = false
    let awaitingPlain = false
    // Message numbers are fixed when the session authenticates (RFC 1939).
    let snapshot: StoredMessage[] = []
    const deleted = new Set<number>()
    const send = (line: string) => { if (!silent && !socket.destroyed) socket.write(`${line}\r\n`) }
    const sendBody = (lines: string[]) => {
      for (const line of lines) send(line.startsWith('.') ? `.${line}` : line)
      send('.')
    }
    const login = (name: string, ok: boolean) => {
      if (this.failures.inUse) return send('-ERR [IN-USE] Mailbox locked by another session')
      if (!ok) return send('-ERR [AUTH] Invalid credentials')
      authenticated = true
      user = name
      snapshot = [...this.maildrop]
      send(`+OK ${name} has ${snapshot.length} messages`)
    }
    const message = (argument: string | undefined) => {
      const index = Number(argument)
      if (!Number.isInteger(index) || index < 1 || index > snapshot.length || deleted.has(index)) return undefined
      return { index, stored: snapshot[index - 1] }
    }
    const capabilities = () => {
      const lines = ['TOP', 'PIPELINING']
      if (this.options.uidl !== false) lines.push('UIDL')
      if (this.options.user !== false) lines.push('USER')
      const sasl = this.options.sasl ?? ['PLAIN']
      if (sasl.length) lines.push(`SASL ${sasl.join(' ')}`)
      if (!tls && this.options.stls !== false) lines.push('STLS')
      return lines
    }

    const handle = (line: string) => {
      if (silent) return
      if (awaitingPlain) {
        awaitingPlain = false
        const [, name, password] = Buffer.from(line, 'base64').toString('utf8').split('\0')
        this.commands.push('AUTH PLAIN <credentials>')
        return login(name, users[name] !== undefined && users[name] === password)
      }
      const [verb = '', ...rest] = line.split(' ')
      const command = verb.toUpperCase()
      this.commands.push(command === 'PASS' ? 'PASS <redacted>' : command === 'APOP' ? `APOP ${rest[0]} <digest>` : line)
      if (this.failures.silentAfter && command === this.failures.silentAfter.toUpperCase()) silent = true
      if (command === 'CAPA') {
        if (this.options.capa === false) return send('-ERR CAPA not supported')
        send('+OK Capability list follows')
        return sendBody(capabilities())
      }
      if (command === 'QUIT') {
        if (this.failures.dropOnQuit && authenticated) return socket.destroy()
        if (authenticated) {
          const remove = new Set([...deleted].map((index) => snapshot[index - 1]))
          for (let index = this.maildrop.length - 1; index >= 0; index -= 1) if (remove.has(this.maildrop[index])) this.maildrop.splice(index, 1)
          this.completedQuits += 1
        }
        send('+OK Bye')
        return socket.end()
      }
      if (!authenticated) {
        if (command === 'STLS') {
          if (tls || this.options.stls === false) return send('-ERR STLS not available')
          send('+OK Begin TLS negotiation')
          const plain = socket
          plain.removeAllListeners('data')
          const secure = new TLSSocket(plain, { isServer: true, key: this.options.certificate!.key, cert: this.options.certificate!.cert })
          secure.on('error', () => undefined)
          socket = secure
          tls = true
          buffer = ''
          secure.on('data', receive)
          return
        }
        if (command === 'USER') {
          user = rest[0]
          return send('+OK User accepted')
        }
        if (command === 'PASS') return login(user ?? '', user !== undefined && users[user] === rest.join(' '))
        if (command === 'APOP') {
          if (this.options.apop === false) return send('-ERR APOP not supported')
          const [name, digest] = rest
          const expected = users[name] === undefined ? '' : createHash('md5').update(`${timestamp}${users[name]}`).digest('hex')
          return login(name, Boolean(expected) && digest === expected)
        }
        if (command === 'AUTH' && rest[0]?.toUpperCase() === 'PLAIN' && (this.options.sasl ?? ['PLAIN']).includes('PLAIN')) {
          awaitingPlain = true
          return send('+ ')
        }
        return send('-ERR Authenticate first')
      }
      if (command === 'STAT') {
        const live = snapshot.filter((_, index) => !deleted.has(index + 1))
        return send(`+OK ${live.length} ${live.reduce((sum, item) => sum + item.raw.length, 0)}`)
      }
      if (command === 'LIST' || command === 'UIDL') {
        if (command === 'UIDL' && this.options.uidl === false) return send('-ERR UIDL not supported')
        const value = (index: number) => command === 'LIST' ? String(snapshot[index - 1].raw.length) : snapshot[index - 1].uidl
        if (rest[0]) {
          const found = message(rest[0])
          return found ? send(`+OK ${found.index} ${value(found.index)}`) : send('-ERR No such message')
        }
        send('+OK Listing follows')
        return sendBody(snapshot.flatMap((_, offset) => deleted.has(offset + 1) ? [] : [`${offset + 1} ${value(offset + 1)}`]))
      }
      if (command === 'RETR') {
        const found = message(rest[0])
        if (!found) return send('-ERR No such message')
        if (this.failures.errorOnRetr === found.stored.uidl) return send('-ERR Message temporarily unavailable')
        const body = found.stored.raw.toString('latin1').replace(/\r\n$/, '').split('\r\n')
        if (this.failures.dropDuringRetr === found.stored.uidl) {
          this.failures.dropDuringRetr = undefined
          send(`+OK ${found.stored.raw.length} octets`)
          for (const part of body.slice(0, Math.max(1, Math.floor(body.length / 2)))) send(part.startsWith('.') ? `.${part}` : part)
          return socket.destroy()
        }
        send(`+OK ${found.stored.raw.length} octets`)
        for (const part of body) socket.write(Buffer.from(`${part.startsWith('.') ? `.${part}` : part}\r\n`, 'latin1'))
        return send('.')
      }
      if (command === 'DELE') {
        const found = message(rest[0])
        if (!found) return send('-ERR No such message')
        deleted.add(found.index)
        return send(`+OK Message ${found.index} deleted`)
      }
      if (command === 'RSET') {
        deleted.clear()
        return send('+OK')
      }
      if (command === 'NOOP') return send('+OK')
      return send('-ERR Unknown command')
    }

    function receive(chunk: Buffer) {
      buffer += chunk.toString('latin1')
      let index: number
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        handle(line)
      }
    }

    initial.on('data', receive)
    send(this.options.apop === false ? '+OK Fake POP3 ready' : `+OK Fake POP3 ready ${timestamp}`)
  }
}
