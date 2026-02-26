const http = require('http')
const fs = require('fs/promises')
const {
  default: makeWASocket,
  DisconnectReason,
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
const STOP_COOLDOWN_MS = 60_000
const MAX_ACTIVE_INSTANCES_FALLBACK = Math.max(0, Number(process.env.MAX_ACTIVE_INSTANCES) || 0)

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
      connectedAt: null,
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
        const reason = error?.name === 'AbortError' ? 'timeout' : error?.message || 'unknown error'

        await postJson('/mark-failed', {
          messageId: message.id,
          error: reason,
        }).catch((markError) => {
          const markReason =
            markError?.name === 'AbortError' ? 'timeout' : markError?.message || 'unknown error'
          console.error(
            `[poller] Failed to mark message ${message.id} as FAILED (${state.instanceId}): ${markReason}`,
          )
        })

        console.error(`[poller] Failed to send message ${message.id} (${state.instanceId}): ${reason}`)
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

function normalizeChatId(chatId) {
  if (typeof chatId !== 'string') {
    return ''
  }

  if (
    chatId.endsWith('@g.us') ||
    chatId.endsWith('@s.whatsapp.net') ||
    chatId.endsWith('@lid')
  ) {
    return chatId
  }

  return chatId
}

function parseMessageTimestamp(message) {
  const rawTimestamp = message?.messageTimestamp

  if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
    return rawTimestamp
  }

  if (typeof rawTimestamp === 'string') {
    const parsed = Number(rawTimestamp)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  if (typeof rawTimestamp === 'object' && rawTimestamp) {
    if (typeof rawTimestamp.toNumber === 'function') {
      const parsed = rawTimestamp.toNumber()
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }

    if (typeof rawTimestamp.low === 'number') {
      return rawTimestamp.low
    }
  }

  return null
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

async function removeAuthFolder(instanceId) {
  const authPath = `/data/auth/${instanceId}`
  try {
    await fs.rm(authPath, { recursive: true, force: true })
  } catch (error) {
    console.error(`[wa] Failed to remove auth folder for ${instanceId}: ${error.message}`)
  }
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
  state.connectedAt = null

  await updateStatus(instanceId, 'DISCONNECTED', null)
}

function getMaxActiveInstances(settings) {
  const configured = Number(settings?.max_active_instances)
  if (Number.isFinite(configured) && configured >= 0) {
    return configured
  }

  return MAX_ACTIVE_INSTANCES_FALLBACK
}

function getStatePriority(state, priorityByInstanceId) {
  const mappedPriority = priorityByInstanceId.get(state.instanceId)
  if (mappedPriority !== undefined) {
    return mappedPriority
  }

  return Number(state.priority) || 0
}

function getStateConnectedAt(state) {
  if (typeof state.connectedAt === 'number') {
    return state.connectedAt
  }

  return 0
}

function canStopState(state, now) {
  if (!state.connected) {
    return true
  }

  const connectedAt = getStateConnectedAt(state)
  if (!connectedAt) {
    return true
  }

  return now - connectedAt >= STOP_COOLDOWN_MS
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
      const fromMe = Boolean(message?.key?.fromMe)
      const chatId = message?.key?.remoteJid || null
      const senderId = message?.key?.participant || message?.key?.remoteJid || null
      const body =
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        message?.message?.imageMessage?.caption ||
        message?.message?.videoMessage?.caption ||
        ''
      const chatIdNorm = normalizeChatId(chatId)
      const timestamp = parseMessageTimestamp(message)

      if (!chatId || !senderId || !body) {
        continue
      }

      await postJson('/inbound', {
        instanceId,
        from_me: fromMe,
        chat_id: chatId,
        chat_id_norm: chatIdNorm,
        sender_id: senderId,
        body,
        wa_message_id: message?.key?.id || null,
        timestamp,
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
      state.connectedAt = Date.now()
      await updateStatus(instanceId, 'CONNECTED', null)
      startPolling(state)
      return
    }

    if (update.connection === 'close') {
      const statusCode = update?.lastDisconnect?.error?.output?.statusCode
      const mustResetAuth =
        statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession

      state.connecting = false
      state.connected = false
      state.connectedAt = null
      stopPolling(state)
      state.sock = null

      await updateStatus(instanceId, 'DISCONNECTED', null)

      if (mustResetAuth) {
        clearReconnect(state)
        await removeAuthFolder(instanceId)
        instanceStates.delete(instanceId)

        if (desiredInstanceIds.has(instanceId)) {
          connectInstance(instanceId).catch((error) => {
            console.error(`[wa] Forced reconnect failed for ${instanceId}: ${error.message}`)
            if (desiredInstanceIds.has(instanceId)) {
              scheduleReconnect(createOrGetState(instanceId))
            }
          })
        }
        return
      }

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
      getJson('/worker-settings').catch((error) => {
        const reason = error.name === 'AbortError' ? 'timeout' : error.message
        console.error(`[discovery] Failed to fetch /worker-settings: ${reason}`)
        return null
      }),
      getJson('/disconnected-instances?limit=50'),
    ])

    const maxActiveInstances = getMaxActiveInstances(settings)
    const instances = Array.isArray(disconnectedPayload?.instances)
      ? disconnectedPayload.instances
      : []

    const prioritized = instances
      .filter((item) => item?.id)
      .sort((a, b) => (Number(b?.priority) || 0) - (Number(a?.priority) || 0))

    const top = prioritized.slice(0, maxActiveInstances)
    const targetIds = new Set(top.map((item) => String(item.id)))
    desiredInstanceIds = targetIds
    const priorityByInstanceId = new Map(
      prioritized.map((item) => [String(item.id), Number(item.priority) || 0]),
    )

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

    const now = Date.now()
    const runningStates = Array.from(instanceStates.values()).filter(
      (state) => state.sock || state.connected || state.connecting,
    )

    const runningNonTarget = runningStates.filter((state) => !targetIds.has(state.instanceId))
    const excessCount = Math.max(0, runningStates.length - maxActiveInstances)

    if (excessCount <= 0) {
      return
    }

    const stopCandidates = runningNonTarget
      .filter((state) => canStopState(state, now))
      .sort((a, b) => {
        const priorityDiff =
          getStatePriority(a, priorityByInstanceId) - getStatePriority(b, priorityByInstanceId)
        if (priorityDiff !== 0) {
          return priorityDiff
        }

        return getStateConnectedAt(a) - getStateConnectedAt(b)
      })

    const toStop = stopCandidates.slice(0, excessCount)
    for (const state of toStop) {
      await stopInstance(state.instanceId)
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
