import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'

const mkdirAsync = util.promisify(fs.mkdir)
const lstatAsync = util.promisify(fs.lstat)
const chmodAsync = util.promisify(fs.chmod)

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
  unsquashfs,
  unZstd,
  zstd
} from '../src/rootfs-diff'

const soEndingRegex = /(?:-\d+(?:\.\d+){0,3}\.so|\.so(?:\.\d+){1,3})$/
const soBaseNameRegex = new RegExp(`^(.+)${soEndingRegex.source}`)
const soEndingRegexStrict = new RegExp(`^${soEndingRegex.source}`)

const groups: RegExp[] = [/zstd[^/]*$/, /^usr\/share\/alsa\/ucm2/, /sudo.+log/, /fido.id/]

async function main(args: string[]): Promise<number> {
  const diffCachePath = os.tmpdir() + path.sep + 'rootfs-diff'
  await mkdirAsync(diffCachePath, { recursive: true })
  console.log(`Using cache folder: ${diffCachePath}`)

  const useBsdiff = await hasBsdiff()
  const useCourgette = await hasCourgette()
  const useZstd = await hasZstd()
  const useUnSquashFs = await hasUnsquashfs()

  const paths: string[] = []
  for (const rootfsPath of args) {
    const rootfsPathStat = await lstatAsync(rootfsPath)

    if (rootfsPathStat.isFile()) {
      let squashfsFile = rootfsPath
      const sha1Sum = await sha1File(rootfsPath)
      if (rootfsPath.match(/\.zst[d]?$/)) {
        squashfsFile = `${diffCachePath}/${sha1Sum.toString('hex')}.squashfs`
        const squashfsFileStat = await lstatAsync(squashfsFile).catch(() => null)
        if (squashfsFileStat === null) {
          await unZstd(rootfsPath, squashfsFile)
        }
      }
      const rootfsCachePath = `${diffCachePath}/${sha1Sum.toString('hex')}.rootfs`
      const rootfsCacheStat = await lstatAsync(rootfsCachePath).catch(() => null)
      if (rootfsCacheStat === null) {
        await unsquashfs(squashfsFile, rootfsCachePath)
        const files = await listFolder(rootfsCachePath)
        // Fix permissions if some of the files are missing read permission, fx. sudo
        for (const file of files) {
          if ((file.mode & 0o400) === 0) {
            await chmodAsync(file.fullPath, file.mode | 0o400)
          }
        }
      }
      paths.push(rootfsCachePath)
    } else {
      paths.push(rootfsPath)
    }
  }

  const [fromPath, toPath] = paths

  const fromFiles = await listFolder(fromPath)
  const toFiles = await listFolder(toPath)

  const newFiles: File[] = []
  const updatedFiles: Array<{
    from: File
    to: File
    sizeDiff: number
    bsDiffSize: number
    bsDiffTime: number[] | null
    courgetteDiffSize: number
    courgetteTime: number[] | null
    courgetteZstdDiffSize: number
    courgetteZstdTime: number[] | null
  }> = []
  const sameFiles: Array<{ from: File; to: File }> = []
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
    })

    if (fromFile.length === 0) {
      newFiles.push(toFile)
    } else if (fromFile.length === 1) {
      const fromFileSha1Sum = (await sha1File(fromFile[0].fullPath)).toString('hex')
      const toFileSha1Sum = (await sha1File(toFile.fullPath)).toString('hex')
      if (fromFileSha1Sum === toFileSha1Sum) {
        sameFiles.push({ from: fromFile[0], to: toFile })
      } else {
        let bsDiffSize = 0
        let bsDiffTime: number[] | null = null
        if (useBsdiff) {
          const bsDiffFile = `${diffCachePath}/${fromFileSha1Sum}-${toFileSha1Sum}.bsdiff`
          let bsDiffFileStat = await lstatAsync(bsDiffFile).catch(() => null)
          if (bsDiffFileStat === null) {
            const bsDiffStartTime = process.hrtime()
            await bsdiff(fromFile[0].fullPath, toFile.fullPath, bsDiffFile)
            bsDiffFileStat = await lstatAsync(bsDiffFile).catch(() => null)
            bsDiffTime = process.hrtime(bsDiffStartTime)
          }
          bsDiffSize = bsDiffFileStat?.size ? bsDiffFileStat?.size : -1
        }

        let courgetteDiffSize = 0
        let courgetteZstdDiffSize = 0
        let courgetteTime: number[] | null = null
        let courgetteZstdTime: number[] | null = null
        if (useCourgette) {
          const courgetteFile = `${diffCachePath}/${fromFileSha1Sum}-${toFileSha1Sum}.courgette`
          let courgetteFileStat = await lstatAsync(courgetteFile).catch(() => null)
          if (courgetteFileStat === null) {
            const courgetteStartTime = process.hrtime()
            await courgette(fromFile[0].fullPath, toFile.fullPath, courgetteFile)
            courgetteFileStat = await lstatAsync(courgetteFile).catch(() => null)
            courgetteTime = process.hrtime(courgetteStartTime)
          }
          courgetteDiffSize = courgetteFileStat?.size ? courgetteFileStat?.size : -1

          const courgetteZstdFile = `${diffCachePath}/${fromFileSha1Sum}-${toFileSha1Sum}.courgette.zstd`
          let courgetteZstdFileStat = await lstatAsync(courgetteZstdFile).catch(() => null)
          if (courgetteZstdFileStat === null) {
            const courgetteZstdStartTime = process.hrtime()
            await zstd(courgetteFile, courgetteZstdFile)
            courgetteZstdTime = process.hrtime(courgetteZstdStartTime)
            courgetteZstdFileStat = await lstatAsync(courgetteZstdFile).catch(() => null)
          }
          courgetteZstdDiffSize = courgetteZstdFileStat?.size ? courgetteZstdFileStat?.size : -1
        }

        updatedFiles.push({
          from: fromFile[0],
          to: toFile,
          sizeDiff: toFile.size - fromFile[0].size,
          bsDiffSize: bsDiffSize,
          bsDiffTime: bsDiffTime,
          courgetteDiffSize: courgetteDiffSize,
          courgetteTime: courgetteTime,
          courgetteZstdDiffSize: courgetteZstdDiffSize,
          courgetteZstdTime: courgetteZstdTime
        })
      }
    } else {
      console.log(`Found more then one from file match: ${fromFile.map(f => f.path).join(', ')}`)
      newFiles.push(toFile)
    }
  }

  console.log(`Grouped new files:`)
  const groupSeen: Record<string, boolean> = {}
  for (const groupRegex of groups) {
    const found = newFiles.filter(f => !groupSeen[f.path] && f.path.match(groupRegex))
    if (found.length > 0) {
      console.log(`  ${groupRegex}: ${found.map(f => f.size).reduce((a, c) => a + c)}`)
      for (const file of found) {
        console.log(`    ${file.path}: ${file.size}`)
        groupSeen[file.path] = true
      }
    }
  }

  const singleNewFiles = newFiles.filter(f => !groupSeen[f.path])
  console.log(`Single new files:`)
  for (const file of singleNewFiles.sort((a, b) => b.size - a.size)) {
    console.log(`  ${file.path}: ${file.size}`)
  }

  console.log(`Updated files`)
  for (const updatedFile of updatedFiles.sort((a, b) => b.bsDiffSize - a.bsDiffSize)) {
    console.log(
      `  ${updatedFile.to.path}${updatedFile.from.path !== updatedFile.to.path ? `(${updatedFile.from.path})` : ''}: ${
        updatedFile.from.size
      } -> ${updatedFile.to.size} (diff:${updatedFile.sizeDiff}, bsdiff:${updatedFile.bsDiffSize}, courgette: ${
        updatedFile.courgetteDiffSize
      }, courgette-zstd: ${updatedFile.courgetteZstdDiffSize}))`
    )
  }

  console.log(`Totals:`)
  const totalSameFilesSize = sameFiles.map(f => f.to.size).reduce((a, c) => a + c)
  console.log(` unchanged files size   : ${totalSameFilesSize}`)

  let totalNewFilesSize = 0
  let totalGroupSize = 0
  if (newFiles.length > 0) {
    totalNewFilesSize = newFiles.map(f => f.size).reduce((a, c) => a + c)
    totalGroupSize = newFiles
      .filter(f => groupSeen[f.path])
      .map(f => f.size)
      .reduce((a, c) => a + c)
  }

  let singleNewFilesSize = 0
  if (singleNewFiles.length > 0) {
    singleNewFilesSize = singleNewFiles.map(f => f.size).reduce((a, c) => a + c)
  }

  console.log(` new files size         : ${totalNewFilesSize}`)
  console.log(`   grouped : ${totalGroupSize}`)
  console.log(`   single  : ${singleNewFilesSize}`)

  let totalUpdatedFromSize = 0
  let totalUpdatedToSize = 0
  let totalUpdateBsDiffSize = 0
  let totalUpdateCourgetteSize = 0
  let totalUpdateCourgetteZstdSize = 0
  if (updatedFiles.length > 0) {
    totalUpdatedFromSize = updatedFiles.map(f => f.from.size).reduce((a, c) => a + c)
    totalUpdatedToSize = updatedFiles.map(f => f.to.size).reduce((a, c) => a + c)
    totalUpdateBsDiffSize = updatedFiles.map(f => f.bsDiffSize).reduce((a, c) => a + c)
    totalUpdateCourgetteSize = updatedFiles.map(f => f.courgetteDiffSize).reduce((a, c) => a + c)
    totalUpdateCourgetteZstdSize = updatedFiles.map(f => f.courgetteZstdDiffSize).reduce((a, c) => a + c)
  }

  console.log(
    ` updated files size     : ${totalUpdatedFromSize} -> ${totalUpdatedToSize} (diff: ${
      totalUpdatedToSize - totalUpdatedFromSize
    }, bsdiff: ${totalUpdateBsDiffSize}, courgette: ${totalUpdateCourgetteSize}, courgette-zstd: ${totalUpdateCourgetteZstdSize})`
  )

  return 0
}

main(process.argv.slice(2)).catch(e => {
  console.error(e)
  process.exit(255)
})
