import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import util from 'util'

const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)

export interface BsdiffOptions {
  overwrite?: boolean
}

export function hasBsdiff(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('bsdiff', [], (error, stdout, stderr) => {
      if (error) {
        if (stderr.match(/bsdiff: usage:/)) {
          resolve(true)
        }
      }
      resolve(false)
    })
  })
}

export async function bsdiff(from: string, to: string, diff: string, options?: BsdiffOptions): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }

  let diffStat = await lstatAsync(diff).catch(() => null)
  if (diffStat === null || mergedOptions.overwrite) {
    const diffTmp = `${diff}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('bsdiff', [from, to, diffTmp], (error, stdout, stderr) => {
        if (error) {
          console.log(stdout)
          console.log(stderr)
          reject(error)
        }
        resolve()
      })
    })
    await renameAsync(diffTmp, diff)
    diffStat = await lstatAsync(diff)
  }

  return diffStat
}
