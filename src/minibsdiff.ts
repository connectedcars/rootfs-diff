import fs from 'fs'

import { runCommand, RunCommandOptions, runDiffCommand, RunDiffCommandOptions } from './utils'

export async function hasMiniBsdiff(options: RunCommandOptions = {}): Promise<boolean> {
  const res = await runCommand('minibsdiff', [], options)
  if (res.error) {
    if (res.stdout.match(/usage:/)) {
      return true
    }
  }
  return false
}

export type MiniBsdiff2Options = RunDiffCommandOptions

export async function miniBsdiff(
  from: string,
  to: string,
  diff: string,
  options?: MiniBsdiff2Options
): Promise<fs.Stats> {
  return await runDiffCommand(['minibsdiff', 'gen', '$from', '$to', '$diff'], from, to, diff, options)
}
