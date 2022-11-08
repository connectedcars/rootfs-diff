import fs from 'fs'

import { runCommand, RunCommandOptions, runDiffCommand, RunDiffCommandOptions } from './utils'

export async function hasZucchini(options: RunCommandOptions = {}): Promise<boolean> {
  const res = await runCommand('zucchini', [], options)
  if (res.error) {
    if (res.stderr.match(/Main Usage:/)) {
      return true
    }
  }
  return false
}

export type ZucchiniOptions = RunDiffCommandOptions

export async function zucchini(from: string, to: string, diff: string, options?: ZucchiniOptions): Promise<fs.Stats> {
  return await runDiffCommand(['zucchini', '-gen', '$from', '$to', '$diff'], from, to, diff, options)
}
