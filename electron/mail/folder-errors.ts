// Errors cross the worker boundary as messages only, so the renderer matches
// the stable "contains N messages" wording to ask for explicit confirmation.
export const FOLDER_NOT_EMPTY_PATTERN = /contains ([\d,]+) messages? on the server/

export class FolderNotEmptyError extends Error {
  constructor(readonly count: number) {
    super(`This folder contains ${count.toLocaleString('en-US')} message${count === 1 ? '' : 's'} on the server. Confirm deletion to continue.`)
    this.name = 'FolderNotEmptyError'
  }
}

// The folder changed on the provider since Aerio last synchronized it.
export class FolderConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FolderConflictError'
  }
}
