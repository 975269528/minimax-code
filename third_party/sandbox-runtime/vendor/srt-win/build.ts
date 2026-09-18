// Modified by MiniMax for MCode Sandbox Runtime.

import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { run, setup } from '../build-common.js'

const crossTarget = process.env.SRT_WINDOWS_TARGET
const { SRC, OUT } = setup({
  importMetaUrl: import.meta.url,
  requirePlatform: 'win32',
  srcDirName: 'srt-win-src',
  allowCrossPlatform: crossTarget !== undefined,
})

const cargoArgs = [
  'cargo',
  ...(crossTarget ? ['xwin'] : []),
  'build',
  '--release',
  '--manifest-path',
  join(SRC, 'Cargo.toml'),
  ...(crossTarget ? ['--target', crossTarget] : []),
]
run(cargoArgs)

const built = join(
  SRC,
  'target',
  ...(crossTarget ? [crossTarget] : []),
  'release',
  'srt-win.exe',
)
if (!existsSync(built)) {
  console.error('srt-win build: expected output not found at ' + built)
  process.exit(1)
}

const dest = join(OUT, 'srt-win.exe')
copyFileSync(built, dest)
console.log('built ' + dest)
