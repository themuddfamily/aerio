export type DelegationResponse = 'accept' | 'decline' | 'progress' | 'complete'
export interface DelegationSource { id: string; kind: 'local' | 'provider' }
export interface DelegatedTask {
  id: string; accountId: string; uid: string; role: 'organizer' | 'assignee'; organizer: string; assignee: string
  title: string; notes: string; due?: string; sequence: number; stamp: string; replyStamp?: string
  participation: 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED'; status: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED'
  percent: number; updatedAt: string; source?: DelegationSource; comment?: string
  deliveries: { id: string; method: string; status: string; error?: string }[]
}
export interface DelegateTaskInput { accountId: string; assignee: string; title: string; notes?: string; due?: string; source?: DelegationSource }
export interface DelegationChange { id: string; expectedUpdatedAt: string; title?: string; notes?: string; due?: string; cancel?: boolean }
export interface DelegationReply { id: string; expectedUpdatedAt: string; response: DelegationResponse; percent?: number; comment?: string }
export interface TaskDelegationApi {
  list(): Promise<DelegatedTask[]>
  assign(input: DelegateTaskInput): Promise<DelegatedTask>
  update(input: DelegationChange): Promise<DelegatedTask>
  respond(input: DelegationReply): Promise<DelegatedTask>
  inspect(accountId: string, messageId: string): Promise<DelegatedTask | undefined>
  retry(draftId: string): Promise<void>
}
