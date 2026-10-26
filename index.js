/**
 * dsh-power-switch · Host 半边
 *
 * 只负责一件事：把「重启」「关闭」翻译成真正的进程生命周期操作。
 * 不是 router.refresh()、不是 window.location.reload()——是这个进程真的没了。
 *
 * 两条路径：
 * - 关闭：让宿主进程正常退出（有 launcher 的 appExit 钩子就用它，没有就 process.exit(0)）。
 * - 重启：以非零码退出，把重启交给 DSH Desktop 自己的恢复对话框。
 *   那个对话框的默认按钮就是「重启」，点下去是 Electron 官方的 app.relaunch()。
 *   为什么不自建 spawn：Desktop 主进程一旦发现 host 消失就会弹这个框，
 *   自己拉起的进程会和对话框抢方向盘，用户点 ✕（= 退出）反而把一切关掉。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'dsh-power-switch'
export const inject = ['webServer']

const ROUTE = '/dsh-power-switch/api'
/** 发完 HTTP 响应到真正退出之间的缓冲，让响应先落地。 */
const EXIT_DELAY_MS = 320
/** 重启用的非零退出码：主进程据此判定宿主意外停止，弹恢复框让用户走官方 relaunch。 */
const RESTART_EXIT_CODE = 1

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
 * 能不能重启：需要能认出宿主入口。
 *
 * Desktop 下我们不自己 spawn（见 restart 的注释），但仍用这个判断
 * 回答「这台机器上重启这条路通不通」，避免在无从判断的环境里瞎按。
 */
function launchSpec(facts) {
  if (facts.entry !== null && existsSync(facts.entry)) {
    return {
      file: facts.execPath,
      args: [...facts.execArgv, facts.entry, ...process.argv.slice(2)],
      via: facts.electron ? 'desktop-recovery-dialog' : 'node-entry',
      env: facts.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    }
  }
  return null
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

  /**
   * 退出这个进程。
   *
   * `mode: 'restart'` 故意走「非零退出」——Desktop 主进程会把它判定为宿主意外停止，
   * 弹出恢复对话框；那个对话框的默认按钮（defaultId=1）就是「重启」，
   * 点下去执行的是 Electron 官方的 app.relaunch() + quit，这才是真正可靠的重启。
   *
   * 我们自己 spawn 新进程那条路在 Desktop 下走不通：主进程看到 host 消失就弹框，
   * 而弹框一旦出现，用户点 ✕ 等于 cancelId=0（退出），新进程起没起来都白搭。
   */
  const shutdown = (mode) => {
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

      if (mode === 'restart') {
        // 非零退出码 = 让主进程认定「意外停止」→ 弹恢复框 → 用户点「重启」走官方 relaunch
        logger?.info?.('dsh-power-switch: restart handed to the desktop recovery dialog')
        if (typeof appExit === 'function') {
          try {
            appExit(RESTART_EXIT_CODE)
          } catch {
            /* fall through to a hard exit */
          }
        }
        setTimeout(() => exit(RESTART_EXIT_CODE), 800).unref?.()
        return
      }

      if (typeof appExit === 'function') {
        logger?.info?.('dsh-power-switch: shutdown via appExit')
        try {
          appExit(0)
        } catch (error) {
          logger?.warn?.(`dsh-power-switch: appExit threw (${error?.message ?? error}); falling back to exit`)
          exit(0)
          return
        }
        setTimeout(() => exit(0), 1_500).unref?.()
        return
      }
      logger?.info?.('dsh-power-switch: shutdown via process.exit')
      exit(0)
    }, EXIT_DELAY_MS)
  }

  /**
   * 重启：不自己拉起新进程，而是把重启交给 DSH Desktop 自己的恢复对话框。
   *
   * 原因（实测 + 读主进程源码得出）：Desktop 主进程监视 host 子进程，
   * 一旦 host 非正常消失就弹「应用无法启动或已意外停止」。
   * 那个对话框的按钮是 [退出, 重启, 禁用第三方插件]，defaultId=1 即「重启」，
   * 点下去执行 app.relaunch() + quit —— 官方、可靠、且会正确重建整个应用。
   *
   * 之前自己 spawn 的版本会与这个对话框打架：新进程可能起来了，
   * 但对话框还在，用户点 ✕（= cancelId 0 = 退出）就把一切关掉了。
   */
  const restart = () => {
    if (launchSpec(facts) === null) {
      return { ok: false, error: 'cannot infer how this process was started; refusing to guess a restart command', facts }
    }
    shutdown('restart')
    return { ok: true, action: 'restart', pid: process.pid, via: 'desktop-recovery-dialog' }
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
