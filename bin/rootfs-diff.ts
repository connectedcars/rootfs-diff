#!/usr/bin/env node
/* eslint-disable no-console */

import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'
import yargs from 'yargs'

const mkdirAsync = util.promisify(fs.mkdir)
const lstatAsync = util.promisify(fs.lstat)
const existsAsync = util.promisify(fs.exists)
const writeFileAsync = util.promisify(fs.writeFile)
const rmAsync = util.promisify(fs.rm)

import { bsdiff, hasBsdiff } from '../src/bsdiff'
import { courgette, hasCourgette } from '../src/courgette'
import { diffoscope } from '../src/diffoscope'
import { File, listFolder, sha1File, time } from '../src/rootfs-diff'
import { hasUnsquashfs, unsquashfs } from '../src/squashfs'
import { hasVciff, vcdiff } from '../src/vcdiff'
import { hasZstd, unZstd, zstd } from '../src/zstd'
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

interface NewFile {
  to: File
  zstdSize: number
  zstdTime: number | null
}

interface RemovedFile {
  from: File
  zstdSize: number
  zstdTime: number | null
}

interface SameFile {
  to: File
  from: File
  zstdSize: number
  zstdTime: number | null
}

interface UpdateFile {
  from: File
  to: File
  sizeDiff: number
  zstdSize: number
  zstdTime: number | null
  bsDiffSize: number
  bsDiffTime: number | null
  courgetteDiffSize: number
  courgetteTime: number | null
  courgetteZstdDiffSize: number
  courgetteZstdTime: number | null
  zucchiniDiffSize: number
  zucchiniTime: number | null
  zucchiniZstdDiffSize: number
  zucchiniZstdTime: number | null
  diffoscope: string
}

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
  const useVcdiff = flags.useBsdiff && (await hasVciff())
  const useCourgette = flags.useCourgette && (await hasCourgette())
  const useZucchini = flags.useZucchini && (await hasZucchini())
  const useZstd = flags.useZstd && (await hasZstd())
  const useDiffoscope = await flags.useDiffoscope
  const useUnSquashFs = await hasUnsquashfs()

  const paths: string[] = []
  const images: string[] = []
  for (const rootfsPath of flags.images) {
    const rootfsPathStat = await lstatAsync(rootfsPath)

    if (rootfsPathStat.isFile()) {
      let imageType: ImageTypes = ImageTypes.UNKNOWN
      if (rootfsPath.match(/\.squashfs/)) {
        if (!useUnSquashFs) {
          throw new CommandLineError(`unsquashfs not installed`)
        }
        imageType = ImageTypes.SQUASH_FS
      }

      // Checksum image file
      const sha1Sum = await sha1File(rootfsPath)

      // Decompress image
      const compressionMatch = rootfsPath.match(/([^.]+)\.zst[d]?$/)
      let imageFile = rootfsPath
      if (compressionMatch) {
        imageFile = `${diffCacheDir}/${sha1Sum.toString('hex')}.${imageType}`
        await unZstd(rootfsPath, imageFile)
      }

      // Unpack squashfs rootfs
      if (imageType === ImageTypes.SQUASH_FS) {
        const rootfsCachePath = `${diffCacheDir}/${sha1Sum.toString('hex')}.rootfs`
        if (os.platform() === 'darwin') {
          // Handle that MacOS wipes the files but not the folders in tmp
          // https://superuser.com/questions/187071/in-macos-how-often-is-tmp-deleted
          if (!(await existsAsync(`${rootfsCachePath}.cache`))) {
            await rmAsync(`${rootfsCachePath}`, { recursive: true, force: true })
            await writeFileAsync(`${rootfsCachePath}.cache`, '')
          }
        }
        await unsquashfs(imageFile, rootfsCachePath, { fixPermissions: true })
        paths.push(rootfsCachePath)
        images.push(imageFile)
      } else {
        throw new CommandLineError(`unknown image format '${imageFile}'`)
      }
    } else {
      paths.push(rootfsPath)
    }
  }

  const newFiles: NewFile[] = []
  const updatedFiles: UpdateFile[] = []
  const sameFiles: SameFile[] = []
  const toAliases: Record<string, string[]> = {}
  const fromAliases: Record<string, string[]> = {}

  // Do image compression
  const [fromImage, toImage] = images
  const fromImageSha1Sum = await sha1File(fromImage)
  const toImageSha1Sum = await sha1File(toImage)
  const fromImageStat = await lstatAsync(fromImage)
  const toImageStat = await lstatAsync(toImage)

  let imageBsDiffSize = 0
  let imageBsDiffTime: number | null = null
  if (useBsdiff) {
    const bsDiffFile = `${diffCacheDir}/${fromImageSha1Sum}-${toImageSha1Sum}.squashfs.bsdiff`
    const [bsDiffFileStat, runTime] = await time(bsdiff(fromImage, toImage, bsDiffFile))
    imageBsDiffSize = bsDiffFileStat.size
    imageBsDiffTime = runTime
  }

  let imageVcDiffSize = 0
  let imageVcDiffTime: number | null = null
  let imageVcDiffZstdDiffSize = 0
  let imageVcDiffZstdTime: number | null = null
  if (useVcdiff) {
    const vcDiffFile = `${diffCacheDir}/${fromImageSha1Sum}-${toImageSha1Sum}.squashfs.vcdiff`
    const [vsDiffFileStat, runTime] = await time(vcdiff(fromImage, toImage, vcDiffFile))
    imageVcDiffSize = vsDiffFileStat.size
    imageVcDiffTime = runTime

    if (useZstd) {
      const vcDiffZstdFile = `${diffCacheDir}/${fromImageSha1Sum}-${toImageSha1Sum}.vcdiff.zstd`
      const [vcDiffZstdFileStat, runTime] = await time(zstd(vcDiffFile, vcDiffZstdFile))
      imageVcDiffZstdDiffSize = vcDiffZstdFileStat!.size
      imageVcDiffZstdTime = runTime
    }
  }

  console.log(
    `Image size ${fromImageStat.size} -> ${toImageStat.size} (size-diff: ${
      toImageStat.size - fromImageStat.size
    }, bsdiff: ${imageBsDiffSize}, vcdiff: ${imageVcDiffSize}, vcdiff-zstd: ${imageVcDiffZstdDiffSize})`
  )

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
      let zstdSize = 0
      let zstdTime: number | null = null
      if (useZstd) {
        const [zstdFileStat, runTime] = await time(zstd(toFile.fullPath, `${diffCacheDir}/${toFileSha1Sum}.zstd`))
        zstdSize = zstdFileStat.size
        zstdTime = runTime
      }
      newFiles.push({ to: toFile, zstdTime, zstdSize: zstdSize })
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

      let zstdSize = 0
      let zstdTime: number | null = null
      if (useZstd) {
        const [zstdFileStat, runTime] = await time(zstd(toFile.fullPath, `${diffCacheDir}/${toFileSha1Sum}.zstd`))
        zstdSize = zstdFileStat.size
        zstdTime = runTime
      }

      if (fromFileSha1Sum === toFileSha1Sum) {
        sameFiles.push({ from: fromFile[0], to: toFile, zstdSize, zstdTime })
      } else {
        let bsDiffSize = 0
        let bsDiffTime: number | null = null
        if (useBsdiff) {
          const bsDiffFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.bsdiff`
          const [bsDiffFileStat, runTime] = await time(bsdiff(fromFile[0].fullPath, toFile.fullPath, bsDiffFile))
          bsDiffSize = bsDiffFileStat.size
          bsDiffTime = runTime
        }

        let courgetteDiffSize = 0
        let courgetteZstdDiffSize = 0
        let courgetteTime: number | null = null
        let courgetteZstdTime: number | null = null
        if (useCourgette) {
          const courgetteFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.courgette`
          const [courgetteFileStat, runTime] = await time(
            courgette(fromFile[0].fullPath, toFile.fullPath, courgetteFile)
          )
          courgetteTime = runTime
          courgetteDiffSize = courgetteFileStat!.size

          if (useZstd) {
            const courgetteZstdFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.courgette.zstd`
            const [courgetteZstdFileStat, runTime] = await time(zstd(courgetteFile, courgetteZstdFile))
            courgetteZstdTime = runTime
            courgetteZstdDiffSize = courgetteZstdFileStat!.size
          }
        }

        let zucchiniDiffSize = 0
        let zucchiniZstdDiffSize = 0
        let zucchiniTime: number | null = null
        let zucchiniZstdTime: number | null = null
        if (useZucchini) {
          const zucchiniFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.zucchini`
          const [zucchiniFileStat, runTime] = await time(zucchini(fromFile[0].fullPath, toFile.fullPath, zucchiniFile))
          zucchiniTime = runTime
          zucchiniDiffSize = zucchiniFileStat!.size

          if (useZstd) {
            const zucchiniZstdFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.zucchini.zstd`
            const [zucchiniZstdFileStat, runTime] = await time(zstd(zucchiniFile, zucchiniZstdFile))
            zucchiniZstdTime = runTime
            zucchiniZstdDiffSize = zucchiniZstdFileStat!.size
          }
        }

        let diffoscopeOutput = ''
        if (useDiffoscope) {
          const diffoscopeFile = `${diffCacheDir}/${fromFileSha1Sum}-${toFileSha1Sum}.diffoscope`
          diffoscopeOutput = await diffoscope(fromFile[0].fullPath, toFile.fullPath, diffoscopeFile)
        }

        updatedFiles.push({
          from: fromFile[0],
          to: toFile,
          sizeDiff: toFile.size - fromFile[0].size,
          zstdSize,
          zstdTime,
          bsDiffSize,
          bsDiffTime,
          courgetteDiffSize,
          courgetteTime,
          courgetteZstdDiffSize,
          courgetteZstdTime,
          zucchiniDiffSize,
          zucchiniTime,
          zucchiniZstdDiffSize,
          zucchiniZstdTime,
          diffoscope: diffoscopeOutput
        })
      }
    }
  }

  const removedFiles: RemovedFile[] = []
  for (const fromFile of fromFiles.filter(f => f.isFile)) {
    if (sameFiles.find(f => f.from.path == fromFile.path)) {
      continue
    } else if (updatedFiles.find(f => f.from.path == fromFile.path)) {
      continue
    }
    const fromFileSha1Sum = (await sha1File(fromFile.fullPath)).toString('hex')

    let zstdSize = 0
    let zstdTime: number | null = null
    if (useZstd) {
      const [zstdFileStat, runTime] = await time(zstd(fromFile.fullPath, `${diffCacheDir}/${fromFileSha1Sum}.zstd`))
      zstdSize = zstdFileStat.size
      zstdTime = runTime
    }

    removedFiles.push({ from: fromFile, zstdSize, zstdTime })
  }

  const groupNewSeen: Record<string, boolean> = {}
  print(`Grouped new files:`, flags.hideGroups)
  for (const groupRegex of groups) {
    const found = newFiles.filter(f => !groupNewSeen[f.to.path] && f.to.path.match(groupRegex))
    if (found.length > 0) {
      const totalSize = found.map(f => f.to.size).reduce((a, c) => a + c, 0)
      const totalZstdSize = found.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
      print(`  ${groupRegex}: (size: ${totalSize}, zstd: ${totalZstdSize})`, flags.hideGroups)
      for (const file of found) {
        print(`    ${file.to.path}: (size: ${file.to.size}, zstd: ${file.zstdSize})`, flags.hideGroups)
        groupNewSeen[file.to.path] = true
      }
    }
  }

  const singleNewFiles = newFiles.filter(f => !groupNewSeen[f.to.path])
  console.log(`Single new files:`)
  for (const file of singleNewFiles.sort((a, b) => b.to.size - a.to.size)) {
    console.log(`  ${file.to.path}: (size: ${file.to.size}, zstd: ${file.zstdSize})`)
  }

  print(`Grouped removed files:`, flags.hideGroups)
  const groupRemovedSeen: Record<string, boolean> = {}
  for (const groupRegex of groups) {
    const found = removedFiles.filter(f => !groupRemovedSeen[f.from.path] && f.from.path.match(groupRegex))
    if (found.length > 0) {
      const totalSize = found.map(f => f.from.size).reduce((a, c) => a + c, 0)
      const totalZstdSize = found.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
      print(`  ${groupRegex}: (size: ${totalSize}, zstd: ${totalZstdSize})`, flags.hideGroups)
      for (const file of found) {
        print(`    ${file.from.path}: (size: ${file.from.size}, zstd: ${file.zstdSize})`, flags.hideGroups)
        groupRemovedSeen[file.from.path] = true
      }
    }
  }

  const singleRemovedFiles = removedFiles.filter(f => !groupRemovedSeen[f.from.path])
  console.log(`Single removed files:`)
  for (const file of singleRemovedFiles.sort((a, b) => b.from.size - a.from.size)) {
    console.log(`  ${file.from.path}: (size: ${file.from.size}, zstd: ${file.zstdSize})`)
  }

  console.log(`Updated files:`)
  for (const updatedFile of updatedFiles.sort((a, b) => b.bsDiffSize - a.bsDiffSize)) {
    const fromPath = updatedFile.from.path !== updatedFile.to.path ? `(${updatedFile.from.path})` : ''
    let diffStats = `size-diff:${updatedFile.sizeDiff}, zstd: ${updatedFile.zstdSize}, bsdiff:${updatedFile.bsDiffSize}`
    diffStats += `, courgette: ${updatedFile.courgetteDiffSize}, courgette-zstd: ${updatedFile.courgetteZstdDiffSize}`
    diffStats += `, zucchini: ${updatedFile.zucchiniDiffSize}, zucchini-zstd: ${updatedFile.zucchiniZstdDiffSize}`
    console.log(
      `  ${updatedFile.to.path}${fromPath}: ${updatedFile.from.size} -> ${updatedFile.to.size} (${diffStats})`
    )
    print(updatedFile.diffoscope.replace(/(^|\n)(.)/gm, '$1  $2'), !useDiffoscope)
  }

  print(`Grouped files:`, flags.hideGroups)
  const groupToSeen: Record<string, boolean> = {}
  for (const groupRegex of groups) {
    const found: NewFile[] = []
    for (const fileList of [newFiles, sameFiles, updatedFiles]) {
      found.push(...fileList.filter(f => !groupToSeen[f.to.path] && f.to.path.match(groupRegex)))
      for (const file of found) {
        groupToSeen[file.to.path] = true
      }
    }
    if (found.length > 0) {
      const totalSize = found.map(f => f.to.size).reduce((a, c) => a + c, 0)
      const totalZstdSize = found.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
      print(`  ${groupRegex}: (size: ${totalSize}, zstd: ${totalZstdSize})`, flags.hideGroups)
      for (const file of found) {
        print(`    ${file.to.path}: (size: ${file.to.size}, zstd: ${file.zstdSize})`, flags.hideGroups)
      }
    }
  }

  console.log(`Totals:`)
  const totalSameFilesSize = sameFiles.map(f => f.to.size).reduce((a, c) => a + c, 0)
  console.log(` unchanged files size   : ${totalSameFilesSize}`)

  const totalNewFilesSize = newFiles.map(f => f.to.size).reduce((a, c) => a + c, 0)
  const totalNewFilesZstdSize = newFiles.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
  const totalNewGroupSize = newFiles
    .filter(f => groupNewSeen[f.to.path])
    .map(f => f.to.size)
    .reduce((a, c) => a + c, 0)
  const totalNewGroupZstdSize = newFiles
    .filter(f => groupNewSeen[f.to.path])
    .map(f => f.zstdSize)
    .reduce((a, c) => a + c, 0)
  const singleNewFilesSize = singleNewFiles.map(f => f.to.size).reduce((a, c) => a + c, 0)
  const singleNewFilesZstdSize = singleNewFiles.map(f => f.zstdSize).reduce((a, c) => a + c, 0)

  console.log(` new files size         : ${totalNewFilesSize} (zstd: ${totalNewFilesZstdSize})`)
  console.log(`   grouped : ${totalNewGroupSize} (zstd: ${totalNewGroupZstdSize})`)
  console.log(`   single  : ${singleNewFilesSize} (zstd: ${singleNewFilesZstdSize})`)

  const totalRemovedFilesSize = removedFiles.map(f => f.from.size).reduce((a, c) => a + c, 0)
  const totalRemovedFilesZstdSize = removedFiles.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
  const totalRemovedGroupSize = removedFiles
    .filter(f => groupRemovedSeen[f.from.path])
    .map(f => f.from.size)
    .reduce((a, c) => a + c, 0)
  const totalRemovedGroupZstdSize = newFiles
    .filter(f => groupNewSeen[f.to.path])
    .map(f => f.zstdSize)
    .reduce((a, c) => a + c, 0)
  const singleRemovedFilesSize = removedFiles.map(f => f.from.size).reduce((a, c) => a + c, 0)
  const singleRemovedFilesZstdSize = removedFiles.map(f => f.zstdSize).reduce((a, c) => a + c, 0)

  console.log(` removed files size     : ${totalRemovedFilesSize} (zstd: ${totalRemovedFilesZstdSize})`)
  console.log(`   grouped : ${totalRemovedGroupSize} (zstd: ${totalRemovedGroupZstdSize})`)
  console.log(`   single  : ${singleRemovedFilesSize} (zstd: ${singleRemovedFilesZstdSize})`)

  const totalUpdatedFromSize = updatedFiles.map(f => f.from.size).reduce((a, c) => a + c, 0)
  const totalUpdatedToSize = updatedFiles.map(f => f.to.size).reduce((a, c) => a + c, 0)
  const totalUpdateZstdSize = updatedFiles.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
  const totalUpdateBsDiffSize = updatedFiles.map(f => f.bsDiffSize).reduce((a, c) => a + c, 0)
  const totalUpdateCourgetteSize = updatedFiles.map(f => f.courgetteDiffSize).reduce((a, c) => a + c, 0)
  const totalUpdateCourgetteZstdSize = updatedFiles.map(f => f.courgetteZstdDiffSize).reduce((a, c) => a + c, 0)
  const totalUpdateZucchiniSize = updatedFiles.map(f => f.zucchiniDiffSize).reduce((a, c) => a + c, 0)
  const totalUpdateZucchiniZstdSize = updatedFiles.map(f => f.zucchiniZstdDiffSize).reduce((a, c) => a + c, 0)

  console.log(
    ` updated files size     : ${totalUpdatedFromSize} -> ${totalUpdatedToSize} (size-diff: ${
      totalUpdatedToSize - totalUpdatedFromSize
    }, zstd:${totalUpdateZstdSize}, bsdiff: ${totalUpdateBsDiffSize}, courgette: ${totalUpdateCourgetteSize}, courgette-zstd: ${totalUpdateCourgetteZstdSize}, zucchini: ${totalUpdateZucchiniSize}, zucchini-zstd: ${totalUpdateZucchiniZstdSize})`
  )

  const totalDiffSize = totalUpdatedToSize + totalNewFilesSize
  const totalDiffZstdSize = totalUpdateZstdSize + totalNewFilesZstdSize
  const totalDiffBsDiffSize = totalUpdateBsDiffSize + totalNewFilesZstdSize

  console.log(
    ` total diff size        : ${totalDiffSize} (zstd:${totalDiffZstdSize}, bsdiff+new-zstd: ${totalDiffBsDiffSize}))`
  )

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
