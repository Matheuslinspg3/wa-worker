'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')

// ─── Config ───────────────────────────────────────────────────────────────────

const EDGE_BASE_URL = process.env.EDGE_BASE_URL
const WORKER_SECRET = process.env.WORKER_SECRET
const PORT = Number(process.env.PORT) || 3000
const AUTH_DIR = process.env.AUTH_DIR || '/data/auth'
// How often (ms) to poll for new/disconnected instances
const INSTANCE_POLL_MS = Number(process.env.INSTANCE_POLL_MS) || 10_000
// How often (ms) to poll for queued messages per connected instance
const MSG_POLL_MS = Number(process.env.MSG_POLL_MS) || 2_000
const HTTP_TIMEOUT_MS = 10_000
const RECONNECT_DELAY_MS = 5_000
const KEEP_ALIVE_MS = 60_000

// ─── Global error guards ──────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('[process] unhandledRejection:', err)
})

// ─── Per-instance state ───────────────────────────────────────────────────────

/** @type {Map<string, import('@whiskeysockets/baileys').WASocket>} */
const sockets = new Map()         // instanceId → active socket
const msgPollers = new Map()      // instanceId → intervalId (message polling)
const reconnectTimers = new Map() // instanceId → timeoutId (scheduled reconnect)
const connecting = new Set()      // instanceIds currently being initialised

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function authHeaders() {
  return {
    Authorization: `Bearer ${WORKER_SECRET}`,
    'Content-Type': 'application/json',
  }
}

