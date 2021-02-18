import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'

const mkdirAsync = util.promisify(fs.mkdir)
const lstatAsync = util.promisify(fs.lstat)

import { bsdiff, File, listFolder } from '../src/rootfs-diff'

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
  const updatedFiles: Array<{ from: File; to: File; diff: number; patch: number }> = []
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
        updatedFiles.push({ from: fromFile[0], to: toFile, diff: toFile.size - fromFile[0].size, patch: -1 })
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
    console.log(`  ${groupRegex}: ${found.map(f => f.size).reduce((a, c) => a + c)}`)
    for (const file of found) {
      console.log(`    ${file.path}: ${file.size}`)
      groupSeen[file.path] = true
    }
  }

  const singleNewFiles = newFiles.filter(f => !groupSeen[f.path])
  console.log(`Single new files:`)
  for (const file of singleNewFiles.sort((a, b) => b.size - a.size)) {
    console.log(`  ${file.path}: ${file.size}`)
  }

  console.log(`Updated files`)
  for (const updatedFile of updatedFiles.sort((a, b) => b.diff - a.diff)) {
    const diffFile = `${diffCachePath}/${updatedFile.from.sha1sum}-${updatedFile.to.sha1sum}.diff`
    let fileStat = await lstatAsync(diffFile).catch(() => null)
    if (fileStat === null) {
      await bsdiff(updatedFile.from.fullPath, updatedFile.to.fullPath, diffFile)
      fileStat = await lstatAsync(diffFile).catch(() => null)
    }
    updatedFile.patch = fileStat?.size ? fileStat?.size : -1
    console.log(
      `  ${updatedFile.to.path}${updatedFile.from.path !== updatedFile.to.path ? `(${updatedFile.from.path})` : ''}: ${
        updatedFile.from.size
      } -> ${updatedFile.to.size} (diff:${updatedFile.diff}, patch:${updatedFile.patch})`
    )
  }

  console.log(`Totals:`)
  const totalSameFilesSize = sameFiles.map(f => f.to.size).reduce((a, c) => a + c)
  console.log(` unchanged files size   : ${totalSameFilesSize}`)

  const totalNewFilesSize = newFiles.map(f => f.size).reduce((a, c) => a + c)
  console.log(` new files size         : ${totalNewFilesSize}`)

  const totalGroupSize = newFiles
    .filter(f => groupSeen[f.path])
    .map(f => f.size)
    .reduce((a, c) => a + c)
  console.log(`   grouped : ${totalGroupSize}`)
  const singleNewFilesSize = singleNewFiles.map(f => f.size).reduce((a, c) => a + c)
  console.log(`   single  : ${singleNewFilesSize}`)

  const totalUpdatedFromSize = updatedFiles.map(f => f.from.size).reduce((a, c) => a + c)
  const totalUpdatedToSize = updatedFiles.map(f => f.to.size).reduce((a, c) => a + c)
  console.log(
    ` updated files size     : ${totalUpdatedFromSize} -> ${totalUpdatedToSize} (${
      totalUpdatedToSize - totalUpdatedFromSize
    })`
  )

  return 0
}

main(process.argv.slice(2)).catch(e => {
  console.error(e)
  process.exit(255)
})
