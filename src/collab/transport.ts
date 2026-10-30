import type { ClientMessage, ServerMessage } from './protocol'

export interface TransportHandlers {
  open(): void
  message(message: ServerMessage): void
  close(): void
}

export interface TransportConnection {
  send(message: ClientMessage): void
  close(): void
}

/** How the binding reaches the server. The default is a WebSocket; tests pass an in-memory one. */
export interface Transport {
  connect(handlers: TransportHandlers): TransportConnection
}

/** JSON messages over a WebSocket. A relative URL resolves against the page. */
export function websocket(url: string): Transport {
  return {
    connect(handlers) {
      const resolved = new URL(url, globalThis.location?.href)
      if (resolved.protocol === 'http:') resolved.protocol = 'ws:'
      if (resolved.protocol === 'https:') resolved.protocol = 'wss:'
      const ws = new WebSocket(resolved)
      let closed = false
      ws.onopen = () => handlers.open()
      ws.onmessage = (e) => handlers.message(JSON.parse(String(e.data)))
      ws.onclose = () => {
        if (!closed) handlers.close()
        closed = true
      }
      return {
        send: (message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
        },
        close: () => {
          closed = true
          ws.close()
        },
      }
    },
  }
}

/** Delays every message both ways by `delay()` ms, keeping their order. For the demo and tests. */
export function withLatency(inner: Transport, delay: () => number): Transport {
  return {
    connect(handlers) {
      let closed = false
      const last = { up: 0, down: 0 }
      const later = (way: 'up' | 'down', fn: () => void) => {
        const now = Date.now()
        const at = Math.max(now + delay(), last[way])
        last[way] = at
        setTimeout(() => {
          if (!closed) fn()
        }, at - now)
      }
      const connection = inner.connect({
        open: () => later('down', () => handlers.open()),
        message: (message) => later('down', () => handlers.message(message)),
        close: () => later('down', () => handlers.close()),
      })
      return {
        send: (message) => later('up', () => connection.send(message)),
        close: () => {
          closed = true
          connection.close()
        },
      }
    },
  }
}
