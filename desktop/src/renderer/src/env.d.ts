import type { DesktopApi } from '@shared/types'

declare global {
  interface Window {
    /** API exposée par le preload via contextBridge. */
    robustPwd: DesktopApi
  }
}

export {}
