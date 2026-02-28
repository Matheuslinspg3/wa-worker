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
const DECRYPT_RETRY_MAX_ATTEMPTS = 3
const SESSION_REFRESH_BACKOFF_MS = [1_000, 2_000, 5_000]
const LOCK_TTL_MS = Math.max(5_000, Number(process.env.INSTANCE_LOCK_TTL_MS) || 30_000)
const LOCK_RENEW_INTERVAL_MS = Math.max(
  2_000,
  Math.min(LOCK_TTL_MS - 1_000, Number(process.env.INSTANCE_LOCK_RENEW_MS) || Math.floor(LOCK_TTL_MS / 2)),
)
const FALLBACK_MAX_ACTIVE_INSTANCES = Math.max(
  0,
  Number(process.env.MAX_ACTIVE_INSTANCES) || 0,
)
const BAD_MAC_WINDOW_MS = Math.max(1_000, Number(process.env.BAD_MAC_WINDOW_MS) || 60_000)
const BAD_MAC_THRESHOLD = Math.max(1, Number(process.env.BAD_MAC_THRESHOLD) || 20)
const BAD_MAC_COOLDOWN_MS = Math.max(10_000, Number(process.env.BAD_MAC_COOLDOWN_MS) || 300_000)
const CONTACT_RESOLVE_ERROR_COOLDOWN_MS = Math.max(
  10_000,
  Number(process.env.CONTACT_RESOLVE_ERROR_COOLDOWN_MS) || 60_000,
)
const CONTACT_RESOLVE_DUPLICATE_COOLDOWN_MS = Math.max(
  30_000,
  Number(process.env.CONTACT_RESOLVE_DUPLICATE_COOLDOWN_MS) || 300_000,
)

const SIGNAL_SESSION_ERROR_SNIPPETS = [
  'bad mac',
  'failed to decrypt message',
  'no matching sessions found',
]

const PROCESS_OWNER_ID = `${process.env.INSTANCE_OWNER_PREFIX || process.env.HOSTNAME || 'worker'}:${process.pid}`

let instanceManager = null
let shutdownPromise = null

async function gracefulShutdown(signal, { fatalError = null } = {}) {
  if (shutdownPromise) {
    return shutdownPromise
  }

  shutdownPromise = (async () => {
    console.log(`[shutdown] signal=${signal} owner=${PROCESS_OWNER_ID}`)

    if (instanceManager) {
      await instanceManager.shutdown({ signal, fatalError })
    }

    if (fatalError) {
      console.error('[shutdown] fatal error', fatalError)
      process.exit(1)
    }
  })().finally(() => {
    shutdownPromise = null
  })

  return shutdownPromise
}

process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaughtException', error)
  gracefulShutdown('uncaughtException', { fatalError: error }).catch((shutdownError) => {
    console.error('[shutdown] uncaughtException cleanup failed', shutdownError)
    process.exit(1)
  })
})

process.on('unhandledRejection', (error) => {
  console.error('[fatal] unhandledRejection', error)
  gracefulShutdown('unhandledRejection', { fatalError: error }).catch((shutdownError) => {
    console.error('[shutdown] unhandledRejection cleanup failed', shutdownError)
    process.exit(1)
  })
})

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').then(() => process.exit(0)).catch(() => process.exit(1))
})

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').then(() => process.exit(0)).catch(() => process.exit(1))
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
      const error = new Error(`HTTP ${response.status}${details ? `: ${details.slice(0, 220)}` : ''}`)
      error.statusCode = response.status
      error.responseBody = details
      throw error
    }

    if (response.status === 204) {
      return null
    }

    return response.json().catch(() => null)
  } finally {
    clearTimeout(timeout)
  }
}

function isContactResolveConflict(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0)
  const rawBody = typeof error?.responseBody === 'string' ? error.responseBody : ''
  const normalizedBody = rawBody.toLowerCase()

  if (statusCode === 409) {
    return true
  }

  if (statusCode === 500) {
    return (
      normalizedBody.includes('contacts_instance_id_jid_key') ||
      normalizedBody.includes('duplicate key value') ||
      normalizedBody.includes('23505')
    )
  }

  return false
}

function resolveContactOperation(result) {
  const op = String(result?.operation || result?.outcome || result?.status || '').toLowerCase()

  if (['created', 'updated', 'already_exists'].includes(op)) {
    return op
  }

  return 'created'
}

