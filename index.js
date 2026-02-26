const http = require('http')
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')

const EDGE_BASE_URL = process.env.EDGE_BASE_URL
const WORKER_SECRET = process.env.WORKER_SECRET
const PORT = Number(process.env.PORT) || 3000

const HTTP_TIMEOUT_MS = 10_000
const DISCOVERY_INTERVAL_MS = 10_000
const POLL_INTERVAL_MS = 2_000
const RECONNECT_DELAY_MS = 2_000
const KEEP_ALIVE_MS = 60_000

const instanceStates = new Map()
let desiredInstanceIds = new Set()

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err)
})

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
      headers: { Authorization: `Bearer ${WORKER_SECRET}` },
      signal: controller.signal,
    })

    if (!response.ok) {
      const details = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${details ? `: ${details.slice(0, 180)}` : ''}`)
    }

    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function updateStatus(instanceId, status, qrCode = null) {
  try {
    await postJson('/update-status', {
      instanceId,
      status,
      qr_code: qrCode,
    })
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timeout' : error.message
    console.error(`[status] Failed to update status for ${instanceId}: ${reason}`)
  }
}

function createOrGetState(instanceId) {
  if (!instanceStates.has(instanceId)) {
    instanceStates.set(instanceId, {
      instanceId,
      sock: null,
      priority: 0,
      connected: false,
      connecting: false,
      intentionalStop: false,
      reconnectTimeout: null,
      pollingInterval: null,
    })
  }

  return instanceStates.get(instanceId)
}

function stopPolling(state) {
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval)
    state.pollingInterval = null
  }
}

async function processQueuedMessages(state) {
  if (!state.sock || !state.connected) {
    return
  }

  try {
    const payload = await getJson(
      `/queued-messages?instanceId=${encodeURIComponent(state.instanceId)}`,
    )

    const messages = Array.isArray(payload) ? payload : payload?.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      return
    }

    for (const message of messages) {
      if (!message?.id || !message?.to || !message?.body) {
        console.warn(`[poller] Ignoring malformed queued message for ${state.instanceId}`)
        continue
      }

      try {
        const sent = await state.sock.sendMessage(message.to, { text: message.body })
        await postJson('/mark-sent', {
          messageId: message.id,
          wa_message_id: sent?.key?.id ?? null,
        })
      } catch (error) {
        console.error(`[poller] Failed to send message ${message.id} (${state.instanceId}): ${error.message}`)
      }
    }
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timeout' : error.message
    console.error(`[poller] Queue polling failed for ${state.instanceId}: ${reason}`)
  }
}

function startPolling(state) {
  stopPolling(state)
  state.pollingInterval = setInterval(() => {
    processQueuedMessages(state).catch(() => {})
  }, POLL_INTERVAL_MS)
}

function clearReconnect(state) {
  if (state.reconnectTimeout) {
    clearTimeout(state.reconnectTimeout)
    state.reconnectTimeout = null
  }
}

function scheduleReconnect(state) {
  clearReconnect(state)

  state.reconnectTimeout = setTimeout(() => {
    connectInstance(state.instanceId).catch((error) => {
      console.error(`[wa] Reconnect failed for ${state.instanceId}: ${error.message}`)
      if (desiredInstanceIds.has(state.instanceId)) {
        scheduleReconnect(state)
      }
    })
  }, RECONNECT_DELAY_MS)
}

async function stopInstance(instanceId) {
  const state = instanceStates.get(instanceId)
  if (!state) {
    return
  }

  state.intentionalStop = true
  clearReconnect(state)
  stopPolling(state)

  if (state.sock) {
    try {
      state.sock.end(new Error('Stopped by scheduler'))
    } catch (error) {
      console.warn(`[wa] Failed to stop socket for ${instanceId}: ${error.message}`)
    }
  } else {
    instanceStates.delete(instanceId)
  }

  state.sock = null
  state.connected = false
  state.connecting = false

  await updateStatus(instanceId, 'DISCONNECTED', null)
}

async function connectInstance(instanceId) {
  const state = createOrGetState(instanceId)

  if (!desiredInstanceIds.has(instanceId)) {
    return
  }

  if (state.sock || state.connecting) {
    return
  }

  state.intentionalStop = false
  state.connecting = true
  clearReconnect(state)

  const authPath = `/data/auth/${instanceId}`
  const { state: authState, saveCreds } = await useMultiFileAuthState(authPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: authState,
    version,
  })

  state.sock = sock

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
        instanceId,
        from,
        to,
        body,
        wa_message_id: message?.key?.id || null,
      }).catch(() => {})
    }
  })

  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      try {
        const dataUrl = await QRCode.toDataURL(update.qr)
        await updateStatus(instanceId, 'CONNECTING', dataUrl)
      } catch (error) {
        console.error(`[wa] Failed to process QR for ${instanceId}: ${error.message}`)
      }
    }

    if (update.connection === 'open') {
      state.connecting = false
      state.connected = true
      await updateStatus(instanceId, 'CONNECTED', null)
      startPolling(state)
      return
    }

    if (update.connection === 'close') {
      state.connecting = false
      state.connected = false
      stopPolling(state)
      state.sock = null

      await updateStatus(instanceId, 'DISCONNECTED', null)

      if (state.intentionalStop || !desiredInstanceIds.has(instanceId)) {
        clearReconnect(state)
        instanceStates.delete(instanceId)
        return
      }

      scheduleReconnect(state)
    }
  })
}

async function runDiscoveryCycle() {
  try {
    const [settings, disconnectedPayload] = await Promise.all([
      getJson('/worker-settings'),
      getJson('/disconnected-instances?limit=50'),
    ])

    const maxActiveInstances = Math.max(0, Number(settings?.max_active_instances) || 0)
    const instances = Array.isArray(disconnectedPayload?.instances)
      ? disconnectedPayload.instances
      : []

    const prioritized = instances
      .filter((item) => item?.id)
      .sort((a, b) => (Number(b?.priority) || 0) - (Number(a?.priority) || 0))

    const top = prioritized.slice(0, maxActiveInstances)
    desiredInstanceIds = new Set(top.map((item) => String(item.id)))

    for (const item of top) {
      const instanceId = String(item.id)
      const state = createOrGetState(instanceId)
      state.priority = Number(item.priority) || 0

      if (!state.sock && !state.connecting) {
        connectInstance(instanceId).catch((error) => {
          state.connecting = false
          console.error(`[wa] Failed to start ${instanceId}: ${error.message}`)
          if (desiredInstanceIds.has(instanceId)) {
            scheduleReconnect(state)
          }
        })
      }
    }

    const runningIds = Array.from(instanceStates.keys())
    for (const instanceId of runningIds) {
      if (!desiredInstanceIds.has(instanceId)) {
        await stopInstance(instanceId)
      }
    }
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timeout' : error.message
    console.error(`[discovery] Failed: ${reason}`)
  }
}

async function start() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }

    res.writeHead(404)
    res.end()
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on ${PORT}`)
  })

  if (!EDGE_BASE_URL) {
    console.error('Missing required environment variable: EDGE_BASE_URL')
  }

  if (!WORKER_SECRET) {
    console.error('Missing required environment variable: WORKER_SECRET')
  }

  setInterval(() => {
    console.log('worker alive')
  }, KEEP_ALIVE_MS)

  if (EDGE_BASE_URL && WORKER_SECRET) {
    await runDiscoveryCycle()
    setInterval(() => {
      runDiscoveryCycle().catch(() => {})
    }, DISCOVERY_INTERVAL_MS)
  }

  await new Promise(() => {})
}

start().catch(console.error)
