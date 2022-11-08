import fs from 'fs'

import { runCommand, RunCommandOptions, runDiffCommand, RunDiffCommandOptions } from './utils'

export async function hasCourgette(options: RunCommandOptions = {}): Promise<boolean> {
  const res = await runCommand('courgette', [], options)
  if (res.error) {
    if (res.stderr.match(/Main Usage:/)) {
      return true
    }
  }
  return false
}

export type CourgetteOptions = RunDiffCommandOptions

export async function courgette(from: string, to: string, diff: string, options?: CourgetteOptions): Promise<fs.Stats> {
  return await runDiffCommand(['courgette', '-gen', '$from', '$to', '$diff'], from, to, diff, options)
}
