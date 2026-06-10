import type { WsMessage } from '@k/shared'

type MessageHandler = (msg: WsMessage) => void

let socket: WebSocket | null = null
const handlers = new Set<MessageHandler>()
let pingInterval: ReturnType<typeof setInterval> | null = null

export function connectWs() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  const url = `ws://${window.location.hostname}:3001/ws`
  socket = new WebSocket(url)

  socket.onopen = () => {
    console.log('[ws] connected')
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
    if (pingInterval) clearInterval(pingInterval)
    setTimeout(connectWs, 3_000)
  }

  socket.onerror = () => socket?.close()
}

export function onWsMessage(handler: MessageHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}
