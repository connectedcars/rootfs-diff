import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import util from 'util'

const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)

export function hasZstd(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('zstd', ['--help'], error => {
      if (error) {
        resolve(false)
      }
      resolve(true)
    })
  })
}

export interface ZstdOptions {
  level?: number
  overwrite?: boolean
}

export async function zstd(from: string, to: string, options?: ZstdOptions): Promise<fs.Stats> {
  const mergedOptions = { level: 17, overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('zstd', [`-${mergedOptions.level}`, from, '-o', toTmp], (error, stdout, stderr) => {
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

export interface UnZstdOptions {
  overwrite?: boolean
}

export async function unZstd(from: string, to: string, options?: UnZstdOptions): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('zstd', [`-d`, from, '-o', toTmp], (error, stdout, stderr) => {
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
