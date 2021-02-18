import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import util from 'util'

const readdirAsync = util.promisify(fs.readdir)
const lstatAsync = util.promisify(fs.lstat)
const chmodAsync = util.promisify(fs.chmod)

export interface File {
  fullPath: string
  path: string
  size: number
  mode: number
  sha1sum: string
}

export async function listFolder(rootPath: string): Promise<File[]> {
  const results: File[] = []
  const dirs: string[] = [rootPath]
  while (dirs.length > 0) {
    const dir = dirs.shift() as string
    for (const file of await readdirAsync(dir)) {
      const filePath = path.resolve(dir, file)
      const fileStat = await lstatAsync(filePath).catch(() => null)
      if (fileStat === null) {
        // Skip symlinks pointing to nothing
        continue
      }
      if (fileStat.isDirectory()) {
        dirs.push(filePath)
      } else if (fileStat.isFile()) {
        const relativeFilePath = path.relative(rootPath, filePath)

        let sha1Sum: Buffer
        try {
          sha1Sum = await sha1File(filePath)
        } catch (e) {
          // Try setting permissions to see if this helps
          await chmodAsync(filePath, 0o644)
          sha1Sum = await sha1File(filePath)
          await chmodAsync(filePath, fileStat.mode)
        }

        results.push({
          fullPath: filePath,
          path: relativeFilePath,
          size: fileStat.size,
          mode: fileStat.mode,
          sha1sum: sha1Sum.toString('hex')
        })
      }
    }
  }
  return results
}

export function sha1File(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const output = crypto.createHash('sha1')
    const input = fs.createReadStream(path)

    input.on('error', err => {
      reject(err)
    })

    output.once('readable', () => {
      resolve(output.digest())
    })

    input.pipe(output)
  })
}

export function bsdiff(from: string, to: string, diff: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('bsdiff', [from, to, diff], (error, stdout, stderr) => {
      if (error) {
        console.log(stdout)
        console.log(stderr)
        reject(error)
      }
      resolve()
    })
  })
}
