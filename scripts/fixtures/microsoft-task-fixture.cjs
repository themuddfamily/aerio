// Controlled main-process transport for the disposable Microsoft desktop audit.
const { createHash } = require('node:crypto')
const { Worker } = require('node:worker_threads')
const { shell, net } = require('electron')
exports.install = (previous, email, profileId) => {
  const state = previous ?? {
    scope: 'User.Read Mail.ReadWrite Tasks.ReadWrite', denied: false, revision: 1,
    lists: { list: { id: 'list', displayName: 'MS audit list', isOwner: true, isShared: false, wellknownListName: 'none' }, system: { id: 'system', displayName: 'Managed list', isOwner: true, isShared: false, wellknownListName: 'defaultList' } },
    tasks: { list: { original: { id: 'original', title: 'MS audit task', '@odata.etag': 'task-v1', status: 'inProgress', importance: 'high', body: { contentType: 'html', content: '<p><b>Original</b> &amp; notes</p>' }, dueDateTime: { dateTime: '2026-10-05T09:00:00.0000000', timeZone: 'GMT Standard Time' }, recurrence: { pattern: { type: 'daily', interval: 2, dayOfMonth: 0, month: 0, daysOfWeek: [], firstDayOfWeek: 'sunday', index: 'first' }, range: { type: 'noEnd', startDate: '2026-10-01', endDate: '0001-01-01', numberOfOccurrences: 0, recurrenceTimeZone: 'GMT Standard Time' } } } }, system: {} },
    children: { original: { step: { id: 'step', displayName: 'MS audit step', isChecked: false, createdDateTime: '2026-10-01T00:00:00Z' } } },
    changes: [{ list: 'list', id: 'original', revision: 1 }], writes: [], reads: [], taskCreates: 0, listCreates: 0, childCreates: 0,
    loseTaskCreate: false, loseTaskUpdate: false, loseChildCreate: false, loseListCreate: false, loseListDelete: false,
    oauth: { browserOpens: 0, exchanges: 0, pkce: 0, refreshes: 0, mailPauses: 0 }
  }
  globalThis.microsoftTaskAudit = state
  net.isOnline = () => true
  const nativeFetch = globalThis.fetch, nativePost = Worker.prototype.postMessage
  Worker.prototype.postMessage = function (message, ...args) {
    // Preserve native worker RPC but replace mail verification/sync with pause.
    // A Tasks audit must never ask the worker to contact a hosted mailbox.
    if (message?.kind === 'request' && ['accounts:verify', 'sync:start'].includes(message.command?.type)) {
      state.oauth.mailPauses++
      message = { ...message, command: { type: 'sync:pause', payload: { accountId: message.command.payload.accountId } } }
    }
    return nativePost.call(this, message, ...args)
  }
  shell.openExternal = async (input) => {
    const url = new URL(input)
    if (url.origin !== 'https://login.microsoftonline.com' || url.pathname !== '/common/oauth2/v2.0/authorize' || url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('scope')?.split(' ').includes('Tasks.ReadWrite')) throw new Error('Unexpected Microsoft authorization request')
    const callback = new URL(url.searchParams.get('redirect_uri'))
    if (callback.protocol !== 'http:' || callback.hostname !== 'localhost' || callback.pathname !== '/') throw new Error('Microsoft callback must stay on loopback')
    state.challenge = url.searchParams.get('code_challenge'); state.redirect = callback.toString().replace(/\/$/, ''); state.clientId = url.searchParams.get('client_id')
    state.oauth.browserOpens++
    callback.searchParams.set('state', url.searchParams.get('state'))
    callback.searchParams.set(state.denied ? 'error' : 'code', state.denied ? 'access_denied' : 'ms-fixture-code')
    const response = await nativeFetch(callback)
    if (response.status !== (state.denied ? 400 : 200)) throw new Error('Microsoft loopback callback returned an unexpected status')
  }
  const json = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const change = (list, id, deleted = false) => state.changes.push({ list, id, deleted, revision: ++state.revision })
  const record = (kind, method, id, init) => state.writes.push({ kind, method, id, body: init.body ? JSON.parse(init.body) : undefined, ifMatch: new Headers(init.headers).get('If-Match') })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET'
    if (url.origin === 'https://login.microsoftonline.com' && url.pathname === '/common/oauth2/v2.0/token' && method === 'POST') {
      const fields = new URLSearchParams(init.body)
      if (fields.get('grant_type') === 'authorization_code') {
        const verifier = fields.get('code_verifier')
        if (fields.get('code') !== 'ms-fixture-code' || fields.get('redirect_uri') !== state.redirect || fields.get('client_id') !== state.clientId || !verifier || createHash('sha256').update(verifier).digest('base64url') !== state.challenge) throw new Error('Microsoft PKCE exchange does not match the callback')
        state.oauth.exchanges++; state.oauth.pkce++; state.lastGrant = state.scope
      } else if (fields.get('grant_type') === 'refresh_token' && fields.get('refresh_token') === 'ms-fixture-refresh') {
        if (fields.get('scope') !== state.lastGrant) throw new Error('Refresh requested a different Microsoft grant')
        state.oauth.refreshes++
      } else throw new Error('Unexpected Microsoft token exchange')
      return json({ access_token: 'ms-fixture-token', refresh_token: 'ms-fixture-refresh', expires_in: 3600, scope: state.scope })
    }
    if (url.origin !== 'https://graph.microsoft.com' || new Headers(init.headers).get('Authorization') !== 'Bearer ms-fixture-token') throw new Error('Unexpected Microsoft audit destination or authorization')
    if (url.pathname === '/v1.0/me' && method === 'GET') return json({ id: profileId, mail: email, userPrincipalName: email, displayName: 'MS audit' })
    const prefix = '/v1.0/me/todo/lists'
    if (!url.pathname.startsWith(prefix)) throw new Error('Unexpected Microsoft audit Graph endpoint')
    const scopes = new Set(state.scope.split(' '))
    if (method === 'GET') {
      if (!scopes.has('Tasks.Read') && !scopes.has('Tasks.ReadWrite')) return json({}, 403)
      state.reads.push(url.href)
    } else if (!scopes.has('Tasks.ReadWrite')) return json({}, 403)
    const parts = url.pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent)
    if (!parts.length) {
      if (method === 'GET') return json({ value: Object.values(state.lists) })
      if (method === 'POST') {
        const list = { id: `created-list-${++state.listCreates}`, ...JSON.parse(init.body), isOwner: true, isShared: false, wellknownListName: 'none' }
        state.lists[list.id] = list; state.tasks[list.id] = {}; record('list', method, list.id, init)
        if (state.loseListCreate) { state.loseListCreate = false; throw new Error('Synthetic accepted/lost list create') }
        return json(list)
      }
    }
    const listId = parts[0], list = state.lists[listId]
    if (!list) return json({}, 404)
    if (parts.length === 1) {
      if (method === 'GET') return json(list)
      if (new Headers(init.headers).has('If-Match')) throw new Error('A snapshot fingerprint was sent as a list ETag')
      record('list', method, listId, init)
      if (method === 'PATCH') { Object.assign(list, JSON.parse(init.body)); return json(list) }
      if (method === 'DELETE') {
        for (const task of Object.values(state.tasks[listId])) delete state.children[task.id]
        delete state.lists[listId]; delete state.tasks[listId]
        if (state.loseListDelete) { state.loseListDelete = false; throw new Error('Synthetic accepted/lost list delete') }
        return json(null, 204)
      }
    }
    if (parts[1] !== 'tasks') throw new Error('Unexpected Microsoft collection')
    if (parts[2] === 'delta' && method === 'GET') {
      const since = Number(url.searchParams.get('$deltatoken') ?? 0)
      const changed = new Map(state.changes.filter((item) => item.list === listId && item.revision > since).map((item) => [item.id, item]))
      return json({ value: [...changed.values()].map((item) => item.deleted ? { id: item.id, '@removed': { reason: 'deleted' } } : { id: item.id }), '@odata.deltaLink': `${url.origin}${prefix}/${encodeURIComponent(listId)}/tasks/delta?$deltatoken=${state.revision}` })
    }
    if (parts.length === 2 && method === 'POST') {
      const task = { id: `created-task-${++state.taskCreates}`, status: 'notStarted', importance: 'normal', body: { contentType: 'html', content: '' }, recurrence: null, ...JSON.parse(init.body), '@odata.etag': `task-v${state.revision + 1}` }
      state.tasks[listId][task.id] = task; change(listId, task.id); record('task', method, task.id, init)
      if (state.loseTaskCreate) { state.loseTaskCreate = false; throw new Error('Synthetic accepted/lost task create') }
      return json(task)
    }
    const taskId = parts[2], task = state.tasks[listId][taskId]
    if (!task) return json({}, 404)
    if (parts.length === 3) {
      if (method === 'GET') return json(task)
      if (new Headers(init.headers).get('If-Match') !== task['@odata.etag']) return json({}, 412)
      record('task', method, taskId, init)
      if (method === 'PATCH') {
        Object.assign(task, JSON.parse(init.body), { '@odata.etag': `task-v${state.revision + 1}` }); change(listId, taskId)
        if (state.loseTaskUpdate) { state.loseTaskUpdate = false; throw new Error('Synthetic accepted/lost task update') }
        return json(task)
      }
      if (method === 'DELETE') { delete state.tasks[listId][taskId]; delete state.children[taskId]; change(listId, taskId, true); return json(null, 204) }
    }
    if (parts[3] !== 'checklistItems') throw new Error('Unexpected Microsoft task resource')
    const children = state.children[taskId] ??= {}
    if (parts.length === 4) {
      if (method === 'GET') return json({ value: Object.values(children) })
      if (method === 'POST') {
        const child = { id: `created-child-${++state.childCreates}`, ...JSON.parse(init.body), createdDateTime: new Date().toISOString() }
        children[child.id] = child; record('child', method, child.id, init)
        if (state.loseChildCreate) { state.loseChildCreate = false; throw new Error('Synthetic accepted/lost checklist create') }
        return json(child)
      }
    }
    const child = children[parts[4]]
    if (!child) return json({}, 404)
    if (method === 'GET') return json(child)
    if (new Headers(init.headers).has('If-Match')) throw new Error('A checklist snapshot was sent as an ETag')
    record('child', method, child.id, init)
    if (method === 'PATCH') { Object.assign(child, JSON.parse(init.body)); return json(child) }
    if (method === 'DELETE') { delete children[child.id]; return json(null, 204) }
    throw new Error('Unexpected Microsoft audit request')
  }
}