function logContactResolve(instanceId, jid, operation, extra = {}) {
  console.log(
    JSON.stringify({
      event: 'contact_resolve',
      instanceId,
      jid,
      operation,
      ...extra,
    }),
  )
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

function isHttpStatusError(error, statusCode) {
  return Number(error?.statusCode || error?.status || 0) === Number(statusCode)
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

function hasDuplicateContactConflict(errorLike) {
  const statusCode = parseStatusCode(errorLike)
  if (statusCode === 409) {
    return true
  }

  const serialized = String(errorLike?.message || errorLike || '').toLowerCase()
  return (
    serialized.includes('contacts_instance_id_jid_key') ||
    (serialized.includes('duplicate key value') && serialized.includes('contacts'))
  )
}

function extractSenderPn(message) {
  const candidates = [
    message?.key?.senderPn,
    message?.senderPn,
    message?.messageContextInfo?.senderPn,
  ]

  for (const candidate of candidates) {
    const jid = String(candidate || '').trim()
    if (jid.endsWith('@s.whatsapp.net')) {
      return jid
    }
  }

  return null
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

function resolveJidType(jid) {
  return String(jid || '').trim().endsWith('@lid') ? 'lid' : 'pn'
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

  const digits = normalizeDigits(originalTo)
  if (digits && digits === originalTo) {
    return { originalTo, toNormalized: `${digits}@s.whatsapp.net` }
  }

  if (/^\d+-\d+$/.test(originalTo)) {
    return { originalTo, toNormalized: `${originalTo}@g.us` }
  }

  return { originalTo, toNormalized: originalTo }
}

function extractLidPnPair(message) {
  const key = message?.key || {}
  const candidates = [
    key.remoteJid,
    key.remoteJidAlt,
    key.participant,
    key.participantAlt,
    message?.participant,
    message?.participantAlt,
    message?.sender,
    message?.senderAlt,
  ].filter(Boolean)

  let jidLid = null
  let jidPn = null

  for (const candidate of candidates) {
    const jid = String(candidate || '').trim()
    if (!jid) {
      continue
    }

    if (!jidLid && jid.endsWith('@lid')) {
      jidLid = jid
    }

    if (!jidPn && jid.endsWith('@s.whatsapp.net')) {
      jidPn = jid
    }
  }

  if (!jidLid || !jidPn) {
    return null
  }

  return {
    jid_lid: jidLid,
    jid_pn: jidPn,
  }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isSignalSessionError(errorLike) {
  const serialized = String(errorLike?.message || errorLike || '').toLowerCase()
  return SIGNAL_SESSION_ERROR_SNIPPETS.some((snippet) => serialized.includes(snippet))
}

class IdentityAliasStore {
  constructor(filePath) {
    this.filePath = filePath
    this.loaded = false
    this.data = { lid_to_pn: {}, pn_to_lid: {} }
  }

  async load() {
    if (this.loaded) {
      return
    }

    this.loaded = true
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = {
        lid_to_pn: parsed?.lid_to_pn || {},
        pn_to_lid: parsed?.pn_to_lid || {},
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`[identity-map] load failed path=${this.filePath} reason=${normalizeReason(error)}`)
      }
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.data), 'utf8')
  }

  async rememberPair(jidLid, jidPn) {
    await this.load()

    const lid = String(jidLid || '').trim()
    const pn = String(jidPn || '').trim()
    if (!lid || !pn || !lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) {
      return false
    }

    const changed = this.data.lid_to_pn[lid] !== pn || this.data.pn_to_lid[pn] !== lid
    this.data.lid_to_pn[lid] = pn
    this.data.pn_to_lid[pn] = lid

    if (changed) {
      await this.save()
    }

    return changed
  }

  async resolveCanonical(jid, fallbackPn = null) {
    await this.load()

    const normalizedJid = String(jid || '').trim()
    const normalizedFallbackPn = String(fallbackPn || '').trim()

    if (normalizedFallbackPn.endsWith('@s.whatsapp.net')) {
      return normalizedFallbackPn
    }

    if (!normalizedJid) {
      return normalizedJid
    }

    if (normalizedJid.endsWith('@s.whatsapp.net')) {
      return normalizedJid
    }

    if (normalizedJid.endsWith('@lid')) {
      return this.data.lid_to_pn[normalizedJid] || normalizedJid
    }

    return normalizedJid
  }
}

class OutboundQueueRunner {
  constructor(runtime, edgeClient) {
    this.runtime = runtime
    this.edgeClient = edgeClient
    this.interval = null
    this.processing = false
  }

  async resolveDestination(queued) {
    const originalTo = String(queued?.to || '').trim()
    if (originalTo.endsWith('@lid')) {
      const resolved = await this.edgeClient.primaryJid(this.runtime.instanceId, originalTo)
      const jidPn = String(resolved?.jid_pn || resolved?.jid || '').trim()
      if (!jidPn) {
        return {
          originalTo,
          toNormalized: null,
          error: 'lid_without_mapping',
        }
      }
      return {
        originalTo,
        toNormalized: jidPn,
      }
    }

    const normalized = normalizeOutboundTo(queued)
    if (normalized?.error) {
      return {
        ...normalized,
        error: `invalid-destination:${normalized.error}`,
      }
    }

    return normalized
  }

  async sendWithSessionRecovery(toNormalized, queued) {
    let attempt = 0

    while (attempt <= DECRYPT_RETRY_MAX_ATTEMPTS) {
      const targetJid = await this.runtime.connection.resolveCanonicalJid(toNormalized)
      try {
        return await this.sendOutboundMessage(targetJid, queued)
      } catch (error) {
        if (!isSignalSessionError(error)) {
          throw error
        }

        const isNoMatchingSession = String(error?.message || error || '')
          .toLowerCase()
          .includes('no matching sessions found')
        const canRetry = isNoMatchingSession && attempt < DECRYPT_RETRY_MAX_ATTEMPTS

        if (!canRetry) {
          console.warn(
            `[fallback] reason=decrypt_retry_exhausted instance=${this.runtime.instanceId} jid=${targetJid} attempts=${attempt + 1}`,
          )
          throw error
        }

        const retryAttempt = attempt + 1
        const backoffMs = SESSION_REFRESH_BACKOFF_MS[Math.min(attempt, SESSION_REFRESH_BACKOFF_MS.length - 1)]
        console.warn(
          `[fallback] reason=session_refresh_attempt instance=${this.runtime.instanceId} jid=${targetJid} attempt=${retryAttempt} backoffMs=${backoffMs}`,
        )
        await this.runtime.connection.refreshSessionForJid(targetJid)
        await sleep(backoffMs)
      }

      attempt += 1
    }

    throw new Error('decrypt-retry-loop-exhausted')
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

      if (count === 0) {
        return
      }

      console.log(`[queue] polled count=${count} instance=${this.runtime.instanceId}`)

      for (const queued of messages) {
        if (!this.runtime.isConnected() || !this.runtime.sock) {
          break
        }

        if (!queued?.id || !queued?.to || (!queued?.body && !queued?.media_url)) {
          console.warn(`[queue:${this.runtime.instanceId}] malformed queued message id=${queued?.id || 'n/a'}`)
          if (queued?.id) {
            try {
              await this.edgeClient.post('/mark-failed', {
                messageId: queued.id,
                error: 'malformed-message',
                send_debug: { reason: 'missing required fields (to, body, or media_url)' },
              })
            } catch (markError) {
              console.warn(`[queue:${this.runtime.instanceId}] mark-failed unavailable for ${queued.id}`)
            }
          }
          continue
        }

        const { originalTo, toNormalized, error: toError } = await this.resolveDestination(queued)

        if (toError) {
          const reason = toError
          let markStatus = 'ok'
          try {
            await this.edgeClient.post('/mark-failed', {
              messageId: queued.id,
              error: reason,
              send_debug: {
                toOriginal: originalTo,
                toNormalized,
                reason,
              },
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
          const result = await this.sendWithSessionRecovery(toNormalized, queued)
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
    this.contactResolveCache = new Map()
    this.identityAliasStore = new IdentityAliasStore(path.join(AUTH_BASE, runtime.instanceId, 'identity-alias-map.json'))
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

  async resolveCanonicalJid(jid, senderPn = null) {
    const canonicalJid = await this.identityAliasStore.resolveCanonical(jid, senderPn)
    const originalJid = String(jid || '').trim()

    if (canonicalJid !== originalJid) {
      console.log(
        `[fallback] reason=identity_alias_resolved instance=${this.runtime.instanceId} from=${originalJid} to=${canonicalJid}`,
      )
    }

    return canonicalJid
  }

  async rememberIdentityAlias(jidLid, jidPn) {
    const changed = await this.identityAliasStore.rememberPair(jidLid, jidPn)
    if (changed) {
      console.log(
        `[identity] alias-updated instance=${this.runtime.instanceId} lid=${jidLid} pn=${jidPn}`,
      )
    }
  }

  async refreshSessionForJid(jid) {
    const canonical = await this.resolveCanonicalJid(jid)
    await this.edgeClient.refreshSession({
      instanceId: this.runtime.instanceId,
      jid: canonical,
      trigger: 'no_matching_sessions',
    })
    console.log(
      `[fallback] reason=session_refreshed instance=${this.runtime.instanceId} jid=${canonical}`,
    )
  }

  async connect() {
    if (this.connecting || this.connected || this.sock) {
      return
    }

    this.intentionalStop = false
    this.connecting = true

    try {
      await this.edgeClient.safeUpdateStatus(this.runtime.instanceId, 'CONNECTING', null)
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

  resolveCacheKey(instanceId, jid) {
    return `${instanceId}:${jid}`
  }

  getCachedContactResolve(instanceId, jid) {
    const key = this.resolveCacheKey(instanceId, jid)
    const cached = this.contactResolveCache.get(key)
    if (!cached) {
      return null
    }

    if (cached.expiresAt <= Date.now()) {
      this.contactResolveCache.delete(key)
      return null
    }

    return cached
  }

  cacheContactResolve(instanceId, jid, data) {
    this.contactResolveCache.set(this.resolveCacheKey(instanceId, jid), data)
    if (this.contactResolveCache.size > 500) {
      const now = Date.now()
      for (const [key, cached] of this.contactResolveCache) {
        if (cached.expiresAt <= now) {
          this.contactResolveCache.delete(key)
        }
      }
    }
  }

  async resolveSenderContactId({ instanceId, contactJid, pushName }) {
    if (!contactJid) {
      return null
    }

    const cached = this.getCachedContactResolve(instanceId, contactJid)
    if (cached) {
      return cached.contactId
    }

    try {
      const resolved = await this.edgeClient.resolveContact({
        instanceId,
        jid: contactJid,
        jid_type: resolveJidType(contactJid),
        push_name: pushName,
      })
      const contactId = resolved?.contact_id || resolved?.id || null
      this.cacheContactResolve(instanceId, contactJid, {
        contactId,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      })
      return contactId
    } catch (error) {
      if (hasDuplicateContactConflict(error)) {
        this.cacheContactResolve(instanceId, contactJid, {
          contactId: null,
          expiresAt: Date.now() + CONTACT_RESOLVE_DUPLICATE_COOLDOWN_MS,
        })
        console.log(`[contact-resolve:${instanceId}] duplicate ignored jid=${contactJid}`)
        return null
      }

      this.cacheContactResolve(instanceId, contactJid, {
        contactId: null,
        expiresAt: Date.now() + CONTACT_RESOLVE_ERROR_COOLDOWN_MS,
      })
      console.warn(
        `[contact-resolve:${instanceId}] failed jid=${contactJid} error=${normalizeReason(error)}`,
      )
      return null
    }
  }

  bindEvents(saveCreds) {
    this.sock.ev.on('creds.update', saveCreds)

    this.sock.ev.on('messages.upsert', async (upsert) => {
      const instanceId = this.runtime.instanceId
      if (!upsert?.messages?.length) return
      console.log(`[upsert] instance=${instanceId} type=${upsert?.type} count=${upsert.messages.length}`)

      if (upsert.type && upsert.type !== 'notify' && upsert.type !== 'append') return

      for (const msg of upsert.messages) {
        if (!msg) continue

        const key = msg.key
        const chatIdNorm = key?.remoteJid
        if (!chatIdNorm) continue

        const lidPnPair = extractLidPnPair(msg)
        if (lidPnPair?.jid_lid && lidPnPair?.jid_pn) {
          try {
            await this.rememberIdentityAlias(lidPnPair.jid_lid, lidPnPair.jid_pn)
          } catch (error) {
            console.warn(
              `[identity] alias-save-failed instance=${instanceId} lid=${lidPnPair.jid_lid} pn=${lidPnPair.jid_pn} error=${normalizeReason(error)}`,
            )
          }
        }

        const isGroup = chatIdNorm.endsWith('@g.us')
        const senderJidRaw = isGroup
          ? key.participant || chatIdNorm
          : key.fromMe
            ? this.sock?.user?.id || chatIdNorm
            : chatIdNorm
        const senderPn = extractSenderPn(msg)
        const contactJid = key.fromMe
          ? chatIdNorm
          : senderPn || senderJidRaw

        const chatIdCanonical = await this.resolveCanonicalJid(chatIdNorm)
        const senderJidCanonical = await this.resolveCanonicalJid(senderJidRaw, senderPn)

        const pushName = resolvePushName(upsert, msg)
        const senderContactId = key.fromMe
          ? null
          : await this.resolveSenderContactId({
              instanceId,
              contactJid,
              pushName,
            })

        const { mediaType, body, content } = extractInboundContent(msg)

        if (!body && !mediaType) continue

        let mediaUrl = null
        let mimeType = null
        let fileName = null
        let fileSize = null
        if (mediaType && content) {
          try {
            const mediaBuffer = await downloadInboundMedia(content, mediaType)
            mimeType = content?.mimetype || null
            fileName =
              content?.fileName ||
              `${key.id || `msg-${Date.now()}`}.${inferExtension({
                mimeType,
                fileName: content?.fileName || '',
                mediaType,
              })}`
            fileSize = mediaBuffer.length

            const uploaded = await this.edgeClient.uploadMedia({
              instanceId,
              messageId: key.id || null,
              mime_type: mimeType,
              file_name: sanitizeFileName(fileName),
              bytes_base64: mediaBuffer.toString('base64'),
            })
            mediaUrl = uploaded?.media_url || null
          } catch (error) {
            console.error(`[inbound-media] ERROR instance=${instanceId} messageId=${key.id || 'n/a'}`, error)
          }
        }

        if (mediaType && !mediaUrl) continue

        const payload = {
          instanceId,
          from: senderJidRaw,
          to: this.sock?.user?.id || '',
          body,
          wa_message_id: key.id || null,
          from_me: !!key.fromMe,
          chat_id_norm: chatIdCanonical,
          sender_jid_raw: senderJidCanonical,
          sender_pn: senderPn,
          sender_contact_id: senderContactId,
          push_name: pushName,
          media_type: mediaType,
          media_url: mediaUrl,
          mime_type: mimeType,
          file_name: fileName,
          file_size: fileSize,
        }

        try {
          const inboundController = new AbortController()
          const inboundTimeout = setTimeout(() => inboundController.abort(), HTTP_TIMEOUT_MS)
          try {
            const res = await fetch(`${EDGE_BASE_URL}/inbound`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${WORKER_SECRET}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
              signal: inboundController.signal,
            })
            const txt = await res.text()
            if (!res.ok) {
              console.error(`[inbound] FAIL instance=${instanceId} status=${res.status} body=${txt}`)
            } else {
              console.log(`[inbound] ok instance=${instanceId} chat=${chatIdNorm}`)
            }
          } finally {
            clearTimeout(inboundTimeout)
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
          console.log(`[qr] ready instance=${this.runtime.instanceId} — awaiting scan`)
        } catch (error) {
          console.error(`[qr] failed instance=${this.runtime.instanceId}: ${normalizeReason(error)}`)
        }
      }

      if (update.connection === 'open') {
        this.connecting = false
        this.connected = true
        this.connectedAt = Date.now()
        this.reconnectAttempt = 0
        this.badMacTimestamps = []
        this.clearReconnect()
        console.log(`[conn:${this.runtime.instanceId}] open jid=${this.sock?.user?.id || 'unknown'}`)
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
    this.tripBadMacCircuitBreaker(count).catch((error) => {
      console.error(`[conn:${this.runtime.instanceId}] circuit-breaker failed: ${normalizeReason(error)}`)
    }).finally(() => {
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
    this.intentionalStop = true
    this.clearReconnect()
    this.outbound.stop()
    const oldSock = this.sock
    this.sock = null
    this.runtime.sock = null
    this.connecting = false
    this.connected = false

    if (oldSock) {
      try {
        oldSock.end(new Error('auth wipe restart'))
      } catch (endError) {
        // socket may already be closed; ignore
      }
    }

    try {
      await fs.rm(this.authPath, { recursive: true, force: true })
    } catch (error) {
      console.error(`[conn:${this.runtime.instanceId}] auth wipe failed: ${normalizeReason(error)}`)
    }

    try {
      this.runtime.manager.resetRuntime(this.runtime.instanceId)
      await this.runtime.manager.ensureRunning(this.runtime.instanceId)
    } catch (error) {
      console.error(
        `[conn:${this.runtime.instanceId}] wipeAuthAndRestart restart failed trigger=${trigger}: ${normalizeReason(error)}`,
      )
      // next discoveryCycle will retry
    }
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
  absoluteUrl(endpoint) {
    return `${EDGE_BASE_URL}${endpoint}`
  }

  async get(endpoint) {
    return requestJson('GET', endpoint)
  }

  async getEligibleInstances(endpoint) {
    const url = this.absoluteUrl(endpoint)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${WORKER_SECRET}` },
        signal: controller.signal,
      })

      console.log(`[discovery] eligible-instances url=${url} status=${response.status}`)

      const rawBody = await safeReadBody(response)

      if (response.status !== 200) {
        console.error(`[discovery] eligible-instances non-200 body=${rawBody}`)
        const error = new Error(`HTTP ${response.status}${rawBody ? `: ${rawBody.slice(0, 220)}` : ''}`)
        error.statusCode = response.status
        error.responseBody = rawBody
        throw error
      }

      try {
        return {
          bodyText: rawBody,
          payload: rawBody ? JSON.parse(rawBody) : null,
        }
      } catch (error) {
        console.error(`[discovery] eligible-instances invalid JSON body=${rawBody}`)
        throw error
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async post(endpoint, payload) {
    return requestJson('POST', endpoint, payload)
  }

  async resolveLid(instanceId, jid) {
    return this.primaryJid(instanceId, jid)
  }

  async primaryJid(instanceId, jid) {
    return this.get(
      `/contacts/primary-jid?instanceId=${encodeURIComponent(instanceId)}&jid=${encodeURIComponent(jid)}`,
    )
  }

  async resolveContact(payload) {
    return this.post('/contacts/resolve', payload)
  }

  async uploadMedia(payload) {
    return this.post('/upload-media', payload)
  }

  async refreshSession(payload) {
    return this.post('/sessions/refresh', payload)
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

  async acquireInstanceLock({ instanceId, instanceOwner, ttlMs }) {
    return this.post('/instance-lock/acquire', {
      instanceId,
      instance_owner: instanceOwner,
      ttl_ms: ttlMs,
    })
  }

  async renewInstanceLock({ instanceId, instanceOwner, ttlMs, lockToken }) {
    return this.post('/instance-lock/renew', {
      instanceId,
      instance_owner: instanceOwner,
      ttl_ms: ttlMs,
      lock_token: lockToken || null,
    })
  }

  async releaseInstanceLock({ instanceId, instanceOwner, lockToken }) {
    return this.post('/instance-lock/release', {
      instanceId,
      instance_owner: instanceOwner,
      lock_token: lockToken || null,
    })
  }
}

function parseLockPayload(payload) {
  const acquired = payload?.acquired ?? payload?.lock_acquired ?? false
  const owner = payload?.instance_owner || payload?.owner || null
  const lockToken = payload?.lock_token || payload?.token || null
  return {
    acquired: Boolean(acquired),
    owner,
    lockToken,
  }
}

class InstanceLockCoordinator {
  constructor(edgeClient, { onLockLost }) {
    this.edgeClient = edgeClient
    this.onLockLost = onLockLost
    this.ownership = new Map()
  }

  getOwner(instanceId) {
    return this.ownership.get(instanceId)?.instanceOwner || null
  }

  hasOwnership(instanceId) {
    return this.ownership.has(instanceId)
  }

  async acquire(instanceId) {
    let response
    try {
      response = await this.edgeClient.acquireInstanceLock({
        instanceId,
        instanceOwner: PROCESS_OWNER_ID,
        ttlMs: LOCK_TTL_MS,
      })
    } catch (error) {
      if (isHttpStatusError(error, 404)) {
        console.warn(`[lock_skip] instance=${instanceId} reason=not_found`)
        return false
      }
      throw error
    }

    const { acquired, owner, lockToken } = parseLockPayload(response)
    if (!acquired) {
      console.warn(
        `[lock_conflict] instance=${instanceId} instance_owner=${owner || 'unknown'} requester=${PROCESS_OWNER_ID}`,
      )
      return false
    }

    this.setOwnership(instanceId, {
      instanceOwner: owner || PROCESS_OWNER_ID,
      lockToken,
    })

    console.log(
      `[lock_acquired] instance=${instanceId} instance_owner=${this.getOwner(instanceId)} ttlMs=${LOCK_TTL_MS}`,
    )
    return true
  }

  setOwnership(instanceId, { instanceOwner, lockToken }) {
    const current = this.ownership.get(instanceId)
    if (current?.renewInterval) {
      clearInterval(current.renewInterval)
    }

    const state = {
      instanceOwner,
      lockToken,
      renewInterval: setInterval(() => {
        this.renew(instanceId).catch((error) => {
          console.error(`[lock_renew_error] instance=${instanceId} error=${normalizeReason(error)}`)
        })
      }, LOCK_RENEW_INTERVAL_MS),
    }

    this.ownership.set(instanceId, state)
  }

  async renew(instanceId) {
    const state = this.ownership.get(instanceId)
    if (!state) {
      return false
    }

    const response = await this.edgeClient.renewInstanceLock({
      instanceId,
      instanceOwner: state.instanceOwner,
      ttlMs: LOCK_TTL_MS,
      lockToken: state.lockToken,
    })
    const { acquired, owner, lockToken } = parseLockPayload(response)

    if (!acquired) {
      console.error(
        `[lock_conflict] instance=${instanceId} instance_owner=${owner || 'unknown'} requester=${PROCESS_OWNER_ID}`,
      )
      await this.clearOwnership(instanceId, { releaseRemote: false })
      await this.onLockLost(instanceId)
      return false
    }

    state.lockToken = lockToken || state.lockToken
    if (owner) {
      state.instanceOwner = owner
    }
    return true
  }

  async release(instanceId, { reason = 'unknown' } = {}) {
    const state = this.ownership.get(instanceId)
    if (!state) {
      return false
    }

    try {
      await this.edgeClient.releaseInstanceLock({
        instanceId,
        instanceOwner: state.instanceOwner,
        lockToken: state.lockToken,
      })
    } catch (error) {
      console.error(
        `[lock_release_error] instance=${instanceId} reason=${reason} error=${normalizeReason(error)}`,
      )
    }

    await this.clearOwnership(instanceId, { releaseRemote: false })
    console.log(`[lock_released] instance=${instanceId} reason=${reason}`)
    return true
  }

  async clearOwnership(instanceId, { releaseRemote = true } = {}) {
    const state = this.ownership.get(instanceId)
    if (!state) {
      return
    }

    if (state.renewInterval) {
      clearInterval(state.renewInterval)
    }

    this.ownership.delete(instanceId)

    if (!releaseRemote) {
      return
    }

    try {
      await this.edgeClient.releaseInstanceLock({
        instanceId,
        instanceOwner: state.instanceOwner,
        lockToken: state.lockToken,
      })
    } catch (error) {
      console.error(`[lock_release_error] instance=${instanceId} error=${normalizeReason(error)}`)
    }
  }

  async releaseAll({ reason = 'shutdown' } = {}) {
    const ids = [...this.ownership.keys()]
    for (const instanceId of ids) {
      await this.release(instanceId, { reason })
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
    this.isShuttingDown = false
    this.lockCoordinator = new InstanceLockCoordinator(this.edgeClient, {
      onLockLost: async (instanceId) => {
        await this.handleLockLost(instanceId)
      },
    })
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
    if (!this.lockCoordinator.hasOwnership(instanceId)) {
      const acquired = await this.lockCoordinator.acquire(instanceId)
      if (!acquired) {
        return false
      }
    }

    const runtime = this.getOrCreateRuntime(instanceId)
    if (runtime.isBusy() || runtime.sock) {
      return false
    }

    try {
      await runtime.connection.connect()
      return true
    } catch (error) {
      await this.lockCoordinator.release(instanceId, { reason: 'connect-failure' })
      throw error
    }
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
      await this.lockCoordinator.release(instanceId, { reason: 'runtime-missing' })
      return false
    }

    await runtime.connection.stopGracefully()
    this.runtimes.delete(instanceId)
    await this.lockCoordinator.release(instanceId, { reason: 'stop-gracefully' })
    return true
  }

  async handleLockLost(instanceId) {
    console.error(`[lock_lost] instance=${instanceId} requester=${PROCESS_OWNER_ID}`)
    await this.stopGracefully(instanceId)
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
      const eligibleInstancesEndpoint = '/eligible-instances?enabled=true&limit=50&order=priority.desc'

      const [settings, candidatesResponse] = await Promise.all([
        this.edgeClient.get('/worker-settings').catch((error) => {
          console.error(`[discovery] worker-settings unavailable: ${normalizeReason(error)}`)
          return null
        }),
        this.edgeClient.getEligibleInstances(eligibleInstancesEndpoint),
      ])

      const candidatesPayload = candidatesResponse?.payload
      const bodyText = candidatesResponse?.bodyText

      const list = candidatesPayload?.instances ?? candidatesPayload?.data ?? []
      const parsedInstances = Array.isArray(list) ? list : []
      const instancesRaw = parsedInstances.filter((item) => item?.id)
      const parsedIds = instancesRaw.map((instance) => String(instance.id))

      console.log(`[discovery] parsed instances count=${instancesRaw.length} ids=${JSON.stringify(parsedIds)}`)

      const maxActiveInstances = this.getMaxActiveInstances(settings)
      const ordered = this.stablePrioritize(instancesRaw)
      const targetInstances = maxActiveInstances > 0 ? ordered.slice(0, maxActiveInstances) : ordered
      const targetIds = targetInstances.map((instance) => String(instance.id))

      this.desiredIds = new Set(targetIds)

      for (const instance of targetInstances) {
        const candidate = String(instance.id)

        try {
          const started = await this.ensureRunning(candidate)
          const runtime = this.runtimes.get(candidate)

          if (runtime) {
            runtime.priority = numberOrFallback(instance.priority, 0)
          }

          if (started) {
            startedIds.push(candidate)
          }
        } catch (error) {
          console.error(`[discovery] ensureRunning failed for ${candidate}: ${normalizeReason(error)}`)
        }
      }

      if (targetIds.length === 0) {
        console.warn(`[discovery] no eligible instances — body=${bodyText?.slice(0, 200)}`)
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

      if (startedIds.length > 0 || stoppedIds.length > 0) {
        console.log(
          `[discovery] changes started=${JSON.stringify(startedIds)} stopped=${JSON.stringify(stoppedIds)}`,
        )
      }
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
      if (this.isShuttingDown) {
        return
      }
      this.discoveryCycle().catch((error) => {
        console.error(`[discovery] cycle crash: ${normalizeReason(error)}`)
      })
    }, DISCOVERY_POLL_MS)
  }

  async shutdown({ signal }) {
    this.isShuttingDown = true
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval)
      this.discoveryInterval = null
    }

    const runtimeIds = [...this.runtimes.keys()]
    for (const instanceId of runtimeIds) {
      try {
        await this.stopGracefully(instanceId)
      } catch (error) {
        console.error(`[shutdown] stop failed instance=${instanceId} error=${normalizeReason(error)}`)
      }
    }

    await this.lockCoordinator.releaseAll({ reason: signal || 'shutdown' })
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
    const total = instanceManager?.runtimes?.size ?? 0
    const connected = instanceManager
      ? [...instanceManager.runtimes.values()].filter((r) => r.isConnected()).length
      : 0
    console.log(`[worker] alive instances=${total} connected=${connected} owner=${PROCESS_OWNER_ID}`)
  }, KEEP_ALIVE_MS)

  if (!EDGE_BASE_URL || !WORKER_SECRET) {
    await new Promise(() => {})
    return
  }

  const manager = new InstanceManager()
  instanceManager = manager
  await manager.start()
  await new Promise(() => {})
}

start().catch((error) => {
  console.error('[boot] fatal start error', error)
})
