/* eslint-disable no-console */
import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import util from 'util'

const readdirAsync = util.promisify(fs.readdir)
const lstatAsync = util.promisify(fs.lstat)
const renameAsync = util.promisify(fs.rename)
const chmodAsync = util.promisify(fs.chmod)
const readlinkAsync = util.promisify(fs.readlink)
const writeFileAsync = util.promisify(fs.writeFile)
const readFileAsync = util.promisify(fs.readFile)

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

export interface BsdiffOptions {
  overwrite?: boolean
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

export function hasBsdiff(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('bsdiff', [], (error, stdout, stderr) => {
      if (error) {
        if (stderr.match(/bsdiff: usage:/)) {
          resolve(true)
        }
      }
      reject(false)
    })
  })
}

export interface CourgetteOptions {
  overwrite?: boolean
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

export function hasCourgette(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('docker', ['inspect', '--type=image', 'docker.io/library/courgette:latest'], error => {
      if (error) {
        reject(false)
      }
      resolve(true)
    })
  })
}

export async function zucchini(from: string, to: string, diff: string, options?: CourgetteOptions): Promise<fs.Stats> {
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
          'docker.io/library/deltatools',
          'zucchini',
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

export function hasZucchini(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('docker', ['inspect', '--type=image', 'docker.io/library/deltatools'], error => {
      if (error) {
        reject(false)
      }
      resolve(true)
    })
  })
}

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

export interface ZstdOptions {
  level?: number
  overwrite?: boolean
}

export async function zstd(from: string, to: string, options?: ZstdOptions): Promise<fs.Stats> {
  const mergedOptions = { level: 17, overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('zstd', [`-${mergedOptions.level}`, from, '-o', toTmp], (error, stdout, stderr) => {
        if (error) {
          console.log(stdout)
          console.log(stderr)
          reject(error)
        }
        resolve()
      })
    })
    await renameAsync(toTmp, to)
    toStat = await lstatAsync(to)
  }

  return toStat
}

export interface UnZstdOptions {
  overwrite?: boolean
}

export async function unZstd(from: string, to: string, options?: UnZstdOptions): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('zstd', [`-d`, from, '-o', toTmp], (error, stdout, stderr) => {
        if (error) {
          console.log(stdout)
          console.log(stderr)
          reject(error)
        }
        resolve()
      })
    })
    await renameAsync(toTmp, to)
    toStat = await lstatAsync(to)
  }
  return toStat
}

export function hasZstd(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('zstd', ['--help'], error => {
      if (error) {
        reject(false)
      }
      resolve(true)
    })
  })
}

export interface UnsquashfsOptions {
  fixPermissions?: boolean
  overwrite?: boolean
}

export async function unsquashfs(from: string, to: string, options?: UnsquashfsOptions): Promise<fs.Stats> {
  const mergedOptions = { overwrite: false, ...options }

  let toStat = await lstatAsync(to).catch(() => null)
  if (toStat === null || mergedOptions.overwrite) {
    const toTmp = `${to}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await new Promise<void>((resolve, reject) => {
      execFile('unsquashfs', [`-d`, toTmp, from], (error, stdout, stderr) => {
        if (error) {
          console.log(stdout)
          console.log(stderr)
          reject(error)
        }
        resolve()
      })
    })
    if (mergedOptions.fixPermissions) {
      const files = await listFolder(toTmp)
      // Fix permissions if some of the files are missing read permission, fx. sudo
      for (const file of files) {
        if (file.isFile && (file.mode & 0o400) === 0) {
          await chmodAsync(file.fullPath, file.mode | 0o400)
        }
      }
    }
    await renameAsync(toTmp, to)
    toStat = await lstatAsync(to)
  }
  return toStat
}

export function hasUnsquashfs(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('unsquashfs', ['--help'], (error, stdout, stderr) => {
      if (error) {
        if (stderr.match(/SYNTAX: unsquashfs/)) {
          resolve(true)
        }
      }
      reject(false)
    })
  })
}

export async function time<T>(promise: Promise<T>): Promise<[T, number]> {
  const start = process.hrtime()
  const result = await promise
  const diff = process.hrtime(start)
  return [result, diff[0] * 1000000 + diff[1] / 1000]
}
