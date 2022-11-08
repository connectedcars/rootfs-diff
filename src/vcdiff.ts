import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import util from 'util'

import { runCommand, RunCommandOptions, runDiffCommand } from './utils'

const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)

export async function hasVciff(options: RunCommandOptions = {}): Promise<boolean> {
  const res = await runCommand('vcdiff', ['--help'], options)
  if (res.error) {
    if (res.stdout.match(/vcdiff:\s*\{encode/)) {
      return true
    }
  }
  return false
}

export interface VcDiffOptions {
  overwrite?: boolean
}

// vcdiff encode -dictionary ccupd.tar.gz --target ccupd.tar.gz.2 --delta ccupd.tar.gz.vcdiff
export async function vcdiff(from: string, to: string, diff: string, options?: VcDiffOptions): Promise<fs.Stats> {
  return await runDiffCommand(
    ['vcdiff', 'encode', '-dictionary', '$from', '--target', '$to', '--delta', '$diff'],
    from,
    to,
    diff,
    options
  )
}
