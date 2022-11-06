import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import util from 'util'

import { listFolder } from './rootfs-diff'

const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)
const chmodAsync = util.promisify(fs.chmod)
const mkdirAsync = util.promisify(fs.mkdir)

export interface CpioOptions {
  fixPermissions?: boolean
  overwrite?: boolean
}

export function hasCpio(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('cpio', ['--help'], error => {
      if (error) {
        resolve(false)
      }
      resolve(true)
    })
  })
}

export async function unCpio(from: string, to: string, options?: CpioOptions): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await mkdirAsync(toTmp)
    await new Promise<void>((resolve, reject) => {
      execFile('bash', ['-c', `cd '${toTmp}' && cat '${from}' | cpio -i`], (error, stdout, stderr) => {
        if (error) {
          console.log(stdout)
          console.log(stderr)
          reject(error)
        }
        resolve()
      })
    })
    if (mergedOptions.fixPermissions) {
      const files = await listFolder(toTmp)
      // Fix permissions if some of the files are missing read permission, fx. sudo
      for (const file of files) {
        if (file.isFile && (file.mode & 0o400) === 0) {
          await chmodAsync(file.fullPath, file.mode | 0o400)
        }
      }
    }
    await renameAsync(toTmp, to)
    toStat = await lstatAsync(to)
  }
  return toStat
}
