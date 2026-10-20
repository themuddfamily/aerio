export function response(value: unknown, status = 200, chunks?: Uint8Array[]): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); let index = 0;
  const parts = chunks ?? [bytes];
  const reader = { read: async () => index < parts.length ? { done: false, value: parts[index++] } : { done: true, value: undefined }, cancel: jest.fn(async () => {}), releaseLock: jest.fn() };
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, body: { getReader: () => reader, cancel: reader.cancel }, text: async () => JSON.stringify(value), json: async () => value } as unknown as Response;
}
