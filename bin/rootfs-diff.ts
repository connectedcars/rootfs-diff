import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'

const mkdirAsync = util.promisify(fs.mkdir)
const lstatAsync = util.promisify(fs.lstat)

import { bsdiff, courgette, File, listFolder, zstd } from '../src/rootfs-diff'

const soEndingRegex = /(?:-\d+(?:\.\d+){0,3}\.so|\.so(?:\.\d+){1,3})$/
const soBaseNameRegex = new RegExp(`^(.+)${soEndingRegex.source}`)
const soEndingRegexStrict = new RegExp(`^${soEndingRegex.source}`)

const groups: RegExp[] = [/zstd[^/]*$/, /^usr\/share\/alsa\/ucm2/, /sudo.+log/, /fido.id/]

async function main(args: string[]): Promise<number> {
  const diffCachePath = os.tmpdir() + path.sep + 'rootfs-diff'
  await mkdirAsync(diffCachePath, { recursive: true })

  const [fromPath, toPath] = args
  const fromFiles = await listFolder(fromPath)
  const toFiles = await listFolder(toPath)

  const newFiles: File[] = []
  const updatedFiles: Array<{
    from: File
    to: File
    sizeDiff: number
    bsDiffSize: number
    courgetteDiffSize: number
    courgetteZstdDiffSize: number
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
      if (fromFile[0].sha1sum === toFile.sha1sum) {
        sameFiles.push({ from: fromFile[0], to: toFile })
      } else {
        const bsDiffFile = `${diffCachePath}/${fromFile[0].sha1sum}-${toFile.sha1sum}.bsdiff`
        let bsDiffFileStat = await lstatAsync(bsDiffFile).catch(() => null)
        if (bsDiffFileStat === null) {
          console.time(`bsdiff ${fromFile[0].fullPath} ${toFile.fullPath}`)
          await bsdiff(fromFile[0].fullPath, toFile.fullPath, bsDiffFile)
          bsDiffFileStat = await lstatAsync(bsDiffFile).catch(() => null)
        }
        const bsDiffSize = bsDiffFileStat?.size ? bsDiffFileStat?.size : -1

        const courgetteFile = `${diffCachePath}/${fromFile[0].sha1sum}-${toFile.sha1sum}.courgette`
        let courgetteFileStat = await lstatAsync(courgetteFile).catch(() => null)
        if (courgetteFileStat === null) {
          await courgette(fromFile[0].fullPath, toFile.fullPath, courgetteFile)
          courgetteFileStat = await lstatAsync(courgetteFile).catch(() => null)
        }
        const courgetteDiffSize = courgetteFileStat?.size ? courgetteFileStat?.size : -1

        const courgetteZstdFile = `${diffCachePath}/${fromFile[0].sha1sum}-${toFile.sha1sum}.courgette.zstd`
        let courgetteZstdFileStat = await lstatAsync(courgetteZstdFile).catch(() => null)
        if (courgetteZstdFileStat === null) {
          await zstd(courgetteFile, courgetteZstdFile)
          courgetteZstdFileStat = await lstatAsync(courgetteZstdFile).catch(() => null)
        }
        const courgetteZstdDiffSize = courgetteZstdFileStat?.size ? courgetteZstdFileStat?.size : -1

        updatedFiles.push({
          from: fromFile[0],
          to: toFile,
          sizeDiff: toFile.size - fromFile[0].size,
          bsDiffSize: bsDiffSize,
          courgetteDiffSize: courgetteDiffSize,
          courgetteZstdDiffSize: courgetteZstdDiffSize
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