async function postJson(urlPath, body) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(`${EDGE_BASE_URL}${urlPath}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`)
    }
    if (res.status === 204) return null
    return res.json().catch(() => null)
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message
    console.error(`[http] POST ${urlPath} failed: ${reason}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(urlPath) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(`${EDGE_BASE_URL}${urlPath}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${WORKER_SECRET}` },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`)
    }
    return res.json()
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message
    console.error(`[http] GET ${urlPath} failed: ${reason}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ─── Per-instance helpers ─────────────────────────────────────────────────────

async function updateStatus(instanceId, status, qrCode = null) {
  await postJson('/update-status', { instanceId, status, qr_code: qrCode })
}

function startMsgPolling(instanceId) {
  if (msgPollers.has(instanceId)) return
  const id = setInterval(() => pollMessages(instanceId).catch(() => {}), MSG_POLL_MS)
  msgPollers.set(instanceId, id)
}

function stopMsgPolling(instanceId) {
  const id = msgPollers.get(instanceId)
  if (id != null) {
    clearInterval(id)
    msgPollers.delete(instanceId)
  }
}

async function pollMessages(instanceId) {
  const sock = sockets.get(instanceId)
  if (!sock) return

  const msgs = await getJson(`/queued-messages?instanceId=${encodeURIComponent(instanceId)}`)
  if (!Array.isArray(msgs) || msgs.length === 0) return

  for (const msg of msgs) {
    if (!msg?.id || !msg?.to || !msg?.body) {
      console.warn(`[${instanceId}] Ignoring malformed queued message`)
      continue
    }
    try {
      const sent = await sock.sendMessage(msg.to, { text: msg.body })
      await postJson('/mark-sent', {
        messageId: msg.id,
        wa_message_id: sent?.key?.id ?? null,
      })
    } catch (err) {
      console.error(`[${instanceId}] Failed to send message ${msg.id}: ${err.message}`)
    }
  }
}

function scheduleReconnect(instanceId) {
  if (reconnectTimers.has(instanceId)) return
  const timer = setTimeout(() => {
    reconnectTimers.delete(instanceId)
    connectInstance(instanceId).catch((err) => {
      console.error(`[${instanceId}] Reconnect failed: ${err.message}`)
      scheduleReconnect(instanceId)
    })
  }, RECONNECT_DELAY_MS)
  reconnectTimers.set(instanceId, timer)
}

// ─── Connect one instance ─────────────────────────────────────────────────────

async function connectInstance(instanceId) {
  if (connecting.has(instanceId)) {
    console.log(`[${instanceId}] Already connecting — skipping`)
    return
  }
  if (sockets.has(instanceId)) {
    console.log(`[${instanceId}] Already has active socket — skipping`)
    return
  }

  connecting.add(instanceId)
  console.log(`[${instanceId}] Initialising connection`)

  try {
    const authDir = path.join(AUTH_DIR, instanceId)
    fs.mkdirSync(authDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({ auth: state, version })
    sockets.set(instanceId, sock)

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        const from = msg?.key?.remoteJid
        const to = msg?.key?.participant || sock?.user?.id || null
        const body =
          msg?.message?.conversation ||
          msg?.message?.extendedTextMessage?.text ||
          msg?.message?.imageMessage?.caption ||
          msg?.message?.videoMessage?.caption ||
          ''
        if (!from || !body) continue
        await postJson('/inbound', {
          instanceId,
          from,
          to,
          body,
          wa_message_id: msg?.key?.id || null,
        }).catch(() => {})
      }
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update

      if (update.qr) {
        try {
          const dataUrl = await QRCode.toDataURL(update.qr)
          await updateStatus(instanceId, 'CONNECTING', dataUrl)
          console.log(`[${instanceId}] QR updated`)
        } catch (err) {
          console.error(`[${instanceId}] QR handler error: ${err.message}`)
        }
      }

      if (connection === 'open') {
        console.log(`[${instanceId}] Connected`)
        await updateStatus(instanceId, 'CONNECTED', null).catch(() => {})
        startMsgPolling(instanceId)
      }

      if (connection === 'close') {
        stopMsgPolling(instanceId)
        sockets.delete(instanceId)
        await updateStatus(instanceId, 'DISCONNECTED', null).catch(() => {})

        const code = lastDisconnect?.error?.output?.statusCode
        console.log(`[${instanceId}] Connection closed (code: ${code ?? 'unknown'})`)

        if (code !== DisconnectReason.loggedOut) {
          scheduleReconnect(instanceId)
        } else {
          console.log(`[${instanceId}] Logged out — waiting for re-authentication`)
        }
      }
    })
  } catch (err) {
    sockets.delete(instanceId) // defensive cleanup if socket was partially set
    connecting.delete(instanceId)
    throw err
  }

  // connecting.delete happens in finally only on success path;
  // on error it was already deleted in the catch above.
  connecting.delete(instanceId)
}

// ─── Instance discovery loop ──────────────────────────────────────────────────

async function fetchAndConnectPendingInstances() {
  // GET /disconnected-instances must return: [{ id: string }, ...]
  // Recommended: instances WHERE status IN ('DISCONNECTED', 'CONNECTING')
  const instances = await getJson('/disconnected-instances')
  if (!Array.isArray(instances)) {
    console.warn('[poller] /disconnected-instances did not return an array')
    return
  }

  for (const row of instances) {
    const id = row?.id
    if (!id) continue
    // Skip if already active, connecting, or a reconnect is already scheduled
    if (sockets.has(id) || connecting.has(id) || reconnectTimers.has(id)) continue
    console.log(`[poller] Starting instance: ${id}`)
    connectInstance(id).catch((err) => {
      console.error(`[poller] Failed to start instance ${id}: ${err.message}`)
    })
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function start() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })

  // Health / liveness server — bind to 0.0.0.0 so Easypanel can reach it
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        instances: {
          connected: sockets.size,
          connecting: connecting.size,
          reconnecting: reconnectTimers.size,
        },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on ${PORT}`)
  })

  if (!EDGE_BASE_URL) console.error('[config] Missing required env: EDGE_BASE_URL')
  if (!WORKER_SECRET) console.error('[config] Missing required env: WORKER_SECRET')

  // Periodic heartbeat so the logs show the process is alive
  setInterval(() => {
    console.log(
      `[heartbeat] alive — connected: ${sockets.size} connecting: ${connecting.size} reconnecting: ${reconnectTimers.size}`,
    )
  }, KEEP_ALIVE_MS)

  if (EDGE_BASE_URL && WORKER_SECRET) {
    // First fetch immediately on boot
    await fetchAndConnectPendingInstances().catch((err) => {
      console.error(`[boot] Initial instance fetch failed: ${err.message}`)
    })

    // Then poll on an interval
    setInterval(() => {
      fetchAndConnectPendingInstances().catch((err) => {
        console.error(`[poller] Instance fetch failed: ${err.message}`)
      })
    }, INSTANCE_POLL_MS)
  }

  // Keep the process alive indefinitely — never call process.exit()
  await new Promise(() => {})
}

start().catch(console.error)
