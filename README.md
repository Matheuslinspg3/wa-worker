# wa-worker

Worker de WhatsApp (Baileys) com suporte a **multi-instância robusta**, persistência local por instância e integração via **Edge Functions proxy**.

## O que este worker faz

- Mantém até `N` instâncias ativas (`max_active_instances`) com priorização estável por `priority`.
- Aplica trava distribuída por `instance_id` com renovação de TTL para evitar bootstrap duplicado entre processos.
- Evita thrash de scheduler (não recria socket já ativo e só para fora do target com cooldown de 60s).
- Faz reconexão com backoff por instância (`2s,5s,10s,20s,40s,60s`).
- Processa outbound com marcação confiável (`mark-sent` / `mark-failed`).
- Envia inbound com metadados de conversa (chat/sender) e suporte a mídia (`media_type`, `media_url`).
- Salva mídia inbound localmente em `/data/media/<instanceId>` antes do upload no proxy.

## Arquitetura

### 1) InstanceManager

A cada `DISCOVERY_POLL_MS`:

1. `GET /worker-settings` → `{ max_active_instances }`
2. `GET /eligible-instances?enabled=true&limit=50&order=priority.desc` (ou equivalente) → `{ instances:[{ id, priority }] }`
3. Calcula `targetIds = TOP N` por prioridade (ordem estável para empates).
4. Chama `ensureRunning(id)` para cada `targetId`.
5. Chama `stopGracefully(id)` somente para runtime fora do target (com cooldown de 60s quando conectado).

Antes de iniciar conexão/handlers, o worker tenta adquirir lock distribuído (`/instance-lock/acquire`).
Se houver conflito (`lock_conflict`), a instância não inicia neste processo.
Locks adquiridos são renovados em background (`/instance-lock/renew`) até shutdown.

### 2) ConnectionRunner (por instância)

- Auth state em: `useMultiFileAuthState(/data/auth/<instanceId>)`.
- Eventos de status:
  - QR: `POST /update-status { status: "CONNECTING", qr_code: dataUrl }`
  - Open: `POST /update-status { status: "CONNECTED", qr_code: null }`
  - Close: `POST /update-status { status: "DISCONNECTED", qr_code: null }`
- Reconexão com backoff por instância e reset no open.
- Wipe de auth em sinais de sessão inválida/logged out/stream 515.
- Circuit breaker para corrupção de sessão Signal (`Bad MAC`/falha de decrypt): ao exceder `BAD_MAC_THRESHOLD` em `BAD_MAC_WINDOW_MS`, marca `DISCONNECTED`, limpa auth local e força novo QR.

### 3) OutboundQueueRunner (por instância conectada)

A cada `QUEUE_POLL_MS`:

1. `GET /queued-messages?instanceId=...`
2. Para cada mensagem:
   - Somente texto: `sock.sendMessage(to, { text: body })`
   - Com `media_url`: baixa arquivo e envia por tipo (`image`, `video`, `audio`, `document`)
3. Sucesso: `POST /mark-sent`
4. Falha: `POST /mark-failed` (se disponível)

Normalização de destino outbound:

- número puro `5511999999999` → `5511999999999@s.whatsapp.net`
- id de grupo `1203630...-1234567890` → `...@g.us`
- `@lid` → resolve via `GET /contacts/primary-jid?instanceId=...&jid=...`; se retornar PN (`jid_pn`/`jid`), usa como destino
- `@lid` sem resolução → falha com `mark-failed` (`lid_without_mapping`, incluindo `send_debug`)

> Nunca envia outbound se a instância não estiver `CONNECTED`.

### 4) Inbound

No `messages.upsert` (`type=notify`) envia para `/inbound`:

- `instanceId` (obrigatório)
- `from` (obrigatório): autor real (grupo=`participant`, privado=`remoteJid`)
- `to` (obrigatório): `sock.user.id`
- `body` (obrigatório; pode ser `""` se houver mídia)
- `chat_id` (obrigatório): `message.key.remoteJid`
- `chat_type`: `group` quando `chat_id` termina com `@g.us`, senão `direct`
- `sender_jid_raw` (obrigatório): grupo=`key.participant`, privado=`key.remoteJid`
- `sender_contact_id` (opcional): resolvido via `POST /contacts/resolve` com `{ instanceId, jid, jid_type, push_name }`
- `push_name` (opcional)
- `wa_message_id` (opcional)
- `timestamp` (opcional)
- `media_type` (opcional): `image|video|audio|document`
- `media_url` (opcional; obrigatório quando `media_type` presente)
- `mime_type`, `file_name`, `file_size` (opcionais)

