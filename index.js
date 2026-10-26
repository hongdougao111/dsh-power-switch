/**
 * dsh-power-switch · Host 半边
 *
 * 把「重启」「关闭」翻译成真正的进程生命周期操作。
 * 不是 router.refresh()、不是 window.location.reload()——是这个进程真的没了。
 *
 * 两条路径：
 * - 关闭：宿主进程正常退出（有 launcher 的 appExit 就用它，没有就 process.exit(0)）。
 * - 重启：拉起一个 detached helper，它等旧进程把端口让出来，再按「本进程当初的启动方式」
 *   原样重放一份新进程，然后本进程退出。helper 不在本进程的进程树里，不会被连坐。
 *
 * 重建命令行完全靠现场自省（execPath / argv / execArgv / entry），不猜 profile、
 * 不读别人的配置文件、不写死路径。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dsh-power-switch'
export const inject = ['webServer']

const ROUTE = '/dsh-power-switch/api'
/** helper 等旧进程让出端口的耐心上限（毫秒）。 */
const PORT_WAIT_MS = 20_000
/** 发完 HTTP 响应到真正退出之间的缓冲，让响应先落地。 */
const EXIT_DELAY_MS = 320

function runtimeFacts() {
  const entry = typeof process.argv[1] === 'string' ? resolve(process.argv[1]) : null
  return {
    pid: process.pid,
    platform: process.platform,
    execPath: process.execPath,
    electron: Boolean(process.versions && process.versions.electron),
    argv: process.argv.slice(0, 8),
    execArgv: process.execArgv,
    entry,
    cwd: process.cwd(),
  }
}

/**
 * 推导「重新启动一次」的命令行。
 *
 * Desktop 下我们跑在 host 子进程里：execPath 是 DeepSeek Harness.exe，
 * 但直接执行它 = 又开一个 Electron 主进程，会撞单实例锁 / 端口占用。
 * 正确姿势是 ELECTRON_RUN_AS_NODE 把同一个 exe 当 node 用，只重放 host 子进程自己。
 */
function launchSpec(facts) {
  if (facts.entry !== null && existsSync(facts.entry)) {
    return {
      file: facts.execPath,
      args: [...facts.execArgv, facts.entry, ...process.argv.slice(2)],
      cwd: facts.cwd,
      env: facts.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      via: facts.electron ? 'electron-as-node' : 'node-entry',
    }
  }
  return null
}

/** helper 由谁执行：Electron 本体借 ELECTRON_RUN_AS_NODE 当 node 用。 */
function helperRunner(facts) {
  if (facts.electron) return { file: facts.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  if (facts.execPath && existsSync(facts.execPath)) return { file: facts.execPath, env: {} }
  return { file: process.platform === 'win32' ? 'node.exe' : 'node', env: {} }
}

function helperSource(spec, logs, port) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(spec.file)}`,
    `const args = ${JSON.stringify(spec.args)}`,
    `const cwd = ${JSON.stringify(spec.cwd)}`,
    `const extraEnv = ${JSON.stringify(spec.env ?? {})}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    `const waitMs = ${PORT_WAIT_MS}`,
    "const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-power-switch] ${line}\\n`) } catch {} }",
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
    '// 端口还在应答 = 旧进程没走干净，此时拉起新进程必然撞端口',
    'const alive = () => new Promise((done) => {',
    '  if (!port) { done(false); return }',
    '  const socket = net.connect({ host: "127.0.0.1", port })',
    '  const settle = (value) => { try { socket.destroy() } catch {} done(value) }',
    '  socket.on("connect", () => settle(true))',
    '  socket.on("error", () => settle(false))',
    '  setTimeout(() => settle(false), 400)',
    '})',
    'const main = async () => {',
    '  const deadline = Date.now() + waitMs',
    '  while (Date.now() < deadline && (await alive())) await sleep(200)',
    '  if (await alive()) note(`port ${port} still answering after ${waitMs}ms; starting anyway`)',
    '  await sleep(250)',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", out, err], env: { ...process.env, ...extraEnv }, windowsHide: false })',
    '    child.on("error", (error) => note(`replacement failed to start: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '    note(`replacement started (pid ${child.pid})`)',
    '  } catch (error) {',
    '    note(`replacement failed to start: ${error && error.message ? error.message : error}`)',
    '  }',
    '}',
    'main()',
  ].join('\n')
}

