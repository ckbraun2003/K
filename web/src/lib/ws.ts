import type { WsMessage } from '@k/shared'

type MessageHandler = (msg: WsMessage) => void
type StatusHandler = (connected: boolean) => void

let socket: WebSocket | null = null
const handlers = new Set<MessageHandler>()
const statusHandlers = new Set<StatusHandler>()

function emitStatus(connected: boolean) {
  for (const h of statusHandlers) {
    try { h(connected) } catch { /* status handlers must not break the socket */ }
  }
}
let pingInterval: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

export function connectWs() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  const url = `ws://${window.location.hostname}:3001/ws`
  socket = new WebSocket(url)

  socket.onopen = () => {
    console.log('[ws] connected')
    emitStatus(true)
    pingInterval = setInterval(() => socket?.send(JSON.stringify({ type: 'ping' })), 20_000)
  }

  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as WsMessage
      if (msg.type === 'pong') return
      for (const h of handlers) {
        try { h(msg) } catch { /* handler errors must not kill the socket */ }
      }
    } catch { /* ignore malformed */ }
  }

  socket.onclose = () => {
    console.log('[ws] disconnected — reconnecting in 3s')
    emitStatus(false)
    if (pingInterval) clearInterval(pingInterval)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connectWs, 3_000)
  }

  socket.onerror = () => socket?.close()
}

export function onWsMessage(handler: MessageHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function onWsStatus(handler: StatusHandler): () => void {
  statusHandlers.add(handler)
  return () => statusHandlers.delete(handler)
}
