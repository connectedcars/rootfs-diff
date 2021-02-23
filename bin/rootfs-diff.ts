#!/usr/bin/env node

import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'
import yargs from 'yargs'

const mkdirAsync = util.promisify(fs.mkdir)
const lstatAsync = util.promisify(fs.lstat)

import {
  bsdiff,
  courgette,
  File,
  hasBsdiff,
  hasCourgette,
  hasUnsquashfs,
  hasZstd,
  listFolder,
  sha1File,
  time,
  unsquashfs,
  unZstd,
  zstd
} from '../src/rootfs-diff'

export class CommandLineError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
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
}

const soEndingRegex = /(?:-\d+(?:\.\d+){0,3}\.so|\.so(?:\.\d+){1,3})$/
const soBaseNameRegex = new RegExp(`^(.+)${soEndingRegex.source}`)
const soEndingRegexStrict = new RegExp(`^${soEndingRegex.source}`)

// TODO: Make mapping table for symlinks so we track "cansend -> cansend.can-utils" changes

async function main(argv: string[]): Promise<number> {
  const { _: inputArgs, ...flags } = yargs
    .scriptName('rootfs-diff')
    .usage('$0 from to')
    .wrap(yargs.terminalWidth())
    .options({
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
      useZstd: {
        describe: 'Use zstd for compressing files and deltas',
        type: 'boolean',
        default: false
      },
      group: {
        describe: 'Group files by regex(s)',
        type: 'string',
        default: [] as string[], // Typings are broken, this removes undefined from the type
        coerce: (s: string | string[]) => (Array.isArray(s) ? s : [s])
      },
      cacheDir: {
        describe: 'Location to store cache files',
        type: 'string'
      }
    })
    .help()
    .strict()
    .parse(argv)

  const args = inputArgs.map(c => c.toString())

  if (args.length !== 2) {
    yargs.showHelp()
    return 255
  }

  const groups: RegExp[] = flags.group.map(g => new RegExp(g))

  const diffCacheDir = flags.cacheDir ? flags.cacheDir : os.tmpdir() + path.sep + 'rootfs-diff'
  await mkdirAsync(diffCacheDir, { recursive: true })
  console.log(`Using cache folder: ${diffCacheDir}`)

  const useBsdiff = flags.useBsdiff && (await hasBsdiff())
  const useCourgette = flags.useCourgette && (await hasCourgette())
  const useZstd = flags.useZstd && (await hasZstd())
  const useUnSquashFs = await hasUnsquashfs()

  const paths: string[] = []
  for (const rootfsPath of args) {
    const rootfsPathStat = await lstatAsync(rootfsPath)

    if (rootfsPathStat.isFile()) {
      if (!useUnSquashFs) {
        throw new CommandLineError(`unsquashfs not installed`)
      }
      let squashfsFile = rootfsPath
      const sha1Sum = await sha1File(rootfsPath)
      if (rootfsPath.match(/\.zst[d]?$/)) {
        squashfsFile = `${diffCacheDir}/${sha1Sum.toString('hex')}.squashfs`
        await unZstd(rootfsPath, squashfsFile)
      }

      // TODO: Handle that MacOS wipes the files but not the folder in tmp
      // https://superuser.com/questions/187071/in-macos-how-often-is-tmp-deleted
      const rootfsCachePath = `${diffCacheDir}/${sha1Sum.toString('hex')}.rootfs`
      await unsquashfs(squashfsFile, rootfsCachePath, { fixPermissions: true })
      paths.push(rootfsCachePath)
    } else {
      paths.push(rootfsPath)
    }
  }

  const [fromPath, toPath] = paths

  const fromFiles = await listFolder(fromPath)
  const toFiles = await listFolder(toPath)

  const newFiles: NewFile[] = []
  const updatedFiles: UpdateFile[] = []
  const sameFiles: SameFile[] = []
  for (const toFile of toFiles) {
    const soBaseNameMatch = toFile.path.match(soBaseNameRegex)

    const fromFile = fromFiles.filter(f => {
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
      if (fromFile.length > 1) {
        console.log(`Found more then one from file match: ${fromFile.map(f => f.path).join(', ')}`)
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
          courgetteZstdTime
        })
      }
    }
  }

  const removedFiles: RemovedFile[] = []
  for (const fromFile of fromFiles) {
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

  console.log(`Grouped new files:`)
  const groupNewSeen: Record<string, boolean> = {}
  for (const groupRegex of groups) {
    const found = newFiles.filter(f => !groupNewSeen[f.to.path] && f.to.path.match(groupRegex))
    if (found.length > 0) {
      const totalSize = found.map(f => f.to.size).reduce((a, c) => a + c, 0)
      const totalZstdSize = found.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
      console.log(`  ${groupRegex}: (size: ${totalSize}, zstd: ${totalZstdSize})`)
      for (const file of found) {
        console.log(`    ${file.to.path}: (size: ${file.to.size}, zstd: ${file.zstdSize})`)
        groupNewSeen[file.to.path] = true
      }
    }
  }

  const singleNewFiles = newFiles.filter(f => !groupNewSeen[f.to.path])
  console.log(`Single new files:`)
  for (const file of singleNewFiles.sort((a, b) => b.to.size - a.to.size)) {
    console.log(`  ${file.to.path}: (size: ${file.to.size}, zstd: ${file.zstdSize})`)
  }

  console.log(`Grouped removed files:`)
  const groupRemovedSeen: Record<string, boolean> = {}
  for (const groupRegex of groups) {
    const found = removedFiles.filter(f => !groupRemovedSeen[f.from.path] && f.from.path.match(groupRegex))
    if (found.length > 0) {
      const totalSize = found.map(f => f.from.size).reduce((a, c) => a + c, 0)
      const totalZstdSize = found.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
      console.log(`  ${groupRegex}: (size: ${totalSize}, zstd: ${totalZstdSize})`)
      for (const file of found) {
        console.log(`    ${file.from.path}: (size: ${file.from.size}, zstd: ${file.zstdSize})`)
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
    console.log(
      `  ${updatedFile.to.path}${fromPath}: ${updatedFile.from.size} -> ${updatedFile.to.size} (size-diff:${updatedFile.sizeDiff}, zstd: ${updatedFile.zstdSize}, bsdiff:${updatedFile.bsDiffSize}, courgette: ${updatedFile.courgetteDiffSize}, courgette-zstd: ${updatedFile.courgetteZstdDiffSize}))`
    )
  }

  console.log(`Grouped files:`)
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
      console.log(`  ${groupRegex}: (size: ${totalSize}, zstd: ${totalZstdSize})`)
      for (const file of found) {
        console.log(`    ${file.to.path}: (size: ${file.to.size}, zstd: ${file.zstdSize})`)
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
  const singleRemovedFilesSize = singleNewFiles.map(f => f.to.size).reduce((a, c) => a + c, 0)
  const singleRemovedFilesZstdSize = singleNewFiles.map(f => f.zstdSize).reduce((a, c) => a + c, 0)

  console.log(` removed files size     : ${totalRemovedFilesSize} (zstd: ${totalRemovedFilesZstdSize})`)
  console.log(`   grouped : ${totalRemovedGroupSize} (zstd: ${totalRemovedGroupZstdSize})`)
  console.log(`   single  : ${singleRemovedFilesSize} (zstd: ${singleRemovedFilesZstdSize})`)

  const totalUpdatedFromSize = updatedFiles.map(f => f.from.size).reduce((a, c) => a + c, 0)
  const totalUpdatedToSize = updatedFiles.map(f => f.to.size).reduce((a, c) => a + c, 0)
  const totalUpdateZstdSize = updatedFiles.map(f => f.zstdSize).reduce((a, c) => a + c, 0)
  const totalUpdateBsDiffSize = updatedFiles.map(f => f.bsDiffSize).reduce((a, c) => a + c, 0)
  const totalUpdateCourgetteSize = updatedFiles.map(f => f.courgetteDiffSize).reduce((a, c) => a + c, 0)
  const totalUpdateCourgetteZstdSize = updatedFiles.map(f => f.courgetteZstdDiffSize).reduce((a, c) => a + c, 0)

  console.log(
    ` updated files size     : ${totalUpdatedFromSize} -> ${totalUpdatedToSize} (diff: ${
      totalUpdatedToSize - totalUpdatedFromSize
    }, zstd:${totalUpdateZstdSize}, bsdiff: ${totalUpdateBsDiffSize}, courgette: ${totalUpdateCourgetteSize}, courgette-zstd: ${totalUpdateCourgetteZstdSize})`
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
