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

        results.push({
          fullPath: filePath,
          path: relativeFilePath,
          size: fileStat.size,
          mode: fileStat.mode
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

export function courgette(from: string, to: string, diff: string): Promise<void> {
  const [fromDir, fromFile] = [path.dirname(from), path.basename(from)]
  const [toDir, toFile] = [path.dirname(to), path.basename(to)]
  const [diffDir, diffFile] = [path.dirname(diff), path.basename(diff)]

  return new Promise((resolve, reject) => {
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
        `/diff/${diffFile}`
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
}

export function diffoscope(from: string, to: string, diff: string): Promise<void> {
  const [fromDir, fromFile] = [path.dirname(from), path.basename(from)]
  const [toDir, toFile] = [path.dirname(to), path.basename(to)]

  return new Promise((resolve, reject) => {
    execFile(
      // docker run --rm -t -w $(pwd) -v $(pwd):$(pwd):ro registry.salsa.debian.org/reproducible-builds/diffoscope cc-image-iwg26.gatesgarthfixed/usr/bin/ssh.openssh cc-image-iwg26.gatesgarthnewnode/usr/bin/ssh.openssh
      'docker',
      [
        'run',
        `-v${fromDir}:/from`,
        `-v${toDir}:/to`,
        'registry.salsa.debian.org/reproducible-builds/diffoscope',
        `/from/${fromFile}`,
        `/to/${toFile}`
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

// TODO: Make all oprations atomic with tmp renames

export function zstd(from: string, to: string, level = 17): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('zstd', [`-${level}`, from, '-o', to], (error, stdout, stderr) => {
      if (error) {
        console.log(stdout)
        console.log(stderr)
        reject(error)
      }
      resolve()
    })
  })
}

export function unZstd(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('zstd', [`-d`, from, '-o', to], (error, stdout, stderr) => {
      if (error) {
        console.log(stdout)
        console.log(stderr)
        reject(error)
      }
      resolve()
    })
  })
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

export function unsquashfs(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('unsquashfs', [`-d`, to, from], (error, stdout, stderr) => {
      if (error) {
        console.log(stdout)
        console.log(stderr)
        reject(error)
      }
      resolve()
    })
  })
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