function sameOrigin(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const origin = req.headers.origin
  // 同页面 fetch 一定带 Origin；没有 Origin 的只放行本机直连（curl / 排障）。
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function apply(ctx) {
  const logger = ctx.logger
  const facts = runtimeFacts()
  let busy = false

  const readPort = () => {
    try {
      const match = /:(\d{2,5})$/.exec(ctx.webServer.getOrigin())
      return match === null ? null : Number(match[1])
    } catch {
      return null
    }
  }

  const reply = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  /** 结束本进程。appExit 是 launcher 的优雅退出钩子，优先用它。 */
  const exitHost = () => {
    busy = true
    setTimeout(() => {
      const hardExit = (code) => {
        try {
          process.exit(code)
        } catch {
          /* the runtime may already be tearing down */
        }
      }
      let appExit
      try {
        appExit = typeof ctx.get === 'function' ? ctx.get('appExit') : undefined
      } catch {
        appExit = undefined
      }
      if (typeof appExit === 'function') {
        logger?.info?.('dsh-power-switch: exiting via appExit')
        try {
          appExit(0)
        } catch (error) {
          logger?.warn?.(`dsh-power-switch: appExit threw (${error?.message ?? error}); falling back to exit`)
          hardExit(0)
          return
        }
        setTimeout(() => hardExit(0), 1_500).unref?.()
        return
      }
      logger?.info?.('dsh-power-switch: exiting via process.exit')
      hardExit(0)
    }, EXIT_DELAY_MS)
  }

  /** 重启：先备好 detached helper，再退出本进程，由 helper 在端口释放后拉起新的。 */
  const restart = () => {
    const spec = launchSpec(facts)
    if (spec === null) {
      return { ok: false, error: 'cannot infer how this process was started; refusing to guess a restart command', facts }
    }
    const runner = helperRunner(facts)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const logs = {
      out: join(tmpdir(), `dsh-power-switch-${stamp}.out.log`),
      err: join(tmpdir(), `dsh-power-switch-${stamp}.err.log`),
    }
    let helper
    try {
      helper = spawn(runner.file, ['-e', helperSource(spec, logs, readPort())], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...runner.env },
        windowsHide: true,
      })
      helper.once?.('error', (error) => {
        logger?.warn?.(`dsh-power-switch: restart helper failed (${error?.message ?? error})`)
      })
      helper.unref()
    } catch (error) {
      return { ok: false, error: `could not start the restart helper: ${error?.message ?? error}` }
    }
    exitHost()
    return { ok: true, action: 'restart', pid: process.pid, helperPid: helper.pid ?? null, via: spec.via, logs }
  }

  const handle = async (req, res) => {
    if (req.method === 'GET') {
      const action = new URL(req.url ?? ROUTE, 'http://127.0.0.1').searchParams.get('action')
      if (action === 'ping') {
        reply(res, 200, { ok: true, alive: true, pid: process.pid, port: readPort() })
        return
      }
      reply(res, 200, {
        ok: true,
        plugin: name,
        alive: true,
        busy,
        pid: process.pid,
        port: readPort(),
        facts,
        restartable: launchSpec(facts) !== null,
      })
      return
    }

    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, error: 'GET to inspect, POST to act' })
      return
    }
    if (!sameOrigin(req)) {
      reply(res, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }
    if (busy) {
      reply(res, 409, { ok: false, error: 'a power operation is already in flight' })
      return
    }

    const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1')
    const action = String(url.searchParams.get('action') ?? req.headers['x-power-action'] ?? '').toLowerCase()

    if (action === 'restart' || action === 'reboot') {
      const outcome = restart()
      reply(res, outcome.ok === true ? 202 : 409, outcome)
      return
    }
    if (action === 'shutdown' || action === 'close' || action === 'stop') {
      reply(res, 202, { ok: true, action: 'shutdown', pid: process.pid })
      exitHost()
      return
    }
    reply(res, 400, { ok: false, error: `unknown action: ${action || '(empty)'}` })
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (req, res) => {
        void handle(req, res).catch((error) => {
          try {
            reply(res, 500, { ok: false, error: String(error?.message ?? error) })
          } catch {
            /* response already gone */
          }
        })
      },
    }),
  )

  logger?.info?.('dsh-power-switch: mounted at %s (pid %d)', ROUTE, process.pid)
}
