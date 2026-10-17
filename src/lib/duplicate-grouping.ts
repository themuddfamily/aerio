import type { DuplicateConfidence, DuplicateItem, DuplicateReason, DuplicateReasonCode } from '../duplicate-cleanup-types'

// Shared helpers for the duplicate scanners (E32): a small union-find for building
// candidate groups from pairwise matches, and the default keeper choice.

export class DuplicateUnion {
  private readonly parent = new Map<string, string>()
  private readonly codes = new Map<string, Set<DuplicateReasonCode>>()

  private find(id: string): string {
    let root = id
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!
    // Path compression keeps later lookups short.
    let current = id
    while (current !== root) {
      const next = this.parent.get(current) ?? root
      this.parent.set(current, root)
      current = next
    }
    if (!this.parent.has(root)) this.parent.set(root, root)
    return root
  }

  join(first: string, second: string, code: DuplicateReasonCode) {
    if (first === second) return
    const a = this.find(first)
    const b = this.find(second)
    const merged = new Set([...(this.codes.get(a) ?? []), ...(this.codes.get(b) ?? []), code])
    if (a !== b) {
      this.parent.set(b, a)
      this.codes.delete(b)
    }
    this.codes.set(a, merged)
  }

  // Connected components with at least two members, each with the reasons that joined it.
  groups(): { ids: string[]; codes: DuplicateReasonCode[] }[] {
    const members = new Map<string, string[]>()
    for (const id of this.parent.keys()) {
      const root = this.find(id)
      members.set(root, [...(members.get(root) ?? []), id])
    }
    return [...members.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([root, ids]) => ({ ids: ids.sort(), codes: [...(this.codes.get(root) ?? [])].sort() }))
  }
}

export const REASON_LABELS: Record<DuplicateReasonCode, string> = {
  'message-id': 'Same Message-ID in the same folder',
  'content-hash': 'Identical message content',
  'message-fingerprint': 'Same sender, subject, size, and time (different Message-ID)',
  'ical-uid': 'Same calendar UID and occurrence',
  'event-details': 'Same title, start, end, and location',
  'task-details': 'Same title, due date, notes, and subtasks'
}

export const duplicateReasons = (codes: DuplicateReasonCode[]): DuplicateReason[] => codes.map((code) => ({ code, label: REASON_LABELS[code] }))

// A copy that cannot be removed is kept; otherwise the most complete, then the oldest,
// then by id so the choice is stable.
export function suggestedKeeper(items: Pick<DuplicateItem, 'id' | 'completeness' | 'createdAt' | 'removable'>[]) {
  return [...items].sort((left, right) => Number(left.removable) - Number(right.removable) || right.completeness - left.completeness ||
    (left.createdAt ?? '\uffff').localeCompare(right.createdAt ?? '\uffff') || left.id.localeCompare(right.id))[0].id
}

export const normalizeText = (value: string | undefined) => (value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

export const confidenceRank: Record<DuplicateConfidence, number> = { high: 3, medium: 2, low: 1 }
