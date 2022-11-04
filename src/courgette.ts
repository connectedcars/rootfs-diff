import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import util from 'util'

const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)

export interface CourgetteOptions {
  overwrite?: boolean
}

export function hasCourgette(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('docker', ['inspect', '--type=image', 'docker.io/library/courgette:latest'], error => {
      if (error) {
        resolve(false)
      }
      resolve(true)
    })
  })
}

export async function courgette(from: string, to: string, diff: string, options?: CourgetteOptions): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }

  const [fromDir, fromFile] = [path.dirname(from), path.basename(from)]
  const [toDir, toFile] = [path.dirname(to), path.basename(to)]
  const [diffDir, diffFile] = [path.dirname(diff), path.basename(diff)]

  let diffStat = await lstatAsync(diff).catch(() => null)
  if (diffStat === null || mergedOptions.overwrite) {
    const diffTmp = `${diffFile}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile(
        'docker',
        [
          'run',
          `-v${fromDir}:/from`,
          `-v${toDir}:/to`,
          `-v${diffDir}:/diff`,
          'docker.io/library/courgette',
          '/build/out/courgette',
          '-gen',
          `/from/${fromFile}`,
          `/to/${toFile}`,
          `/diff/${diffTmp}`
        ],
        (error, stdout, stderr) => {
          if (error) {
            console.log(stdout)
            console.log(stderr)
            reject(error)
          }
          resolve()
        }
      )
    })
    await renameAsync(`${diffDir}/${diffTmp}`, diff)
    diffStat = await lstatAsync(diff)
  }

  return diffStat
}
