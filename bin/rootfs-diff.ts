#!/usr/bin/env node
/* eslint-disable no-console */

import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'
import yargs from 'yargs'

const mkdirAsync = util.promisify(fs.mkdir)
const lstatAsync = util.promisify(fs.lstat)
const writeFileAsync = util.promisify(fs.writeFile)
const rmAsync = util.promisify(fs.rm)
const fsUtimesAsync = util.promisify(fs.utimes)

import { bsdiff, hasBsdiff } from '../src/bsdiff'
import { courgette, hasCourgette } from '../src/courgette'
import { hasCpio, unCpio } from '../src/cpio'
import { diffoscope } from '../src/diffoscope'
import { unGzip } from '../src/gzip'
import { FileStat, listFolder, sha1File, time } from '../src/rootfs-diff'
import { hasUnsquashfs, unsquashfs } from '../src/squashfs'
import { hasVciff, vcdiff } from '../src/vcdiff'
import { hasZstd, unZstd, zstd, zstdDiff } from '../src/zstd'
import { hasZucchini, zucchini } from '../src/zucchini'

export class CommandLineError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

enum ImageTypes {
  SQUASH_FS = 'squashfs',
  CPIO = 'cpio',
  UNKNOWN = 'unknown'
}

enum CompressorType {
  ZSTD,
  ZSTD_DIFF,
  GZIP,
  BS_DIFF,
  VC_DIFF,
  VC_DIFF_ZSTD,
  COURGETTE,
  COURGETTE_ZSTD,
  ZUCCHINI,
  ZUCCHINI_ZSTD
}

interface CompressorResult {
  type: CompressorType
  size: number
  time: number
}

enum FileChangeType {
  NEW,
  SAME,
  UPDATED,
  REMOVED
}

interface NewFile {
  type: FileChangeType.NEW
  to: FileStat
  compressorResult: CompressorResult[]
}

interface RemovedFile {
  type: FileChangeType.REMOVED
  from: FileStat
  compressorResult: CompressorResult[]
}

interface SameFile {
  type: FileChangeType.SAME
  to: FileStat
  from: FileStat
  compressorResult: CompressorResult[]
}

interface UpdatedFile {
  type: FileChangeType.UPDATED
  from: FileStat
  to: FileStat
  sizeDiff: number
  compressorResult: CompressorResult[]
  diffoscope: string
}

type FileChange = NewFile | RemovedFile | SameFile | UpdatedFile

const soEndingRegex = /(?:-\d+(?:\.\d+){0,3}\.so|\.so(?:\.\d+){1,3})$/
const soBaseNameRegex = new RegExp(`^(.+)${soEndingRegex.source}`)
const soEndingRegexStrict = new RegExp(`^${soEndingRegex.source}`)

