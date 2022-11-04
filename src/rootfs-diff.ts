/* eslint-disable no-console */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import util from 'util'

const readdirAsync = util.promisify(fs.readdir)
const lstatAsync = util.promisify(fs.lstat)
const readlinkAsync = util.promisify(fs.readlink)

export interface File {
  fullPath: string
  path: string
  dev: number
  ino: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  size: number
  blksize: number
  blocks: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
  isSymbolicLink: boolean
  isFile: boolean
  symlinkPath: string
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
      } else if (fileStat.isFile() || fileStat.isSymbolicLink()) {
        const relativeFilePath = path.relative(rootPath, filePath)

        let symlinkPath = ''
        if (fileStat.isSymbolicLink()) {
          const rawLinkPath = await readlinkAsync(filePath)
          if (rawLinkPath.match(/^\//)) {
            symlinkPath = rawLinkPath.replace(/^\//, '')
          } else {
            symlinkPath = path.relative(rootPath, path.resolve(dir, rawLinkPath))
          }
        }

        results.push({
          ...fileStat,
          fullPath: filePath,
          path: relativeFilePath,
          isFile: fileStat.isFile(),
          isSymbolicLink: fileStat.isSymbolicLink(),
          symlinkPath
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

export async function time<T>(promise: Promise<T>): Promise<[T, number]> {
  const start = process.hrtime()
  const result = await promise
  const diff = process.hrtime(start)
  return [result, diff[0] * 1000000 + diff[1] / 1000]
}
