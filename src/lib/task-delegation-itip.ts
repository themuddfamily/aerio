import { allProperties, escapeText, firstProperty, foldLine, paramValue, parseComponents, unescapeText } from './content-lines'
import { ICS_LIMITS } from './ics'
import { isCompleteMailAddress } from './mail-address'
import type { DelegatedTask } from '../task-delegation-types'
export type TaskItipMethod = 'REQUEST' | 'REPLY' | 'CANCEL'
export interface TaskItip extends Pick<DelegatedTask, 'uid' | 'organizer' | 'assignee' | 'title' | 'notes' | 'due' | 'sequence' | 'stamp' | 'participation' | 'status' | 'percent' | 'comment'> { method: TaskItipMethod }
export const validTaskDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
export const taskStamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
export function taskItip(data: TaskItip): string {
  const partstat = data.method === 'REPLY' && data.participation === 'ACCEPTED' ? data.status === 'COMPLETED' ? 'COMPLETED' : data.status === 'IN-PROCESS' ? 'IN-PROCESS' : 'ACCEPTED' : data.participation
  const stampedDay = `${data.stamp.slice(0, 4)}-${data.stamp.slice(4, 6)}-${data.stamp.slice(6, 8)}`
  const beforeDue = data.due ? new Date(Date.parse(`${data.due}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : stampedDay
  const start = (beforeDue < stampedDay ? beforeDue : stampedDay).replaceAll('-', '')

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aerio//Task delegation//EN', `METHOD:${data.method}`, 'BEGIN:VTODO', `UID:${escapeText(data.uid)}`, `DTSTAMP:${data.stamp}`, `SEQUENCE:${data.sequence}`, `ORGANIZER:mailto:${data.organizer}`, `ATTENDEE;ROLE=REQ-PARTICIPANT;${data.method === 'REQUEST' ? 'RSVP=TRUE;' : ''}PARTSTAT=${partstat}:mailto:${data.assignee}`, ...(data.method === 'REQUEST' ? [`DTSTART;VALUE=DATE:${start}`, 'PRIORITY:0'] : []), `SUMMARY:${escapeText(data.title)}`, `DESCRIPTION:${escapeText(data.notes)}`, `STATUS:${data.status}`, `PERCENT-COMPLETE:${data.percent}`, ...(data.due ? [`DUE;VALUE=DATE:${data.due.replaceAll('-', '')}`] : []), ...(data.comment ? [`COMMENT:${escapeText(data.comment)}`] : []), ...(data.status === 'COMPLETED' ? [`COMPLETED:${data.stamp}`] : []), 'END:VTODO', 'END:VCALENDAR']
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
export function parseTaskItip(text: string): TaskItip | undefined {
  if (!text.includes('BEGIN:VTODO') || text.length > 256_000) return
  let parsed: ReturnType<typeof parseComponents>
  try { parsed = parseComponents(text, ICS_LIMITS) } catch { return }
  if (parsed.warnings.length || parsed.roots.length !== 1) return
  const calendar = parsed.roots[0], todo = calendar.children.filter((item) => item.name === 'VTODO')
  if (calendar.name !== 'VCALENDAR' || todo.length !== 1 || calendar.children.some((item) => !['VTODO', 'VTIMEZONE'].includes(item.name))) return
  const item = todo[0], get = (name: string) => firstProperty(item, name)?.value
  if (['RRULE', 'RDATE', 'RECURRENCE-ID', 'DURATION'].some((name) => firstProperty(item, name))) return
  if (allProperties(calendar, 'METHOD').length !== 1 || firstProperty(calendar, 'VERSION')?.value !== '2.0') return
  const method = firstProperty(calendar, 'METHOD')?.value as TaskItipMethod
  if (!['REQUEST', 'REPLY', 'CANCEL'].includes(method)) return
  if (['UID', 'DTSTAMP', 'ORGANIZER', 'ATTENDEE'].some((name) => allProperties(item, name).length !== 1)) return
  const address = (value?: string) => value?.replace(/^mailto:/i, '').toLowerCase()
  const organizer = address(get('ORGANIZER')), attendee = firstProperty(item, 'ATTENDEE')!, assignee = address(attendee.value)
  const sequence = Number(get('SEQUENCE') ?? 0), stamp = get('DTSTAMP')!, uid = get('UID')!
  const rawParticipation = paramValue(attendee, 'PARTSTAT') ?? 'NEEDS-ACTION'
  if (!['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'IN-PROCESS', 'COMPLETED'].includes(rawParticipation)) return
  const participation = (['IN-PROCESS', 'COMPLETED'].includes(rawParticipation) ? 'ACCEPTED' : rawParticipation) as TaskItip['participation']
  const status = (rawParticipation === 'COMPLETED' ? 'COMPLETED' : rawParticipation === 'IN-PROCESS' ? 'IN-PROCESS' : get('STATUS') ?? 'NEEDS-ACTION') as TaskItip['status']
  const percent = status === 'COMPLETED' ? 100 : Number(get('PERCENT-COMPLETE') ?? 0)
  if (!organizer || !assignee || /[\s<>]/.test(organizer + assignee) || !isCompleteMailAddress(organizer) || !isCompleteMailAddress(assignee) || organizer === assignee || !Number.isSafeInteger(sequence) || sequence < 0 || !/^\d{8}T\d{6}Z$/.test(stamp) || !uid || uid.length > 300 || /[\r\n]/.test(uid) || !['NEEDS-ACTION', 'ACCEPTED', 'DECLINED'].includes(participation) || !['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'].includes(status) || !Number.isInteger(percent) || percent < 0 || percent > 100) return
  if (['SUMMARY', 'DESCRIPTION', 'DUE', 'STATUS', 'PERCENT-COMPLETE', 'SEQUENCE'].some((name) => allProperties(item, name).length > 1)) return
  const stampIso = `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(9,11)}:${stamp.slice(11,13)}:${stamp.slice(13,15)}Z`
  if (!Number.isFinite(Date.parse(stampIso)) || taskStamp(new Date(stampIso)) !== stamp) return
  const rawDue = get('DUE'), due = rawDue && /^\d{8}$/.test(rawDue) ? `${rawDue.slice(0, 4)}-${rawDue.slice(4, 6)}-${rawDue.slice(6)}` : undefined
  if (rawDue && (!due || !validTaskDate(due))) return
  const title = unescapeText(get('SUMMARY') ?? (method === 'REQUEST' ? '' : 'Task response')), notes = unescapeText(get('DESCRIPTION') ?? ''), comment = unescapeText(get('COMMENT') ?? '')
  if (!title.trim() || title.length > 1024 || notes.length > 8192 || comment.length > 2000) return
  return { method, uid, sequence, stamp, organizer, assignee, title, notes, due, participation, status, percent, ...(comment ? { comment } : {}) }
}
