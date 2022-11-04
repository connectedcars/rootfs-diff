import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import util from 'util'

const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)

export function hasZstd(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('gzip', ['--help'], error => {
      if (error) {
        resolve(false)
      }
      resolve(true)
    })
  })
}

export interface GzipOptions {
  level?: number
  overwrite?: boolean
}

export async function gzip(from: string, to: string, options?: GzipOptions): Promise<fs.Stats> {
  const mergedOptions = { level: 9, overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('bash', ['-c', `gzip -${mergedOptions.level} '${from}' > '${toTmp}'`], (error, stdout, stderr) => {
        if (error) {
          console.log(stdout)
          console.log(stderr)
          reject(error)
        }
        resolve()
      })
    })
    await renameAsync(toTmp, to)
    toStat = await lstatAsync(to)
  }

  return toStat
}

export interface UnGzipOptions {
  overwrite?: boolean
}

export async function unGzip(from: string, to: string, options?: UnGzipOptions): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('bash', ['-c', `gzip -d '${from}' > '${toTmp}'`], (error, stdout, stderr) => {
        if (error) {
          console.log(stdout)
          console.log(stderr)
          reject(error)
        }
        resolve()
      })
    })
    await renameAsync(toTmp, to)
    toStat = await lstatAsync(to)
  }
  return toStat
}
