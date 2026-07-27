/// <reference types="vite/client" />

import type { AerioDesktopApi } from './types'

declare global {
  interface Window {
    aerio: AerioDesktopApi
  }
}

export {}
