// Copyright 2026 MATLAB Variable Viewer fork contributors.

const { spawnSync } = require('child_process')

const vscePath = require.resolve('@vscode/vsce/vsce')
const result = spawnSync(process.execPath, [vscePath, 'ls'], {
    cwd: process.cwd(),
    encoding: 'utf8'
})

if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
}

const files = result.stdout.split(/\r?\n/).map(file => file.trim()).filter(Boolean)
const required = [
    'package.json',
    'LICENSE',
    'out/extension.js',
    'out/workspacebrowser/variableEditor.js',
    'server/out/index.js'
]
const forbidden = [
    /(^|\/)\.env($|\.)/,
    /(^|\/)\.git\//,
    /^src\/.*\.ts$/,
    /^out\/test\//,
    /^server\/tests\//,
    /^(server\/)?coverage\//,
    /\.vsix$/,
    /^server\/src\//
]

const missing = required.filter(file => !files.includes(file))
const disallowed = files.filter(file => forbidden.some(pattern => pattern.test(file)))

if (missing.length > 0 || disallowed.length > 0) {
    if (missing.length > 0) process.stderr.write(`Missing required package files:\n${missing.join('\n')}\n`)
    if (disallowed.length > 0) process.stderr.write(`Disallowed package files:\n${disallowed.join('\n')}\n`)
    process.exit(1)
}

process.stdout.write(`Package manifest check passed (${files.length} files).\n`)
