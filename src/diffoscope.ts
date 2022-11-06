import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import util from 'util'

export const lstatAsync = util.promisify(fs.lstat)
export const renameAsync = util.promisify(fs.rename)
export const writeFileAsync = util.promisify(fs.writeFile)
export const readFileAsync = util.promisify(fs.readFile)

export interface DiffoscopeOptions {
  overwrite?: boolean
  maxTextReportSize?: number
}

export async function diffoscope(from: string, to: string, diff: string, options?: DiffoscopeOptions): Promise<string> {
  const mergedOptions = { maxTextReportSize: 8192, ...options }

  const [fromDir, fromFile] = [path.dirname(from), path.basename(from)]
  const [toDir, toFile] = [path.dirname(to), path.basename(to)]

  let result: string | undefined = undefined

  const diffStat = await lstatAsync(diff).catch(() => null)
  if (diffStat === null || mergedOptions.overwrite) {
    result = await new Promise<string>((resolve, reject) => {
      const args = [
        'run',
        '--platform=linux/amd64',
        `-v${fromDir}:/from`,
        `-v${toDir}:/to`,
        'registry.salsa.debian.org/reproducible-builds/diffoscope',
        `--max-text-report-size=${mergedOptions.maxTextReportSize}`,
        `/from/${fromFile}`,
        `/to/${toFile}`
      ]
      console.log(args.join(' '))
      execFile('docker', args, { maxBuffer: 10485760 }, (error, stdout, stderr) => {
        if (error && error.code !== 1) {
          console.log(stdout)
          console.log(stderr)
          reject(error)
        }
        resolve(stdout)
      })
    })
    await writeFileAsync(diff, result)
  }

  if (!result) {
    result = (await readFileAsync(diff)).toString('utf8')
  }

  return result
}
