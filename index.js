/**
 * dsh-power-switch · Host 半边
 *
 * 只负责一件事：把「重启」「关闭」翻译成真正的进程生命周期操作。
 * 不是 router.refresh()、不是 window.location.reload()——是这个进程真的没了。
 *
 * 两条路径，都验过：
 * - 关闭：让宿主进程退出（有 launcher 的 appExit 钩子就用它，没有就 process.exit）。
 * - 重启：先拉起一个 detached helper，等本进程把端口让出来，再按「自己当初是怎么被启动的」
 *   原样重新拉起一份，最后本进程退出。helper 不在本进程的进程树里，因此不会陪葬。
 *   重建命令行完全靠现场的自省（execPath / argv / execArgv），不猜 profile、不读别人的配置。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dsh-power-switch'
export const inject = ['webServer']

const ROUTE = '/dsh-power-switch/api'
/** helper 等旧进程让出端口的耐心上限（毫秒）。 */
const PORT_WAIT_MS = 15_000
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
 * Electron 宿主里 process.execPath 是应用本体，argv[1] 是它自己的入口脚本，
 * 所以直接原样重放：execPath + argv.slice(1)。普通 node 宿主则拼回
 * node + execArgv + 入口 + 参数。
 */
function launchSpec(facts) {
  if (facts.electron) {
    return { file: facts.execPath, args: process.argv.slice(1), via: 'electron-exec' }
  }
  if (facts.entry !== null && existsSync(facts.entry)) {
    return {
      file: facts.execPath,
      args: [...facts.execArgv, facts.entry, ...process.argv.slice(2)],
      via: 'node-entry',
    }
  }
  return null
}

/** 谁来跑 helper：Electron 本体借 ELECTRON_RUN_AS_NODE 当 node 用。 */
function helperRunner(facts) {
  if (facts.electron) return { file: facts.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  if (facts.execPath && existsSync(facts.execPath)) return { file: facts.execPath, env: {} }
  return { file: process.platform === 'win32' ? 'node.exe' : 'node', env: {} }
}

function helperSource(spec, logs) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const file = ${JSON.stringify(spec.file)}`,
    `const args = ${JSON.stringify(spec.args)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const waitMs = ${PORT_WAIT_MS}`,
    "const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-power-switch] ${line}\\n`) } catch {} }",
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
    'const main = async () => {',
    '  await sleep(waitMs)',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    const child = spawn(file, args, { detached: true, stdio: ["ignore", out, err], env: process.env, windowsHide: false })',
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

  /** 真正退出这个进程。appExit 是 launcher 给的优雅退出钩子，优先用它。 */
  const shutdown = (reason) => {
    busy = true
    setTimeout(() => {
      const exit = (code) => {
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
        logger?.info?.(`dsh-power-switch: ${reason} via appExit`)
        try {
          appExit(0)
        } catch (error) {
          logger?.warn?.(`dsh-power-switch: appExit threw (${error?.message ?? error}); falling back to exit`)
          exit(0)
          return
        }
        // 钩子是异步的；给一点时间，再硬退一次兜底。
        setTimeout(() => exit(0), 1_500).unref?.()
        return
      }
      logger?.info?.(`dsh-power-switch: ${reason} via process.exit`)
      exit(0)
    }, EXIT_DELAY_MS)
  }

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
      helper = spawn(runner.file, ['-e', helperSource(spec, logs)], {
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
    shutdown('restart')
    return { ok: true, action: 'restart', pid: process.pid, helperPid: helper.pid ?? null, via: spec.via, next: spec.file, logs }
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
      shutdown('shutdown')
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
