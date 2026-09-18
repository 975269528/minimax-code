// Modified by MiniMax for MCode Sandbox Runtime.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, setup } from '../build-common.js'

const { SRC, OUT } = setup({
  importMetaUrl: import.meta.url,
  requirePlatform: 'linux',
  srcDirName: 'seccomp-src',
})

function toCArray(bytes: Buffer): string {
  const hex = Array.from(bytes, b => '0x' + b.toString(16).padStart(2, '0'))
  const lines: string[] = []
  for (let i = 0; i < hex.length; i += 8) {
    lines.push('    ' + hex.slice(i, i + 8).join(', ') + ',')
  }
  return lines.join('\n')
}

const cflags = ['-static', '-O2', '-Wall', '-Wextra']
const hostCc = process.env.HOST_CC ?? 'gcc'
const targetCc = process.env.CC ?? 'gcc'
const targetStrip = process.env.STRIP ?? 'strip'

const gen = join(OUT, 'seccomp-unix-block')
run([
  hostCc,
  ...cflags,
  '-o',
  gen,
  join(SRC, 'seccomp-unix-block.c'),
  '-lseccomp',
])

const bpf: Record<string, Buffer> = {}
for (const target of ['x86_64', 'aarch64']) {
  const tmp = join(OUT, target + '.bpf')
  run([gen, tmp, target])
  bpf[target] = readFileSync(tmp)
  rmSync(tmp)
}
rmSync(gen)

const header = join(OUT, 'unix-block-bpf.h')
writeFileSync(
  header,
  '#if defined(__x86_64__)\n' +
    'static const unsigned char unix_block_bpf[] = {\n' +
    toCArray(bpf.x86_64) +
    '\n};\n' +
    '#elif defined(__aarch64__)\n' +
    'static const unsigned char unix_block_bpf[] = {\n' +
    toCArray(bpf.aarch64) +
    '\n};\n' +
    '#else\n' +
    '#error "unsupported architecture for unix-block BPF filter"\n' +
    '#endif\n',
)

run([
  targetCc,
  ...cflags,
  '-I',
  OUT,
  '-o',
  join(OUT, 'apply-seccomp'),
  join(SRC, 'apply-seccomp.c'),
])
run([targetStrip, join(OUT, 'apply-seccomp')])
rmSync(header)

console.log('built ' + join(OUT, 'apply-seccomp'))
