import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function runOpenClawJson(args) {
  const { stdout } = await execFileAsync('openclaw', args, {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  })

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('[plugins]'))

  return JSON.parse(lines.join('\n'))
}

export async function runGatewayCall(method, params = {}, timeout = 10000, auth = {}) {
  const args = [
    'gateway',
    'call',
    method,
    '--json',
    '--timeout',
    String(timeout),
    '--params',
    JSON.stringify(params),
  ]

  if (auth.token) args.push('--token', auth.token)
  if (auth.password) args.push('--password', auth.password)

  return runOpenClawJson(args)
}
