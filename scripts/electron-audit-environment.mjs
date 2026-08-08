export const desktopAuditVisible = process.env.AERIO_TEST_VISIBLE === '1'

export function desktopAuditEnvironment() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    AERIO_TEST_HIDDEN: desktopAuditVisible ? '0' : '1'
  }
}