function print(msg: string, noOutput = false, maxLines = 100): void {
  if (!noOutput) {
    const outputLines = msg.split('\n')
    console.log(outputLines.slice(0, maxLines).join('\n'))
    if (outputLines.length > maxLines) {
      console.log('...')
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = await yargs
    .scriptName('rootfs-diff')
    .command('$0 [images..]', 'diff two or more images')
    .usage('$0 <from> <to>')
    .wrap(yargs.terminalWidth())
    .options({
      images: {
        describe: 'Images',
        type: 'string',
        default: [],
        coerce: (s: string | string[]) => (Array.isArray(s) ? s : [s])
      },
      useBsdiff: {
        describe: 'Use bsdiff for deltas',
        type: 'boolean',
        default: false
      },
      useVcdiff: {
        describe: 'Use vcdiff for deltas',
        type: 'boolean',
        default: false
      },
      useCourgette: {
        describe: 'Use courgette for deltas',
        type: 'boolean',
        default: false
      },
      useZucchini: {
        describe: 'Use zucchini for deltas',
        type: 'boolean',
        default: false
      },
      useZstdDelta: {
        describe: 'Use zstd for deltas',
        type: 'boolean',
        default: false
      },
      useZstd: {
        describe: 'Use zstd for compressing files and deltas',
        type: 'boolean',
        default: false
      },
      useDiffoscope: {
        describe: 'Use diffoscope to show changes',
        type: 'boolean',
        default: false
      },
      group: {
        describe: 'Group files by regex(s)',
        type: 'string',
        default: [],
        coerce: (s: string | string[]) => (Array.isArray(s) ? s : [s])
      },
      hideGroups: {
        describe: 'Hide files matching groups',
        type: 'boolean',
        default: false
      },
      cacheDir: {
        describe: 'Location to store cache files',
        type: 'string'
      }
    })
    .help()
    .strict()
    .parse(argv)

  if (flags.images.length !== 2) {
    yargs.showHelp()
    return 255
  }

  const groups: RegExp[] = flags.group.map(g => new RegExp(g))

  const diffCacheDir = flags.cacheDir ? flags.cacheDir : os.tmpdir() + path.sep + 'rootfs-diff'
  await mkdirAsync(diffCacheDir, { recursive: true })
  console.log(`Using cache folder: ${diffCacheDir}`)

  const useBsdiff = flags.useBsdiff && (await hasBsdiff())
  const useVcdiff = flags.useVcdiff && (await hasVciff())
  const useCourgette = flags.useCourgette && (await hasCourgette())
  const useZucchini = flags.useZucchini && (await hasZucchini())
  const useZstd = flags.useZstd && (await hasZstd())
  const useZstdDelta = flags.useZstdDelta && (await hasZstd())
  const useDiffoscope = await flags.useDiffoscope
  const useUnSquashFs = await hasUnsquashfs()
  const useCpio = await hasCpio()

  const paths: string[] = []
  const images: string[] = []
  for (const rootfsPath of flags.images) {
    const rootfsPathStat = await lstatAsync(rootfsPath)

    if (rootfsPathStat.isFile()) {
      // Detect image type
      let imageType: ImageTypes = ImageTypes.UNKNOWN
      if (rootfsPath.match(/\.squashfs/)) {
        if (!useUnSquashFs) {
          throw new CommandLineError(`unsquashfs not installed`)
        }
        imageType = ImageTypes.SQUASH_FS
      } else if (rootfsPath.match(/\.cpio/)) {
        if (!useCpio) {
          throw new CommandLineError(`cpio not installed`)
        }
        imageType = ImageTypes.CPIO
      }

      // Checksum image file
      const sha1Sum = await sha1File(rootfsPath)

      // Decompress image
      let imageFile = rootfsPath
      const compressionMatch = rootfsPath.match(/[^.]+\.(zst[d]|gz)?$/)
      if (compressionMatch) {
        imageFile = `${diffCacheDir}/${sha1Sum.toString('hex')}.${imageType}`
        switch (compressionMatch[1]) {
          case 'zst':
          case 'zstd': {
            await unZstd(rootfsPath, imageFile)
            break
          }
          case 'gz': {
            await unGzip(rootfsPath, imageFile)
            break
          }
          default: {
            throw Error(`Unknown compression match: ${compressionMatch[1]}`)
          }
        }
      }

      const rootfsCachePath = `${diffCacheDir}/${sha1Sum.toString('hex')}.rootfs`

      // Handle that MacOS wipes the files but not the folders in tmp
      // https://superuser.com/questions/187071/in-macos-how-often-is-tmp-deleted
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const rootfsCachePathStat = await lstatAsync(`${rootfsCachePath}`).catch(_ => null)
      if (os.platform() === 'darwin' && rootfsCachePathStat?.isDirectory()) {
        // Get the newest mTime of all folders and files
        const newestMtime = (await listFolder(rootfsCachePath, true))
          .map(f => f.mtime)
          .reduce((a, b) => (a > b ? a : b))

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const cacheFileStat = await lstatAsync(`${rootfsCachePath}.cache`).catch(_ => null)
        if (!cacheFileStat || newestMtime > cacheFileStat.mtime) {
          // Remove old cache file
          await rmAsync(`${rootfsCachePath}`, { recursive: true, force: true })

          // Create cache file and set mtime to newestMtime
          await writeFileAsync(`${rootfsCachePath}.cache`, '')
          await fsUtimesAsync(`${rootfsCachePath}.cache`, newestMtime, newestMtime)
        }
      }

      // Extract image file to folder
      if (imageType === ImageTypes.SQUASH_FS) {
        await unsquashfs(imageFile, rootfsCachePath, { fixPermissions: true })
      } else if (imageType === ImageTypes.CPIO) {
        await unCpio(imageFile, rootfsCachePath, { fixPermissions: true })
      } else {
        throw new CommandLineError(`unknown image format '${imageFile}'`)
      }

      // Add extracted folder and image files
      paths.push(rootfsCachePath)
      images.push(imageFile)
    } else {
      paths.push(rootfsPath)
    }
  }

  // Do image compression
  const [fromImage, toImage] = images
  const fromImageSha1Sum = (await sha1File(fromImage)).toString('hex')
  const toImageSha1Sum = (await sha1File(toImage)).toString('hex')
  const fromImageStat = await lstatAsync(fromImage)
  const toImageStat = await lstatAsync(toImage)

  let imageBsDiffSize = 0
  let imageBsDiffTime: number | null = null
  if (useBsdiff) {
    const bsDiffFile = `${diffCacheDir}/${fromImageSha1Sum}-${toImageSha1Sum}.image.bsdiff`
    const [bsDiffFileStat, runTime] = await time(bsdiff(fromImage, toImage, bsDiffFile))
    imageBsDiffSize = bsDiffFileStat.size
    imageBsDiffTime = runTime
  }

  let imageVcDiffSize = 0
  let imageVcDiffTime: number | null = null
  let imageVcDiffZstdDiffSize = 0
  let imageVcDiffZstdTime: number | null = null
  if (useVcdiff) {
    const vcDiffFile = `${diffCacheDir}/${fromImageSha1Sum}-${toImageSha1Sum}.image.vcdiff`
    const [vsDiffFileStat, runTime] = await time(vcdiff(fromImage, toImage, vcDiffFile))
    imageVcDiffSize = vsDiffFileStat.size
    imageVcDiffTime = runTime

    if (useZstd) {
      const vcDiffZstdFile = `${diffCacheDir}/${fromImageSha1Sum}-${toImageSha1Sum}.image.vcdiff.zstd`
      const [vcDiffZstdFileStat, runTime] = await time(zstd(vcDiffFile, vcDiffZstdFile))
      imageVcDiffZstdDiffSize = vcDiffZstdFileStat!.size
      imageVcDiffZstdTime = runTime
    }
  }

  let imageZstdDiffSize = 0
  let imageZstdDiffTime: number | null = null

  if (useZstdDelta) {
    const zstdDiffFile = `${diffCacheDir}/${fromImageSha1Sum}-${toImageSha1Sum}.image.zstddiff`
    const [zstdDiffFileStat, runTime] = await time(zstdDiff(fromImage, toImage, zstdDiffFile, { level: 19 }))
    imageZstdDiffSize = zstdDiffFileStat.size
    imageZstdDiffTime = runTime
  }

  console.log(
    `Image size ${fromImageStat.size} -> ${toImageStat.size} (size-diff: ${
      toImageStat.size - fromImageStat.size
    }, bsdiff: ${imageBsDiffSize}, vcdiff: ${imageVcDiffSize}, vcdiff-zstd: ${imageVcDiffZstdDiffSize}, zstd-diff: ${imageZstdDiffSize})`
  )

  // Do file comparison
  const fileChanges: FileChange[] = []

  const toAliases: Record<string, string[]> = {}
  const fromAliases: Record<string, string[]> = {}

  const [fromPath, toPath] = paths
  const fromFiles = await listFolder(fromPath)
  const toFiles = await listFolder(toPath)

  // Build alias lookup table for all symlinks
  for (const toFile of toFiles.filter(f => f.isSymbolicLink)) {
    const fileAliases = toAliases[toFile.symlinkPath]
      ? toAliases[toFile.symlinkPath]
      : (toAliases[toFile.symlinkPath] = [])
    fileAliases.push(toFile.path)
  }
  for (const fromFile of fromFiles.filter(f => f.isSymbolicLink)) {
    const fileAliases = fromAliases[fromFile.symlinkPath]
      ? toAliases[fromFile.symlinkPath]
      : (toAliases[fromFile.symlinkPath] = [])
    fileAliases.push(fromFile.path)
  }

  // Compare toFiles to fromFiles
  for (const toFile of toFiles.filter(f => f.isFile)) {
    const soBaseNameMatch = toFile.path.match(soBaseNameRegex)
    let fromFile = fromFiles
      .filter(f => f.isFile)
      .filter(f => {
        if (f.path === toFile.path) {
          return true
        } else if (
          soBaseNameMatch &&
          f.path.startsWith(soBaseNameMatch[1]) &&
          f.path.slice(soBaseNameMatch[1].length).match(soEndingRegexStrict)
        ) {
          return true
        } else if (f.path.replace(/\/libexec\//, '/lib/') === toFile.path.replace(/\/libexec\//, '/lib/')) {
          return true
        } else if (toAliases[toFile.path]?.some(a => a === f.path)) {
          return true
        } else if (fromAliases[f.path]?.some(a => a === toFile.path)) {
          return true
        }
        return false
      })

    if (fromFile.length === 0) {
      const toFileSha1Sum = (await sha1File(toFile.fullPath)).toString('hex')
      const compressorResult: CompressorResult[] = []
      if (useZstd) {
        const [zstdFileStat, runTime] = await time(zstd(toFile.fullPath, `${diffCacheDir}/${toFileSha1Sum}.zstd`))
        compressorResult.push({
          type: CompressorType.ZSTD,
          size: zstdFileStat.size,
          time: runTime
        })
      }
      fileChanges.push({ type: FileChangeType.NEW, to: toFile, compressorResult })
    } else {
      // Handle the case where a file is replaced by symlink to an existing file
      if (fromFile.length > 1) {
        const filteredFrom = fromFile.filter(f => f.path === toFile.path)
        if (filteredFrom.length === 1) {
          fromFile = filteredFrom
        } else {
          console.log(`Found more then one from file match: ${fromFile.map(f => f.path).join(', ')}`)
        }
      }

      const fromFileSha1Sum = (await sha1File(fromFile[0].fullPath)).toString('hex')
      const toFileSha1Sum = (await sha1File(toFile.fullPath)).toString('hex')

      const compressorResult: CompressorResult[] = []
      if (useZstd) {
        const [zstdFileStat, runTime] = await time(zstd(toFile.fullPath, `${diffCacheDir}/${toFileSha1Sum}.zstd`))
        compressorResult.push({
          type: CompressorType.ZSTD,
          size: zstdFileStat.size,
          time: runTime
        })
      }

      if (fromFileSha1Sum === toFileSha1Sum) {
        fileChanges.push({ type: FileChangeType.SAME, from: fromFile[0], to: toFile, compressorResult })
      } else {
        if (useBsdiff) {
          const bsDiffFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.bsdiff`
          const [bsDiffFileStat, runTime] = await time(bsdiff(fromFile[0].fullPath, toFile.fullPath, bsDiffFile))
          compressorResult.push({
            type: CompressorType.BS_DIFF,
            size: bsDiffFileStat.size,
            time: runTime
          })
        }

        if (useVcdiff) {
          const vcDiffFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.vcdiff`
          const [vsDiffFileStat, runTime] = await time(vcdiff(fromFile[0].fullPath, toFile.fullPath, vcDiffFile))
          compressorResult.push({
            type: CompressorType.VC_DIFF,
            size: vsDiffFileStat.size,
            time: runTime
          })

          if (useZstd) {
            const vcDiffZstdFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.vcdiff.zstd`
            const [vcDiffZstdFileStat, runTime] = await time(zstd(vcDiffFile, vcDiffZstdFile))
            compressorResult.push({
              type: CompressorType.VC_DIFF_ZSTD,
              size: vcDiffZstdFileStat.size,
              time: runTime
            })
          }
        }

        if (useZstdDelta) {
          const zstdDiffFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.zstddiff`
          const [zstdDiffFileStat, runTime] = await time(zstdDiff(fromFile[0].fullPath, toFile.fullPath, zstdDiffFile))
          compressorResult.push({
            type: CompressorType.ZSTD_DIFF,
            size: zstdDiffFileStat.size,
            time: runTime
          })
        }

        if (useCourgette) {
          const courgetteFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.courgette`
          const [courgetteFileStat, runTime] = await time(
            courgette(fromFile[0].fullPath, toFile.fullPath, courgetteFile)
          )
          compressorResult.push({
            type: CompressorType.COURGETTE,
            size: courgetteFileStat.size,
            time: runTime
          })

          if (useZstd) {
            const courgetteZstdFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.courgette.zstd`
            const [courgetteZstdFileStat, runTime] = await time(zstd(courgetteFile, courgetteZstdFile))
            compressorResult.push({
              type: CompressorType.COURGETTE_ZSTD,
              size: courgetteZstdFileStat.size,
              time: runTime
            })
          }
        }

        if (useZucchini) {
          const zucchiniFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.zucchini`
          const [zucchiniFileStat, runTime] = await time(zucchini(fromFile[0].fullPath, toFile.fullPath, zucchiniFile))
          compressorResult.push({
            type: CompressorType.ZUCCHINI,
            size: zucchiniFileStat.size,
            time: runTime
          })

          if (useZstd) {
            const zucchiniZstdFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.zucchini.zstd`
            const [zucchiniZstdFileStat, runTime] = await time(zstd(zucchiniFile, zucchiniZstdFile))
            compressorResult.push({
              type: CompressorType.ZUCCHINI_ZSTD,
              size: zucchiniZstdFileStat.size,
              time: runTime
            })
          }
        }

        let diffoscopeOutput = ''
        if (useDiffoscope) {
          const diffoscopeFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.diffoscope`
          diffoscopeOutput = await diffoscope(fromFile[0].fullPath, toFile.fullPath, diffoscopeFile)
        }

        fileChanges.push({
          type: FileChangeType.UPDATED,
          from: fromFile[0],
          to: toFile,
          sizeDiff: toFile.size - fromFile[0].size,
          compressorResult,
          diffoscope: diffoscopeOutput
        })
      }
    }
  }

  // Find all removed files
  for (const fromFile of fromFiles.filter(f => f.isFile)) {
    const sameOrUpdated = fileChanges.find(
      f => (f.type === FileChangeType.SAME || f.type === FileChangeType.UPDATED) && f.from.path == fromFile.path
    )
    if (sameOrUpdated) {
      continue
    }
    const fromFileSha1Sum = (await sha1File(fromFile.fullPath)).toString('hex')

    const compressorResult: CompressorResult[] = []
    if (useZstd) {
      const [zstdFileStat, runTime] = await time(zstd(fromFile.fullPath, `${diffCacheDir}/${fromFileSha1Sum}.zstd`))
      compressorResult.push({
        type: CompressorType.ZSTD,
        size: zstdFileStat.size,
        time: runTime
      })
    }

    fileChanges.push({ type: FileChangeType.REMOVED, from: fromFile, compressorResult })
  }

  // Print changes
  const groupNewSeen: Record<string, boolean> = {}
  print(`Grouped new files:`, flags.hideGroups)
  for (const groupRegex of groups) {
    const found = fileChanges.filter(
      (f): f is NewFile =>
        f.type === FileChangeType.NEW && !groupNewSeen[f.to.path] && f.to.path.match(groupRegex) !== null
    )
    if (found.length > 0) {
      const totalSize = found.map(f => f.to.size).reduce((a, c) => a + c, 0)
      const totalZstdSize = found
        .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
        .reduce((a, c) => a + c, 0)

      print(`  ${groupRegex}: (size: ${totalSize}, zstd: ${totalZstdSize})`, flags.hideGroups)
      for (const file of found) {
        const zstdSize = file.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0
        print(`    ${file.to.path}: (size: ${file.to.size}, zstd: ${zstdSize})`, flags.hideGroups)
        groupNewSeen[file.to.path] = true
      }
    }
  }

  const singleNewFiles = fileChanges.filter(
    (f): f is NewFile => f.type === FileChangeType.NEW && !groupNewSeen[f.to.path]
  )
  console.log(`Single new files:`)
  for (const file of singleNewFiles.sort((a, b) => b.to.size - a.to.size)) {
    const zstdSize = file.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0
    console.log(`  ${file.to.path}: (size: ${file.to.size}, zstd: ${zstdSize})`)
  }

  print(`Grouped removed files:`, flags.hideGroups)
  const groupRemovedSeen: Record<string, boolean> = {}
  for (const groupRegex of groups) {
    const found = fileChanges.filter(
      (f): f is RemovedFile =>
        f.type === FileChangeType.REMOVED && !groupRemovedSeen[f.from.path] && f.from.path.match(groupRegex) !== null
    )
    if (found.length > 0) {
      const totalSize = found.map(f => f.from.size).reduce((a, c) => a + c, 0)
      const totalZstdSize = found
        .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
        .reduce((a, c) => a + c, 0)
      print(`  ${groupRegex}: (size: ${totalSize}, zstd: ${totalZstdSize})`, flags.hideGroups)
      for (const file of found) {
        const zstdSize = file.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0
        print(`    ${file.from.path}: (size: ${file.from.size}, zstd: ${zstdSize})`, flags.hideGroups)
        groupRemovedSeen[file.from.path] = true
      }
    }
  }

  const singleRemovedFiles = fileChanges.filter(
    (f): f is RemovedFile => f.type === FileChangeType.REMOVED && !groupRemovedSeen[f.from.path]
  )
  console.log(`Single removed files:`)
  for (const file of singleRemovedFiles.sort((a, b) => b.from.size - a.from.size)) {
    const zstdSize = file.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0
    console.log(`  ${file.from.path}: (size: ${file.from.size}, zstd: ${zstdSize})`)
  }

  console.log(`Updated files:`)
  for (const updatedFile of fileChanges.filter((f): f is UpdatedFile => f.type === FileChangeType.UPDATED)) {
    const fromPath = updatedFile.from.path !== updatedFile.to.path ? `(${updatedFile.from.path})` : ''

    let diffStats = `size-diff:${updatedFile.sizeDiff}`
    for (const compressorType of Object.values(CompressorType).filter((v): v is number => !isNaN(Number(v)))) {
      const compressedSize = updatedFile.compressorResult.find(c => c.type === compressorType)?.size ?? 0

      if (compressedSize === 0) {
        continue
      }

      const compressorName = CompressorType[compressorType].toLocaleLowerCase()
      diffStats += `, ${compressorName}: ${compressedSize}`
    }

    console.log(
      `  ${updatedFile.to.path}${fromPath}: ${updatedFile.from.size} -> ${updatedFile.to.size} (${diffStats})`
    )
    print(updatedFile.diffoscope.replace(/(^|\n)(.)/gm, '$1  $2'), !useDiffoscope)
  }

  print(`Grouped files:`, flags.hideGroups)
  const groupToSeen: Record<string, boolean> = {}
  for (const groupRegex of groups) {
    const found = fileChanges.filter(
      (f): f is NewFile | SameFile | UpdatedFile =>
        (FileChangeType.NEW === f.type || FileChangeType.SAME === f.type || FileChangeType.UPDATED === f.type) &&
        !groupToSeen[f.to.path] &&
        f.to.path.match(groupRegex) !== null
    )
    for (const file of found) {
      groupToSeen[file.to.path] = true
    }

    if (found.length > 0) {
      const totalSize = found.map(f => f.to.size).reduce((a, c) => a + c, 0)
      const totalZstdSize = found
        .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
        .reduce((a, c) => a + c, 0)

      let totalDiffStats = ''
      for (const compressorType of Object.values(CompressorType).filter((v): v is number => !isNaN(Number(v)))) {
        const totalCompressedSize = found
          .map(f => f.compressorResult.find(c => c.type === compressorType)?.size ?? 0)
          .reduce((a, c) => a + c, 0)
        const compressorName = CompressorType[compressorType].toLocaleLowerCase()

        if (totalCompressedSize === 0) {
          continue
        }

        totalDiffStats += `, ${compressorName}: ${totalCompressedSize}`
      }

      print(`  ${groupRegex}: (size: ${totalSize}${totalDiffStats})`, flags.hideGroups)
      for (const file of found) {
        let diffStats = file.type === FileChangeType.UPDATED ? `, size-diff:${file.sizeDiff}` : ''
        for (const compressorType of Object.values(CompressorType).filter((v): v is number => !isNaN(Number(v)))) {
          const compressedSize = file.compressorResult.find(c => c.type === compressorType)?.size ?? 0
          const compressorName = CompressorType[compressorType].toLocaleLowerCase()

          if (compressedSize === 0) {
            continue
          }

          diffStats += `, ${compressorName}: ${compressedSize}`
        }
        print(`    ${file.to.path}: (size: ${file.to.size}${diffStats})`, flags.hideGroups)
      }
    }
  }

  console.log(`Totals:`)
  const totalSameFilesSize = fileChanges
    .filter((f): f is SameFile => f.type === FileChangeType.SAME)
    .map(f => f.to.size)
    .reduce((a, c) => a + c, 0)
  console.log(` unchanged files size   : ${totalSameFilesSize}`)

  const totalNewFilesSize = fileChanges
    .filter((f): f is NewFile => f.type === FileChangeType.NEW)
    .map(f => f.to.size)
    .reduce((a, c) => a + c, 0)
  const totalNewFilesZstdSize = fileChanges
    .filter((f): f is NewFile => f.type === FileChangeType.NEW)
    .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
    .reduce((a, c) => a + c, 0)
  const totalNewGroupSize = fileChanges
    .filter((f): f is NewFile => f.type === FileChangeType.NEW && groupNewSeen[f.to.path])
    .map(f => f.to.size)
    .reduce((a, c) => a + c, 0)
  const totalNewGroupZstdSize = fileChanges
    .filter((f): f is NewFile => f.type === FileChangeType.NEW && groupNewSeen[f.to.path])
    .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
    .reduce((a, c) => a + c, 0)
  const singleNewFilesSize = singleNewFiles.map(f => f.to.size).reduce((a, c) => a + c, 0)
  const singleNewFilesZstdSize = singleNewFiles
    .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
    .reduce((a, c) => a + c, 0)

  console.log(` new files size         : ${totalNewFilesSize} (zstd: ${totalNewFilesZstdSize})`)
  console.log(`   grouped : ${totalNewGroupSize} (zstd: ${totalNewGroupZstdSize})`)
  console.log(`   single  : ${singleNewFilesSize} (zstd: ${singleNewFilesZstdSize})`)

  const totalRemovedFilesSize = fileChanges
    .filter((f): f is RemovedFile => f.type === FileChangeType.REMOVED)
    .map(f => f.from.size)
    .reduce((a, c) => a + c, 0)
  const totalRemovedFilesZstdSize = fileChanges
    .filter((f): f is RemovedFile => f.type === FileChangeType.REMOVED)
    .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
    .reduce((a, c) => a + c, 0)
  const totalRemovedGroupSize = fileChanges
    .filter((f): f is RemovedFile => f.type === FileChangeType.REMOVED && groupRemovedSeen[f.from.path])
    .map(f => f.from.size)
    .reduce((a, c) => a + c, 0)
  const totalRemovedGroupZstdSize = fileChanges
    .filter((f): f is RemovedFile => f.type === FileChangeType.REMOVED && groupRemovedSeen[f.from.path])
    .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
    .reduce((a, c) => a + c, 0)
  const singleRemovedFilesSize = singleRemovedFiles.map(f => f.from.size).reduce((a, c) => a + c, 0)
  const singleRemovedFilesZstdSize = singleRemovedFiles
    .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
    .reduce((a, c) => a + c, 0)

  console.log(` removed files size     : ${totalRemovedFilesSize} (zstd: ${totalRemovedFilesZstdSize})`)
  console.log(`   grouped : ${totalRemovedGroupSize} (zstd: ${totalRemovedGroupZstdSize})`)
  console.log(`   single  : ${singleRemovedFilesSize} (zstd: ${singleRemovedFilesZstdSize})`)

  const totalUpdatedFromSize = fileChanges
    .filter((f): f is UpdatedFile => f.type === FileChangeType.UPDATED)
    .map(f => f.from.size)
    .reduce((a, c) => a + c, 0)
  const totalUpdatedToSize = fileChanges
    .filter((f): f is UpdatedFile => f.type === FileChangeType.UPDATED)
    .map(f => f.to.size)
    .reduce((a, c) => a + c, 0)

  let updatedCompressorStats = ''
  for (const compressorType of Object.values(CompressorType).filter((v): v is number => !isNaN(Number(v)))) {
    const totalCompressedSize = fileChanges
      .filter((f): f is UpdatedFile => f.type === FileChangeType.UPDATED)
      .map(f => f.compressorResult.find(c => c.type === compressorType)?.size ?? 0)
      .reduce((a, c) => a + c, 0)

    if (totalCompressedSize === 0) {
      continue
    }

    const compressorName = CompressorType[compressorType].toLocaleLowerCase()
    updatedCompressorStats += `, ${compressorName}: ${totalCompressedSize}`
  }

  console.log(
    ` updated files size     : ${totalUpdatedFromSize} -> ${totalUpdatedToSize} (size-diff: ${
      totalUpdatedToSize - totalUpdatedFromSize
    }${updatedCompressorStats})`
  )

  const totalDiffSize = totalUpdatedToSize + totalNewFilesSize
  let totalDiffCompressorStats = ''
  for (const compressorType of Object.values(CompressorType).filter((v): v is number => !isNaN(Number(v)))) {
    let compressorName = CompressorType[compressorType].toLocaleLowerCase()
    let totalUpdatedCompressedSize = fileChanges
      .filter((f): f is UpdatedFile => f.type === FileChangeType.UPDATED)
      .map(f => f.compressorResult.find(c => c.type === compressorType)?.size ?? 0)
      .reduce((a, c) => a + c, 0)

    if (totalUpdatedCompressedSize === 0) {
      continue
    }

    // Add zstd new files to to size of the delta files
    if (compressorType !== CompressorType.ZSTD) {
      const totalNewZstdSize = fileChanges
        .filter((f): f is NewFile => f.type === FileChangeType.NEW)
        .map(f => f.compressorResult.find(c => c.type === CompressorType.ZSTD)?.size ?? 0)
        .reduce((a, c) => a + c, 0)
      totalUpdatedCompressedSize += totalNewZstdSize
      compressorName += '+new-zstd'
    }
    totalDiffCompressorStats += `, ${compressorName}: ${totalUpdatedCompressedSize}`
  }

  console.log(` total diff size        : ${totalDiffSize} (${totalDiffCompressorStats}))`)

  return 0
}

main(process.argv.slice(2)).catch(e => {
  switch (e.constructor) {
    case CommandLineError: {
      console.error(`${e.message}`)
      console.error()
      break
    }
    default: {
      console.error(e.stack)
    }
  }
  process.exit(255)
})
