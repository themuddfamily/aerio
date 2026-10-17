// Time-zone helpers for calendar interchange. Conversions rely on the Intl time-zone database, which
// Electron and Node ship with full ICU data, so imported TZIDs keep their real-world offset rules.

export interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

// Common Windows (Outlook/Exchange) zone names mapped to IANA identifiers, following the CLDR table.
const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles', 'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver', 'Central Standard Time': 'America/Chicago',
  'Canada Central Standard Time': 'America/Regina', 'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Eastern Standard Time': 'America/New_York', 'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax', 'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev', 'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul',
  'South Africa Standard Time': 'Africa/Johannesburg', 'Egypt Standard Time': 'Africa/Cairo',
  'Israel Standard Time': 'Asia/Jerusalem', 'Arab Standard Time': 'Asia/Riyadh', 'Arabian Standard Time': 'Asia/Dubai',
  'Iran Standard Time': 'Asia/Tehran', 'Pakistan Standard Time': 'Asia/Karachi', 'West Asia Standard Time': 'Asia/Tashkent',
  'India Standard Time': 'Asia/Kolkata', 'SE Asia Standard Time': 'Asia/Bangkok', 'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore', 'Taipei Standard Time': 'Asia/Taipei', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'W. Australia Standard Time': 'Australia/Perth',
  'Cen. Australia Standard Time': 'Australia/Adelaide', 'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland'
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string) {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
    formatters.set(timeZone, value)
  }
  return value
}

export function isIanaTimeZone(value: string | undefined): boolean {
  if (!value || value.length > 100 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false
  try {
    formatter(value)
    return true
  } catch {
    return false
  }
}

// Resolves an ICS TZID to an IANA zone: IANA names, Windows names, and vendor-prefixed names such as
// "/mozilla.org/20050126_1/America/New_York" or "/citadel.org/.../Europe/Paris".
export function resolveTimeZoneName(tzid: string | undefined): string | undefined {
  const value = tzid?.trim().replace(/^"|"$/g, '')
  if (!value) return undefined
  if (WINDOWS_ZONES[value]) return WINDOWS_ZONES[value]
  if (isIanaTimeZone(value)) return value
  const segments = value.split('/').filter(Boolean)
  for (let size = Math.min(3, segments.length); size >= 1; size--) {
    const candidate = segments.slice(-size).join('/')
    if (candidate.includes('/') && isIanaTimeZone(candidate)) return candidate
  }
  return undefined
}

export function wallTimeInZone(utcMs: number, timeZone: string): WallTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second)
  }
}

export const wallTimeMs = (wall: WallTime) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)

// Offset of the zone from UTC at an instant, in minutes (positive east of Greenwich).
export function timeZoneOffsetMinutes(utcMs: number, timeZone: string) {
  const seconds = Math.floor(utcMs / 1_000) * 1_000
  return Math.round((wallTimeMs(wallTimeInZone(seconds, timeZone)) - seconds) / 60_000)
}

// Converts a wall-clock time in a zone to a UTC instant. Times inside a DST gap move forward, and
// ambiguous times during a fall-back hour resolve to the first (daylight) occurrence, as RFC 5545 requires.
export function wallTimeToUtc(wall: WallTime, timeZone: string) {
  const guess = wallTimeMs(wall)
  const first = guess - timeZoneOffsetMinutes(guess, timeZone) * 60_000
  const second = guess - timeZoneOffsetMinutes(first, timeZone) * 60_000
  if (first === second) {
    const earlier = guess - timeZoneOffsetMinutes(first - 3_600_000, timeZone) * 60_000
    return earlier < first && wallTimeMs(wallTimeInZone(earlier, timeZone)) === guess ? earlier : first
  }
  return wallTimeMs(wallTimeInZone(second, timeZone)) === guess ? second : Math.max(first, second)
}
