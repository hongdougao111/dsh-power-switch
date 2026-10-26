window.__ModuleLoader__.load({
  id: 'dsh-power-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/dsh-power-switch/api'
    const BUTTON_SLOT = 'conversation.session.header.utilities'
    const PANEL_SLOT = 'shell.overlay'

    /* ── 按钮和菜单住在两个 slot 里，靠这一点点共享状态串起来 ─────────── */
    let panelOpen = false
    const listeners = new Set()
    const setPanelOpen = (next) => {
      if (panelOpen === next) return
      panelOpen = next
      for (const listener of [...listeners]) {
        try {
          listener(panelOpen)
        } catch {
          /* 一个订阅者崩了不该冻住开关 */
        }
      }
    }
    const usePanelOpen = () => {
      const [open, setOpen] = useState(panelOpen)
      useEffect(() => {
        listeners.add(setOpen)
        setOpen(panelOpen)
        return () => listeners.delete(setOpen)
      }, [])
      return open
    }

    const CSS = `
.dpsw-trigger {
  display: inline-flex; align-items: center; justify-content: center; pointer-events: auto;
  width: 28px; height: 28px; padding: 0; border-radius: 8px;
  border: 1px solid transparent; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.dpsw-trigger:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dpsw-trigger[data-open="true"] { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.dpsw-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* shell.overlay 本身点击穿透：面板自己把点击要回来 */
.dpsw-scrim { position: fixed; inset: 0; z-index: 40; background: transparent; pointer-events: auto; }
.dpsw-menu {
  position: fixed; z-index: 41; top: 44px; right: 12px; pointer-events: auto;
  display: flex; flex-direction: column; gap: 6px; width: 168px; padding: 8px;
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0,0,0,.16);
  animation: dpsw-drop 120ms ease-out;
}
@keyframes dpsw-drop { from { transform: translateY(-4px); opacity: .7 } to { transform: none; opacity: 1 } }
.dpsw-btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 30px; padding: 0 10px; border-radius: 8px; cursor: pointer;
  font: inherit; font-size: 12px; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); transition: filter 120ms ease, transform 60ms ease;
}
.dpsw-btn:hover { filter: brightness(1.06); }
.dpsw-btn:active { transform: translateY(1px); }
.dpsw-btn:disabled { opacity: .55; cursor: progress; }
.dpsw-btn.restart { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dpsw-btn.shutdown { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dpsw-btn.armed { background: var(--dsw-alias-state-error-primary); color: #fff; border-color: transparent; }
.dpsw-err { font-size: 11px; line-height: 1.4; color: var(--dsw-alias-state-error-primary); text-align: center; }
`

    const Icon = ({ open }) =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: open ? 2.1 : 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M12 3v9' }),
        h('path', { d: 'M7.1 6.1a7 7 0 1 0 9.8 0' }),
      )

    function PowerTrigger() {
      const open = usePanelOpen()
      return h(
        'button',
        {
          type: 'button',
          className: 'dpsw-trigger',
          'data-open': open ? 'true' : 'false',
          title: '电源',
          'aria-label': '电源',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setPanelOpen(!open),
        },
        h(Icon, { open }),
      )
    }

    /* 只有两个按钮，没有别的说明 */
    function PowerMenu() {
      const open = usePanelOpen()
      const [armed, setArmed] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!open) {
          setArmed(null)
          setError(null)
          return undefined
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setPanelOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const act = useCallback(async (action) => {
        setBusy(true)
        setError(null)
        try {
          const res = await fetch(`${API}?action=${action}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok !== true) {
            setError('失败')
            setBusy(false)
            return
          }
          if (action === 'shutdown') return
          // 重启中：本页会被断掉，服务一回来就刷新
          for (let i = 0; i < 30; i += 1) {
            await new Promise((r) => setTimeout(r, 900))
            try {
              const probe = await fetch(`${API}?action=ping`, { credentials: 'same-origin', cache: 'no-store' })
              if (probe.ok) {
                window.location.reload()
                return
              }
            } catch {
              /* 还没回来，继续等 */
            }
          }
          setError('超时')
          setBusy(false)
        } catch {
          setError('失败')
          setBusy(false)
        }
      }, [])

      if (!open) return null

      const confirm = (action) => {
        if (armed === action) {
          setArmed(null)
          void act(action)
          return
        }
        setArmed(action)
        setError(null)
      }

      return h(
        React.Fragment,
        null,
        h('div', { className: 'dpsw-scrim', onClick: () => setPanelOpen(false), 'aria-hidden': true }),
        h(
          'div',
          { className: 'dpsw-menu', role: 'menu' },
          h('style', null, CSS),
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: `dpsw-btn restart${armed === 'restart' ? ' armed' : ''}`,
              disabled: busy,
              onClick: () => confirm('restart'),
            },
            armed === 'restart' ? '确认重启' : '⚡ 重启',
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: `dpsw-btn shutdown${armed === 'shutdown' ? ' armed' : ''}`,
              disabled: busy,
              onClick: () => confirm('shutdown'),
            },
            armed === 'shutdown' ? '确认关闭' : '⏻ 关闭',
          ),
          error !== null ? h('div', { className: 'dpsw-err' }, error) : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(BUTTON_SLOT, () =>
          ctx.slots.register({ name: BUTTON_SLOT, id: 'dsh-power-switch', order: 90 }, PowerTrigger),
        )
        ctx.slots.inject(PANEL_SLOT, () =>
          ctx.slots.register({ name: PANEL_SLOT, id: 'dsh-power-switch.panel', order: 90 }, PowerMenu),
        )
      },
    }
  },
})
