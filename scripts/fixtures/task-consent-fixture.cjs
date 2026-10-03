// Loaded only by the disposable Electron audit through createRequire.
const { createHash } = require('node:crypto')
const { Worker } = require('node:worker_threads')
const { OAuth2Client } = require('google-auth-library')
const { shell, net } = require('electron')

exports.install = (previous, email) => {
  const state = previous ?? {
    scope: 'https://www.googleapis.com/auth/tasks', denied: false,
    lists: { list: { id: 'list', title: 'Consent audit list', etag: 'list-v1' } },
    tasks: { original: { id: 'original', title: 'Consent audit task', etag: 'task-v1', status: 'needsAction', updated: new Date().toISOString() } },
    revision: 1, taskCreates: 0, listCreates: 0, loseTaskCreate: false, loseListCreate: false,
    writes: [], oauth: { browserOpens: 0, tokenExchanges: 0, pkceMatches: 0, profileReads: 0, mailPauses: 0 }
  }
  globalThis.taskConsentAudit = state
  net.isOnline = () => true
  const nativeFetch = globalThis.fetch
  const nativePost = Worker.prototype.postMessage
  Worker.prototype.postMessage = function (message, ...args) {
    // The reconnect handler still uses the real worker's request/response
    // channel. Mail verification/sync are replaced with pause commands so
    // this Tasks-only audit never gives the worker a hosted Gmail request.
    if (message?.kind === 'request' && ['accounts:verify', 'sync:start'].includes(message.command?.type)) {
      state.oauth.mailPauses++
      message = { ...message, command: { type: 'sync:pause', payload: { accountId: message.command.payload.accountId } } }
    }
    return nativePost.call(this, message, ...args)
  }
  const transporter = new OAuth2Client().transporter.constructor
  transporter.prototype.request = async function (options) {
    if (String(options.url) !== 'https://oauth2.googleapis.com/token' || options.method !== 'POST') throw new Error('Unexpected audit OAuth destination')
    const fields = new URLSearchParams(options.data)
    const verifier = fields.get('code_verifier')
    if (fields.get('code') !== 'synthetic-consent-code' || fields.get('grant_type') !== 'authorization_code' || !verifier || createHash('sha256').update(verifier).digest('base64url') !== state.challenge || fields.get('redirect_uri') !== state.redirectUri) throw new Error('OAuth PKCE exchange did not match the local callback')
    state.oauth.tokenExchanges++; state.oauth.pkceMatches++
    return { data: { access_token: 'synthetic-consent-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600, token_type: 'Bearer', scope: state.scope }, status: 200, headers: new Headers(), config: options }
  }
  shell.openExternal = async (input) => {
    const url = new URL(input)
    if (url.origin !== 'https://accounts.google.com' || url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('scope')?.includes('https://www.googleapis.com/auth/tasks')) throw new Error('Unexpected audit authorization request')
    const callback = new URL(url.searchParams.get('redirect_uri'))
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/oauth/callback') throw new Error('OAuth callback must remain on loopback')
    state.redirectUri = callback.toString(); state.challenge = url.searchParams.get('code_challenge')
    state.oauth.browserOpens++
    callback.searchParams.set('state', url.searchParams.get('state'))
    callback.searchParams.set(state.denied ? 'error' : 'code', state.denied ? 'access_denied' : 'synthetic-consent-code')
    const response = await nativeFetch(callback)
    if (response.status !== (state.denied ? 400 : 200)) throw new Error('Local OAuth callback returned an unexpected status')
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET'
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.href === 'https://gmail.googleapis.com/gmail/v1/users/me/profile' && method === 'GET') { state.oauth.profileReads++; return json({ emailAddress: email }) }
    if (url.origin !== 'https://tasks.googleapis.com') throw new Error('Unexpected consent audit provider destination')
    if (url.pathname === '/tasks/v1/users/@me/lists') {
      if (method === 'GET') return json({ items: Object.values(state.lists) })
      if (method === 'POST') {
        const list = { ...JSON.parse(init.body), id: `created-list-${++state.listCreates}`, etag: `list-v${++state.revision}` }
        state.lists[list.id] = list; state.writes.push({ kind: 'list', method, id: list.id })
        if (state.loseListCreate) { state.loseListCreate = false; throw new Error('Synthetic lost list response') }
        return json(list)
      }
    }
    const listMatch = url.pathname.match(/^\/tasks\/v1\/users\/@me\/lists\/([^/]+)$/)
    if (listMatch) {
      const list = state.lists[decodeURIComponent(listMatch[1])]
      if (!list) return json({}, 404)
      if (method === 'GET') return json(list)
      if (method === 'PATCH' && new Headers(init.headers).get('If-Match') === list.etag) {
        Object.assign(list, JSON.parse(init.body), { etag: `list-v${++state.revision}` }); state.writes.push({ kind: 'list', method, id: list.id }); return json(list)
      }
      return json({}, 412)
    }
    const tasksMatch = url.pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks$/)
    if (tasksMatch) {
      const listId = decodeURIComponent(tasksMatch[1])
      if (method === 'GET') return json({ items: listId === 'list' ? Object.values(state.tasks) : [] })
      if (method === 'POST' && listId === 'list') {
        const task = { ...JSON.parse(init.body), id: `created-task-${++state.taskCreates}`, etag: `task-v${++state.revision}`, updated: new Date().toISOString() }
        state.tasks[task.id] = task; state.writes.push({ kind: 'task', method, id: task.id })
        if (state.loseTaskCreate) { state.loseTaskCreate = false; throw new Error('Synthetic lost task response') }
        return json(task)
      }
    }
    const taskMatch = url.pathname.match(/^\/tasks\/v1\/lists\/list\/tasks\/([^/]+)$/)
    if (taskMatch) {
      const task = state.tasks[decodeURIComponent(taskMatch[1])]
      if (!task) return json({}, 404)
      if (method === 'GET') return json(task)
      if (method === 'PATCH' && new Headers(init.headers).get('If-Match') === task.etag) {
        Object.assign(task, JSON.parse(init.body), { etag: `task-v${++state.revision}`, updated: new Date().toISOString() }); state.writes.push({ kind: 'task', method, id: task.id }); return json(task)
      }
      return json({}, 412)
    }
    throw new Error('Unexpected consent audit Tasks endpoint')
  }
  return state
}
