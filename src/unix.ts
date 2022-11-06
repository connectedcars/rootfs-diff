export interface SysCallError extends Error {
  code: string
  errno: number | string
  syscall: string
}

export function isSysCallError(value: Error): value is SysCallError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SysCallError).code === 'string' &&
    (typeof (value as SysCallError).errno === 'number' || typeof (value as SysCallError).errno === 'string') &&
    typeof (value as SysCallError).syscall === 'string'
  )
}

export function isFileNotFoundError(e: Error): boolean {
  return isSysCallError(e) && !!e.syscall && e.code == 'ENOENT'
}