Regras:

- Se não houver `body` **e** não houver mídia, o worker não envia `/inbound`.
- Para mídia, o arquivo é salvo em `/data/media/<instanceId>/<wa_message_id>.<ext>` e depois enviado ao proxy via `POST /upload-media` (Bearer `WORKER_SECRET`).
- O worker não loga bytes/base64 de mídia.

## Variáveis de ambiente

- `EDGE_BASE_URL` (**obrigatória**)
  - Exemplo: `https://<project>.supabase.co/functions/v1/worker-proxy`
- `WORKER_SECRET` (**obrigatória**)
  - Header: `Authorization: Bearer <WORKER_SECRET>`
- `PORT` (opcional, default `3000`)
- `DISCOVERY_POLL_MS` (opcional, default `10000`)
- `QUEUE_POLL_MS` (opcional, default `2000`)
- `INSTANCE_LOCK_TTL_MS` (opcional, default `30000`)
- `INSTANCE_LOCK_RENEW_MS` (opcional, default `INSTANCE_LOCK_TTL_MS/2`, mínimo `2000`)
- `AUTH_BASE` (opcional, default `/data/auth`)
- `MEDIA_BASE` (opcional, default `/data/media`)
- `MAX_ACTIVE_INSTANCES` (fallback opcional se backend não retornar setting)
- `BAD_MAC_WINDOW_MS` (opcional, default `60000`)
- `BAD_MAC_THRESHOLD` (opcional, default `20`)
- `BAD_MAC_COOLDOWN_MS` (opcional, default `300000`)

## Persistência (obrigatória)

Monte volume persistente em `/data`.

Estrutura esperada por instância:

- `/data/auth/<instanceId>`
- `/data/media/<instanceId>`

## Endpoints consumidos

Com base no `EDGE_BASE_URL`:

- `GET /worker-settings`
- `GET /eligible-instances?enabled=true&limit=50&order=priority.desc`
- `POST /update-status`
- `GET /queued-messages?instanceId=<instanceId>`
- `POST /mark-sent`
- `POST /mark-failed` (opcional, recomendado)
- `POST /inbound`
- `POST /contacts/resolve`
- `GET /contacts/primary-jid?instanceId=<instanceId>&jid=<jid@lid>`
- `POST /upload-media` (obrigatório para inbound de mídia)
- `POST /instance-lock/acquire`
- `POST /instance-lock/renew`
- `POST /instance-lock/release`

### Contrato recomendado para `POST /upload-media` (worker-proxy)

Entrada (JSON):

```json
{
  "instanceId": "<uuid>",
  "messageId": "<wa_message_id>",
  "mime_type": "image/jpeg",
  "file_name": "foto.jpg",
  "bytes_base64": "..."
}
```

Saída (JSON):

```json
{
  "media_url": "https://..."
}
```

Sugestão: no `worker-proxy`, usar `SUPABASE_SERVICE_ROLE_KEY` server-side para upload no bucket de Storage (`media` ou bucket equivalente), sem expor a service key no worker.

## Health server

- Bind: `0.0.0.0`
- Porta: `PORT`
- Endpoint: `GET /health` → `ok`

## Deploy (Easypanel)

1. Runtime: Node.js (ou Dockerfile do repo)
2. Command: `node index.js`
3. Environment variables:
   - `EDGE_BASE_URL`
   - `WORKER_SECRET`
   - `PORT` (opcional)
   - `DISCOVERY_POLL_MS` (opcional)
   - `QUEUE_POLL_MS` (opcional)
   - `AUTH_BASE` (opcional)
   - `MEDIA_BASE` (opcional)
4. Persistent volume obrigatório:
   - Mount path: `/data`
5. Expor porta do healthcheck (`3000` ou valor de `PORT`)

## Execução local

```bash
node index.js
```
