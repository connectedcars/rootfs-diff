import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import util from 'util'

import { listFolder } from './rootfs-diff'

const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)
const chmodAsync = util.promisify(fs.chmod)

export interface UnsquashfsOptions {
  fixPermissions?: boolean
  overwrite?: boolean
}

export function hasUnsquashfs(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('unsquashfs', ['--help'], (error, stdout, stderr) => {
      if (error) {
        if (stderr.match(/SYNTAX: unsquashfs/)) {
          resolve(true)
        }
      }
      resolve(false)
    })
  })
}

export async function unsquashfs(from: string, to: string, options?: UnsquashfsOptions): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('unsquashfs', [`-d`, toTmp, from], (error, stdout, stderr) => {
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
