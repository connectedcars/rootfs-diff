import { ExecException, execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import util from 'util'

const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)

export interface RunCommandOptions {
  container?: string
}

export interface RunCommandResult {
  error: ExecException | null
  stdout: string
  stderr: string
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  if (options.container) {
    command = 'docker'
    args = ['run', options.container, command, ...args]
  }
  // Run the command
  return await new Promise<RunCommandResult>(resolve => {
    execFile(command, args, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr })
    })
  })
}

export interface RunDiffCommandOptions {
  container?: string
  overwrite?: boolean
}

export async function runDiffCommand(
  template: string[],
  from: string,
  to: string,
  diff: string,
  options: RunDiffCommandOptions = {}
): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }
  const diffStat = await lstatAsync(diff).catch(() => null)

  // Return cached file if patch already exists
  if (diffStat !== null && !mergedOptions.overwrite) {
    return diffStat
  }

  let command: string
  let args: string[]
  let diffTmp: string

  if (options.container) {
    const [fromDir, fromFile] = [path.dirname(from), path.basename(from)]
    const [toDir, toFile] = [path.dirname(to), path.basename(to)]
    const [diffDir, diffFile] = [path.dirname(diff), path.basename(diff)]
    const diffTmpFile = `${diffFile}.tmp.${crypto.randomBytes(4).toString('hex')}`
    diffTmp = `${diffDir}/${diffTmpFile}`

    // Replace in template and add docker wrapping
    command = 'docker'
    args = [
      'run',
      `-v${fromDir}:/from`,
      `-v${toDir}:/to`,
      `-v${diffDir}:/diff`,
      options.container,
      ...template.map(t =>
        t
          .replace(/\$from/, `/from/${fromFile}`)
          .replace(/\$to/, `/to/${toFile}`)
          .replace(/\$diff/, `/diff/${diffTmpFile}`)
      )
    ]
  } else {
    // Replace in template
    diffTmp = `${diff}.tmp.${crypto.randomBytes(4).toString('hex')}`
    ;[command, ...args] = template.map(t =>
      t
        .replace(/\$from/, from)
        .replace(/\$to/, to)
        .replace(/\$diff/, diffTmp)
    )
  }

  // Run the command
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        console.log(stdout)
        console.log(stderr)
        reject(error)
      }
      resolve()
    })
  })

  await renameAsync(`${diffTmp}`, diff)
  return await lstatAsync(diff)
}
