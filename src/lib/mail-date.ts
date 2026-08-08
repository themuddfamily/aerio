import { format, isSameDay, isSameYear, subDays } from 'date-fns'

export function mailDateGroupKey(value: string | Date) {
  return format(new Date(value), 'yyyy-MM-dd')
}

export function formatMailDateHeading(value: string | Date, reference = new Date()) {
  const date = new Date(value)
  if (isSameDay(date, reference)) return 'Today'
  if (isSameDay(date, subDays(reference, 1))) return 'Yesterday'
  return format(date, isSameYear(date, reference) ? 'do MMMM' : 'do MMMM yyyy')
}

export function formatMailListTime(value: string | Date) {
  return format(new Date(value), 'HH:mm')
}

export function formatMailArrival(value: string | Date) {
  return format(new Date(value), 'EEE dd/MM/yyyy HH:mm')
}

export function formatMailArrivalTooltip(value: string | Date) {
  return format(new Date(value), 'EEEE dd/MM/yyyy HH:mm:ss')
}
