const http = require('http')
const fs = require('fs/promises')
const path = require('path')
const {
  default: makeWASocket,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')

function normalizeEdgeBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '')
  if (!trimmed) {
    return ''
  }

  if (trimmed.endsWith('/inbound')) {
    return trimmed.slice(0, -'/inbound'.length)
  }

  return trimmed
}

const EDGE_BASE_URL = normalizeEdgeBaseUrl(process.env.EDGE_BASE_URL)
const WORKER_SECRET = process.env.WORKER_SECRET
const PORT = Number(process.env.PORT) || 3000
const DISCOVERY_POLL_MS = Number(process.env.DISCOVERY_POLL_MS) || 10_000
const QUEUE_POLL_MS = Number(process.env.QUEUE_POLL_MS) || 2_000
const AUTH_BASE = process.env.AUTH_BASE || '/data/auth'
const MEDIA_BASE = process.env.MEDIA_BASE || '/data/media'

const HTTP_TIMEOUT_MS = 10_000
const KEEP_ALIVE_MS = 60_000
const STOP_COOLDOWN_MS = 60_000
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000]
const FALLBACK_MAX_ACTIVE_INSTANCES = Math.max(
  0,
  Number(process.env.MAX_ACTIVE_INSTANCES) || 0,
)
const BAD_MAC_WINDOW_MS = Math.max(1_000, Number(process.env.BAD_MAC_WINDOW_MS) || 60_000)
const BAD_MAC_THRESHOLD = Math.max(1, Number(process.env.BAD_MAC_THRESHOLD) || 20)
const BAD_MAC_COOLDOWN_MS = Math.max(10_000, Number(process.env.BAD_MAC_COOLDOWN_MS) || 300_000)

const SIGNAL_SESSION_ERROR_SNIPPETS = [
  'bad mac',
  'failed to decrypt message',
  'no matching sessions found',
]

process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaughtException', error)
})

process.on('unhandledRejection', (error) => {
  console.error('[fatal] unhandledRejection', error)
})

function authHeaders() {
  return {
    Authorization: `Bearer ${WORKER_SECRET}`,
    'Content-Type': 'application/json',
  }
}

async function safeReadBody(response) {
  return response.text().catch(() => '')
}

