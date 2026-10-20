import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { proxyUrlForHost } from './network-proxy-runtime'

/** HTTP(S) CONNECT for raw TCP protocols; destination DNS is performed by the proxy. */
export async function openProxyTunnel(host: string, port: number, timeoutMs: number): Promise<Socket | undefined> {
  const configured = proxyUrlForHost(host)
  if (!configured) return undefined
  const proxy = new URL(configured)
  const authorization = proxy.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : undefined
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT', path: `${host.includes(':') ? `[${host}]` : host}:${port}`, agent: false,
      headers: { Host: `${host.includes(':') ? `[${host}]` : host}:${port}`, ...(authorization ? { 'Proxy-Authorization': authorization } : {}) }
    })
    const timeout = setTimeout(() => request.destroy(new Error('Proxy timeout')), timeoutMs)
    request.once('connect', (response, socket, head) => {
      clearTimeout(timeout)
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`The proxy refused the connection (${response.statusCode ?? 'unknown status'})`)); return }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    request.once('error', () => { clearTimeout(timeout); reject(new Error('The proxy connection failed; check the server and credentials')) })
    request.end()
  })
}
