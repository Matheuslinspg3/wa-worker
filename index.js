const http = require('http')
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')

const INSTANCE_ID = process.env.INSTANCE_ID || 'default'
const EDGE_BASE_URL = process.env.EDGE_BASE_URL
const WORKER_SECRET = process.env.WORKER_SECRET
const SESSION_DIR = `/data/${INSTANCE_ID}`
const POLL_INTERVAL_MS = 2000
const HTTP_TIMEOUT_MS = 10_000
const RECONNECT_DELAY_MS = 2000
const WORKER_HEARTBEAT_MS = 30000
const port = Number(process.env.PORT) || 3000

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }

    res.writeHead(404)
    res.end()
  })
  .listen(port, '0.0.0.0', () => {
    console.log(`HTTP server listening on ${port}`)
  })

if (!EDGE_BASE_URL) {
  throw new Error('Missing required environment variable: EDGE_BASE_URL')
}

if (!WORKER_SECRET) {
  throw new Error('Missing required environment variable: WORKER_SECRET')
}

let sock
let pollingInterval
let reconnectTimeout

setInterval(() => console.log('worker alive'), WORKER_HEARTBEAT_MS)

function authHeaders() {
  return {
    Authorization: `Bearer ${WORKER_SECRET}`,
    'Content-Type': 'application/json',
  }
}

async function postJson(path, body) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

  try {
    const response = await fetch(`${EDGE_BASE_URL}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const details = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${details ? `: ${details.slice(0, 180)}` : ''}`)
    }

    if (response.status === 204) {
      return null
    }

    return response.json().catch(() => null)
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timeout' : error.message
    console.error(`[http] POST ${path} failed: ${reason}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function getJson(path) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

  try {
    const response = await fetch(`${EDGE_BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      const details = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${details ? `: ${details.slice(0, 180)}` : ''}`)
    }

    return response.json()
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timeout' : error.message
    console.error(`[http] GET ${path} failed: ${reason}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function updateStatus(status, qrCode = null) {
  await postJson('/update-status', {
    instanceId: INSTANCE_ID,
    status,
    qr_code: qrCode,
  })
}

async function processQueuedMessages() {
  if (!sock) {
    return
  }

  try {
    const queuedMessages = await getJson(
      `/queued-messages?instanceId=${encodeURIComponent(INSTANCE_ID)}`,
    )

    if (!Array.isArray(queuedMessages) || queuedMessages.length === 0) {
      return
    }

    for (const message of queuedMessages) {
      if (!message?.id || !message?.to || !message?.body) {
        console.warn('[poller] Ignoring malformed queued message payload')
        continue
      }

      try {
        const sent = await sock.sendMessage(message.to, { text: message.body })
        await postJson('/mark-sent', {
          messageId: message.id,
          wa_message_id: sent?.key?.id ?? null,
        })
      } catch (sendError) {
        console.error(`[poller] Failed to send message ${message.id}: ${sendError.message}`)
      }
    }
  } catch (error) {
    console.error('[poller] Queue polling failed')
  }
}

function startPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval)
  }

  pollingInterval = setInterval(() => {
    processQueuedMessages().catch(() => {})
  }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = undefined
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
  }

  reconnectTimeout = setTimeout(() => {
    connectToWhatsApp().catch((error) => {
      console.error(`Reconnect failed: ${error.message}`)
      scheduleReconnect()
    })
  }, RECONNECT_DELAY_MS)
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    auth: state,
    version,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') {
      return
    }

    for (const message of messages) {
      const from = message?.key?.remoteJid
      const to = message?.key?.participant || sock?.user?.id || null
      const body =
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        message?.message?.imageMessage?.caption ||
        message?.message?.videoMessage?.caption ||
        ''

      if (!from || !body) {
        continue
      }

      await postJson('/inbound', {
        instanceId: INSTANCE_ID,
        from,
        to,
        body,
        wa_message_id: message?.key?.id || null,
      }).catch(() => {})
    }
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (update.qr) {
      try {
        console.log(`QR received (len): ${update.qr.length}`)
        const dataUrl = await QRCode.toDataURL(update.qr)
        console.log(`QR dataUrl generated (len): ${dataUrl.length}`)

        await postJson('/update-status', {
          instanceId: process.env.INSTANCE_ID,
          status: 'CONNECTING',
          qr_code: dataUrl,
        })
        console.log('QR saved')
      } catch (error) {
        console.error(`QR handler error: ${error.message}`)
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp connected')
      await updateStatus('CONNECTED', null).catch(() => {})
      startPolling()
    }

    if (connection === 'close') {
      stopPolling()
      await updateStatus('DISCONNECTED', null).catch(() => {})

      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log(`Connection closed (code: ${statusCode ?? 'unknown'})`)

      if (shouldReconnect) {
        scheduleReconnect()
      } else {
        console.log('Session logged out; waiting for manual re-authentication')
        scheduleReconnect()
      }
    }
  })
}

connectToWhatsApp().catch((error) => {
  console.error(`Failed to initialize worker: ${error.message}`)
  scheduleReconnect()
})