async function requestJson(method, endpoint, body) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

  try {
    const response = await fetch(`${EDGE_BASE_URL}${endpoint}`, {
      method,
      headers: method === 'POST' ? authHeaders() : { Authorization: `Bearer ${WORKER_SECRET}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    if (!response.ok) {
      const details = await safeReadBody(response)
      throw new Error(`HTTP ${response.status}${details ? `: ${details.slice(0, 220)}` : ''}`)
    }

    if (response.status === 204) {
      return null
    }

    return response.json().catch(() => null)
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeReason(error) {
  if (!error) {
    return 'unknown'
  }

  if (error.name === 'AbortError') {
    return 'timeout'
  }

  return error.message || 'unknown'
}

function numberOrFallback(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseStatusCode(error) {
  return (
    error?.output?.statusCode ||
    error?.data?.statusCode ||
    error?.statusCode ||
    error?.status ||
    null
  )
}

function extractInboundContent(message) {
  const messageNode = message?.message || {}

  if (messageNode?.conversation || messageNode?.extendedTextMessage?.text) {
    return {
      mediaType: null,
      body: (messageNode?.conversation || messageNode?.extendedTextMessage?.text || '').trim(),
      content: null,
    }
  }

  if (messageNode?.imageMessage) {
    return {
      mediaType: 'image',
      body: messageNode.imageMessage.caption || '',
      content: messageNode.imageMessage,
    }
  }

  if (messageNode?.videoMessage) {
    return {
      mediaType: 'video',
      body: messageNode.videoMessage.caption || '',
      content: messageNode.videoMessage,
    }
  }

  if (messageNode?.audioMessage) {
    return {
      mediaType: 'audio',
      body: '',
      content: messageNode.audioMessage,
    }
  }

  if (messageNode?.documentMessage) {
    return {
      mediaType: 'document',
      body: messageNode.documentMessage.caption || '',
      content: messageNode.documentMessage,
    }
  }

  return { mediaType: null, body: '', content: null }
}

function resolvePushName(upsert, message) {
  return upsert?.pushName || message?.pushName || null
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '')
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120)
}

function numberFromUnknown(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function inferExtension({ mimeType, fileName, mediaType }) {
  const extByMime = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  }

  if (mimeType && extByMime[mimeType]) {
    return extByMime[mimeType]
  }

  const fileExt = path.extname(fileName || '').replace('.', '').trim().toLowerCase()
  if (fileExt) {
    return fileExt
  }

  return mediaType === 'image'
    ? 'jpg'
    : mediaType === 'video'
      ? 'mp4'
      : mediaType === 'audio'
        ? 'ogg'
        : 'bin'
}

async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function downloadInboundMedia(content, mediaType) {
  const stream = await downloadContentFromMessage(content, mediaType)
  return streamToBuffer(stream)
}

function normalizeOutboundTo(message) {
  const originalTo = String(message?.to || '').trim()

  if (!originalTo) {
    return { error: 'missing-to', originalTo, toNormalized: null }
  }

  if (originalTo.includes('@g.us') || originalTo.includes('@s.whatsapp.net')) {
    return { originalTo, toNormalized: originalTo }
  }

  if (originalTo.includes('@lid')) {
    return { error: 'lid', originalTo, toNormalized: null }
  }

  const digits = normalizeDigits(originalTo)
  if (digits && digits === originalTo) {
    return { originalTo, toNormalized: `${digits}@s.whatsapp.net` }
  }

  if (/^\d+-\d+$/.test(originalTo)) {
    return { originalTo, toNormalized: `${originalTo}@g.us` }
  }

  return { originalTo, toNormalized: originalTo }
}

function shouldWipeAuth(update) {
  const error = update?.lastDisconnect?.error
  const statusCode = parseStatusCode(error)
  const serialized = String(error?.message || error || '').toLowerCase()

  if (statusCode === DisconnectReason.loggedOut) {
    return true
  }

  if (serialized.includes('bad session')) {
    return true
  }

  return false
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function isSignalSessionError(errorLike) {
  const serialized = String(errorLike?.message || errorLike || '').toLowerCase()
  return SIGNAL_SESSION_ERROR_SNIPPETS.some((snippet) => serialized.includes(snippet))
}

class OutboundQueueRunner {
  constructor(runtime, edgeClient) {
    this.runtime = runtime
    this.edgeClient = edgeClient
    this.interval = null
    this.processing = false
  }

  start() {
    this.stop()
    this.tick().catch((error) => {
      console.error(`[queue:${this.runtime.instanceId}] tick failed: ${normalizeReason(error)}`)
    })
    this.interval = setInterval(() => {
      this.tick().catch((error) => {
        console.error(`[queue:${this.runtime.instanceId}] tick failed: ${normalizeReason(error)}`)
      })
    }, QUEUE_POLL_MS)
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  async tick() {
    if (this.processing || !this.runtime.isConnected() || !this.runtime.sock) {
      return
    }

    this.processing = true
    try {
      const payload = await this.edgeClient.get(
        `/queued-messages?instanceId=${encodeURIComponent(this.runtime.instanceId)}`,
      )
      const messages = Array.isArray(payload) ? payload : payload?.messages
      const count = Array.isArray(messages) ? messages.length : 0
      console.log(`[queue] polled count=${count} instance=${this.runtime.instanceId}`)

      if (count === 0) {
        return
      }

      for (const queued of messages) {
        if (!this.runtime.isConnected() || !this.runtime.sock) {
          break
        }

        if (!queued?.id || !queued?.to || (!queued?.body && !queued?.media_url)) {
          console.warn(`[queue:${this.runtime.instanceId}] malformed queued message ignored`)
          continue
        }

        const { originalTo, toNormalized, error: toError } = normalizeOutboundTo(queued)
        console.log(`[send] toOriginal=${originalTo} toNormalized=${toNormalized}`)

        if (toError) {
          const reason = `invalid-destination:${toError}`
          let markStatus = 'ok'
          try {
            await this.edgeClient.post('/mark-failed', {
              messageId: queued.id,
              error: reason,
            })
          } catch (error) {
            markStatus = normalizeReason(error)
            console.warn(`[queue:${this.runtime.instanceId}] mark-failed unavailable for ${queued.id}`)
          }
          console.log(`[mark-failed] ok status=${markStatus}`)
          console.error(
            `[queue:${this.runtime.instanceId}] send skipped for ${queued.id}: ${reason} toOriginal=${originalTo} toNormalized=${toNormalized}`,
          )
          continue
        }

        try {
          const result = await this.sendOutboundMessage(toNormalized, queued)
          console.log('[send-result]', JSON.stringify(result))
          await this.edgeClient.post('/mark-sent', {
            messageId: queued.id,
            wa_message_id: result?.key?.id || null,
            send_debug: {
              toOriginal: originalTo,
              toNormalized,
              result,
            },
          })
          console.log(
            `[send-success] messageId=${queued.id} toOriginal=${originalTo} toNormalized=${toNormalized} wa_message_id=${result?.key?.id || null}`,
          )
          console.log('[mark-sent] ok')
        } catch (error) {
          const reason = normalizeReason(error)
          let markStatus = 'ok'
          try {
            await this.edgeClient.post('/mark-failed', {
              messageId: queued.id,
              error: reason,
              send_debug: {
                toOriginal: originalTo,
                toNormalized,
                error: error?.message || String(error),
                stack: error?.stack || null,
              },
            })
          } catch (markError) {
            markStatus = normalizeReason(markError)
            console.warn(`[queue:${this.runtime.instanceId}] mark-failed unavailable for ${queued.id}`)
          }
          console.error(
            `[send-failed] messageId=${queued.id} toOriginal=${originalTo} toNormalized=${toNormalized} error=${reason}`,
          )
          console.log(`[mark-failed] ok status=${markStatus}`)
          console.error(
            `[queue:${this.runtime.instanceId}] send failed for ${queued.id}: ${reason} toOriginal=${originalTo} toNormalized=${toNormalized}`,
          )
        }
      }
    } finally {
      this.processing = false
    }
  }

  async fetchMediaBuffer(url) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`media-download-http-${response.status}`)
      }
      return Buffer.from(await response.arrayBuffer())
    } finally {
      clearTimeout(timeout)
    }
  }

  async sendOutboundMessage(toNormalized, queued) {
    if (!queued?.media_url) {
      return this.runtime.sock.sendMessage(toNormalized, { text: queued.body || '' })
    }

    const mediaType = queued.media_type || 'document'
    const mediaBuffer = await this.fetchMediaBuffer(queued.media_url)
    const caption = queued.body || ''

    if (mediaType === 'image') {
      return this.runtime.sock.sendMessage(toNormalized, { image: mediaBuffer, caption })
    }

    if (mediaType === 'video') {
      return this.runtime.sock.sendMessage(toNormalized, { video: mediaBuffer, caption })
    }

    if (mediaType === 'audio') {
      return this.runtime.sock.sendMessage(toNormalized, {
        audio: mediaBuffer,
        mimetype: queued.mime_type || 'audio/ogg',
        ptt: false,
      })
    }

    return this.runtime.sock.sendMessage(toNormalized, {
      document: mediaBuffer,
      mimetype: queued.mime_type || 'application/octet-stream',
      fileName: queued.file_name || `document-${queued.id}`,
      caption,
    })
  }
}

class ConnectionRunner {
  constructor(runtime, edgeClient) {
    this.runtime = runtime
    this.edgeClient = edgeClient
    this.sock = null
    this.connecting = false
    this.connected = false
    this.connectedAt = null
    this.intentionalStop = false
    this.reconnectAttempt = 0
    this.reconnectTimeout = null
    this.badMacTimestamps = []
    this.badMacBreakerUntil = 0
    this.badMacBreakerRunning = false
    this.outbound = new OutboundQueueRunner(runtime, edgeClient)
  }

  isConnected() {
    return this.connected
  }

  isBusy() {
    return this.connecting || this.connected
  }

  get authPath() {
    return path.join(AUTH_BASE, this.runtime.instanceId)
  }

  clearReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }

  async connect() {
    if (this.connecting || this.connected || this.sock) {
      return
    }

    this.intentionalStop = false
    this.connecting = true

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath)
      const { version } = await fetchLatestBaileysVersion()
      this.sock = makeWASocket({ auth: state, version })
      this.runtime.sock = this.sock
      this.bindEvents(saveCreds)
    } catch (error) {
      this.connecting = false
      this.sock = null
      this.runtime.sock = null
      throw error
    }
  }

  bindEvents(saveCreds) {
    this.sock.ev.on('creds.update', saveCreds)

    this.sock.ev.on('messages.upsert', async (upsert) => {
      const instanceId = this.runtime.instanceId
      console.log(`[upsert] instance=${instanceId} type=${upsert?.type} count=${upsert?.messages?.length || 0}`)
      if (!upsert?.messages?.length) return

      if (upsert.type && upsert.type !== 'notify' && upsert.type !== 'append') return

      for (const msg of upsert.messages) {
        if (!msg) continue

        const key = msg.key
        const chatId = key?.remoteJid
        if (!chatId) continue

        const isGroup = chatId.endsWith('@g.us')
        const senderId = isGroup ? key.participant || chatId : chatId

        const m = msg.message || {}
        const body =
          m.conversation ||
          m.extendedTextMessage?.text ||
          m.imageMessage?.caption ||
          m.videoMessage?.caption ||
          ''

        if (!body) continue

        const payload = {
          instanceId,
          from: senderId,
          to: this.sock?.user?.id || '',
          body,
          wa_message_id: key.id || null,
          from_me: !!key.fromMe,
          chat_id_norm: chatId,
          sender_id: senderId,
          push_name: upsert.pushName || msg.pushName || null,
        }

        try {
          const res = await fetch(`${EDGE_BASE_URL}/inbound`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${WORKER_SECRET}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          })
          const txt = await res.text()
          if (!res.ok) {
            console.error(`[inbound] FAIL instance=${instanceId} status=${res.status} body=${txt}`)
          } else {
            console.log(`[inbound] ok instance=${instanceId} chat=${chatId}`)
          }
        } catch (error) {
          this.registerSignalSessionError(error, 'inbound-delivery')
          console.error(`[inbound] ERROR instance=${instanceId}`, error)
        }
      }
    })

    console.log(`[sock] handlers bound instance=${this.runtime.instanceId}`)

    this.sock.ev.on('connection.update', async (update) => {
      if (update.qr) {
        try {
          const dataUrl = await QRCode.toDataURL(update.qr)
          await this.edgeClient.safeUpdateStatus(this.runtime.instanceId, 'CONNECTING', dataUrl)
        } catch (error) {
          console.error(`[conn:${this.runtime.instanceId}] QR processing failed: ${normalizeReason(error)}`)
        }
      }

      if (update.connection === 'open') {
        this.connecting = false
        this.connected = true
        this.connectedAt = Date.now()
        this.reconnectAttempt = 0
        this.badMacTimestamps = []
        this.clearReconnect()
        console.log(`[conn:${this.runtime.instanceId}] open`)
        await this.edgeClient.safeUpdateStatus(this.runtime.instanceId, 'CONNECTED', null)
        this.outbound.start()
        return
      }

      if (update.connection === 'close') {
        const error = update?.lastDisconnect?.error
        const statusCode = parseStatusCode(error)
        const reason = normalizeReason(error)
        const wipeAuth = shouldWipeAuth(update)
        const isRestartRequired = statusCode === 515
        this.registerSignalSessionError(error, 'connection-close')

        console.log(
          `[conn:${this.runtime.instanceId}] close reason=${reason} statusCode=${statusCode || 'n/a'} wipeAuth=${wipeAuth}`,
        )

        this.connecting = false
        this.connected = false
        this.connectedAt = null
        this.outbound.stop()
        this.sock = null
        this.runtime.sock = null

        await this.edgeClient.safeUpdateStatus(this.runtime.instanceId, 'DISCONNECTED', null)

        if (this.intentionalStop || !this.runtime.manager.isDesired(this.runtime.instanceId)) {
          this.clearReconnect()
          return
        }

        if (wipeAuth) {
          await this.wipeAuthAndRestart('invalid-session')
          return
        }

        const reconnectDelay = isRestartRequired ? randomBetween(2_000, 5_000) : null
        this.scheduleReconnect({
          delayMs: reconnectDelay,
          trigger: isRestartRequired ? 'statusCode-515-restart-required' : 'connection-close',
        })
      }
    })
  }

  registerSignalSessionError(errorLike, source) {
    if (!isSignalSessionError(errorLike)) {
      return
    }

    const now = Date.now()
    this.badMacTimestamps.push(now)
    this.badMacTimestamps = this.badMacTimestamps.filter((timestamp) => now - timestamp <= BAD_MAC_WINDOW_MS)

    const count = this.badMacTimestamps.length
    console.warn(
      `[conn:${this.runtime.instanceId}] signal-session-error source=${source} count=${count}/${BAD_MAC_THRESHOLD} windowMs=${BAD_MAC_WINDOW_MS}`,
    )

    if (count < BAD_MAC_THRESHOLD) {
      return
    }

    if (this.badMacBreakerRunning || now < this.badMacBreakerUntil) {
      return
    }

    this.badMacBreakerRunning = true
    this.badMacBreakerUntil = now + BAD_MAC_COOLDOWN_MS
    this.tripBadMacCircuitBreaker(count).finally(() => {
      this.badMacBreakerRunning = false
    })
  }

  async tripBadMacCircuitBreaker(sampleCount) {
    console.error(
      `[conn:${this.runtime.instanceId}] bad-mac circuit breaker tripped count=${sampleCount} threshold=${BAD_MAC_THRESHOLD} windowMs=${BAD_MAC_WINDOW_MS}`,
    )
    this.badMacTimestamps = []
    await this.edgeClient.safeUpdateStatus(this.runtime.instanceId, 'DISCONNECTED', null)
    await this.wipeAuthAndRestart('bad-mac-circuit-breaker')
  }

  async wipeAuthAndRestart(trigger) {
    console.warn(`[conn:${this.runtime.instanceId}] applying auth wipe trigger=${trigger}`)
    this.clearReconnect()
    this.outbound.stop()
    this.sock = null
    this.runtime.sock = null
    this.connecting = false
    this.connected = false

    try {
      await fs.rm(this.authPath, { recursive: true, force: true })
    } catch (error) {
      console.error(`[conn:${this.runtime.instanceId}] auth wipe failed: ${normalizeReason(error)}`)
    }

    this.runtime.manager.resetRuntime(this.runtime.instanceId)
    await this.runtime.manager.ensureRunning(this.runtime.instanceId)
  }

  scheduleReconnect({ delayMs = null, trigger = 'unknown' } = {}) {
    this.clearReconnect()
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    const delay = delayMs ?? RECONNECT_DELAYS_MS[index]
    this.reconnectAttempt += 1

    console.log(
      `[conn:${this.runtime.instanceId}] reconnect scheduled trigger=${trigger} delayMs=${delay} attempt=${this.reconnectAttempt}`,
    )

    this.reconnectTimeout = setTimeout(() => {
      this.runtime.manager.ensureRunning(this.runtime.instanceId).catch((error) => {
        console.error(`[conn:${this.runtime.instanceId}] reconnect failed: ${normalizeReason(error)}`)
      })
    }, delay)
  }

  async stopGracefully() {
    this.intentionalStop = true
    this.clearReconnect()
    this.outbound.stop()

    if (this.sock) {
      try {
        this.sock.end(new Error('Intentional instance stop'))
      } catch (error) {
        console.warn(`[conn:${this.runtime.instanceId}] graceful stop failed: ${normalizeReason(error)}`)
      }
    }

    this.sock = null
    this.runtime.sock = null
    this.connecting = false
    this.connected = false
    this.connectedAt = null
    this.reconnectAttempt = 0
    await this.edgeClient.safeUpdateStatus(this.runtime.instanceId, 'DISCONNECTED', null)
  }
}

class EdgeClient {
  async get(endpoint) {
    return requestJson('GET', endpoint)
  }

  async post(endpoint, payload) {
    return requestJson('POST', endpoint, payload)
  }

  async safeUpdateStatus(instanceId, status, qrCode) {
    try {
      await this.post('/update-status', {
        instanceId,
        status,
        qr_code: qrCode,
      })
    } catch (error) {
      console.error(`[status:${instanceId}] update failed (${status}): ${normalizeReason(error)}`)
    }
  }
}

class InstanceRuntime {
  constructor(instanceId, manager, edgeClient) {
    this.instanceId = instanceId
    this.manager = manager
    this.sock = null
    this.priority = 0
    this.connection = new ConnectionRunner(this, edgeClient)
  }

  isConnected() {
    return this.connection.isConnected()
  }

  isBusy() {
    return this.connection.isBusy()
  }

  get connectedAt() {
    return this.connection.connectedAt
  }
}

class InstanceManager {
  constructor() {
    this.edgeClient = new EdgeClient()
    this.runtimes = new Map()
    this.desiredIds = new Set()
    this.discoveryInterval = null
    this.discoveryRunning = false
  }

  isDesired(instanceId) {
    return this.desiredIds.has(instanceId)
  }

  getOrCreateRuntime(instanceId) {
    if (!this.runtimes.has(instanceId)) {
      this.runtimes.set(instanceId, new InstanceRuntime(instanceId, this, this.edgeClient))
    }
    return this.runtimes.get(instanceId)
  }

  resetRuntime(instanceId) {
    this.runtimes.delete(instanceId)
  }

  async ensureRunning(instanceId) {
    const runtime = this.getOrCreateRuntime(instanceId)
    if (runtime.isBusy() || runtime.sock) {
      return false
    }

    await runtime.connection.connect()
    return true
  }

  canStop(runtime) {
    if (!runtime.isConnected()) {
      return true
    }

    if (!runtime.connectedAt) {
      return true
    }

    return Date.now() - runtime.connectedAt >= STOP_COOLDOWN_MS
  }

  async stopGracefully(instanceId) {
    const runtime = this.runtimes.get(instanceId)
    if (!runtime) {
      return false
    }

    await runtime.connection.stopGracefully()
    this.runtimes.delete(instanceId)
    return true
  }

  stablePrioritize(instances) {
    return instances
      .map((instance, index) => ({ ...instance, index }))
      .sort((a, b) => {
        const priorityDiff = (Number(b.priority) || 0) - (Number(a.priority) || 0)
        if (priorityDiff !== 0) {
          return priorityDiff
        }
        return a.index - b.index
      })
  }

  getMaxActiveInstances(settings) {
    return Math.max(0, numberOrFallback(settings?.max_active_instances, FALLBACK_MAX_ACTIVE_INSTANCES))
  }

  async discoveryCycle() {
    if (this.discoveryRunning) {
      return
    }

    this.discoveryRunning = true
    const startedIds = []
    const stoppedIds = []

    try {
      const [settings, candidatesPayload] = await Promise.all([
        this.edgeClient.get('/worker-settings').catch((error) => {
          console.error(`[discovery] worker-settings unavailable: ${normalizeReason(error)}`)
          return null
        }),
        this.edgeClient.get('/eligible-instances?enabled=true&limit=50&order=priority.desc'),
      ])

      const instancesRaw = Array.isArray(candidatesPayload?.instances)
        ? candidatesPayload.instances.filter((item) => item?.id)
        : []

      const maxActiveInstances = this.getMaxActiveInstances(settings)
      const ordered = this.stablePrioritize(instancesRaw)
      let targetIds = ordered.slice(0, maxActiveInstances).map((item) => String(item.id))

      if (targetIds.length === 0 && maxActiveInstances > 0 && this.runtimes.size > 0) {
        const runtimeFallback = [...this.runtimes.values()]
          .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
          .slice(0, maxActiveInstances)
          .map((runtime) => runtime.instanceId)

        if (runtimeFallback.length > 0) {
          console.warn('[discovery] eligible-instances returned empty, preserving current runtimes as fallback targets')
          targetIds = runtimeFallback
        }
      }

      this.desiredIds = new Set(targetIds)

      console.log(`[discovery] targetIds=${JSON.stringify(targetIds)}`)

      for (const candidate of targetIds) {
        const runtime = this.getOrCreateRuntime(candidate)
        runtime.priority = numberOrFallback(
          ordered.find((item) => String(item.id) === candidate)?.priority,
          0,
        )

        try {
          const started = await this.ensureRunning(candidate)
          if (started) {
            startedIds.push(candidate)
          }
        } catch (error) {
          console.error(`[discovery] ensureRunning failed for ${candidate}: ${normalizeReason(error)}`)
        }
      }

      for (const runtime of this.runtimes.values()) {
        if (this.desiredIds.has(runtime.instanceId)) {
          continue
        }

        if (!this.canStop(runtime)) {
          continue
        }

        const stopped = await this.stopGracefully(runtime.instanceId)
        if (stopped) {
          stoppedIds.push(runtime.instanceId)
        }
      }

      console.log(
        `[discovery] startedIds=${JSON.stringify(startedIds)} stoppedIds=${JSON.stringify(stoppedIds)}`,
      )
    } catch (error) {
      console.error(`[discovery] failed: ${normalizeReason(error)}`)
    } finally {
      this.discoveryRunning = false
    }
  }

  async start() {
    await fs.mkdir(AUTH_BASE, { recursive: true })
    await this.discoveryCycle()
    this.discoveryInterval = setInterval(() => {
      this.discoveryCycle().catch((error) => {
        console.error(`[discovery] cycle crash: ${normalizeReason(error)}`)
      })
    }, DISCOVERY_POLL_MS)
  }
}

async function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[boot] HTTP server listening on ${PORT}`)
      resolve()
    })
  })
}

async function start() {
  await startHealthServer()

  if (!EDGE_BASE_URL) {
    console.error('[boot] Missing required env EDGE_BASE_URL')
  }

  if (!WORKER_SECRET) {
    console.error('[boot] Missing required env WORKER_SECRET')
  }

  setInterval(() => {
    console.log('[boot] worker alive')
  }, KEEP_ALIVE_MS)

  if (!EDGE_BASE_URL || !WORKER_SECRET) {
    await new Promise(() => {})
    return
  }

  const manager = new InstanceManager()
  await manager.start()
  await new Promise(() => {})
}

start().catch((error) => {
  console.error('[boot] fatal start error', error)
})
