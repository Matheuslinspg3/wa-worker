# wa-worker

Worker de WhatsApp (Baileys) com suporte a **multi-instância robusta**, persistência local por instância e integração via **Edge Functions proxy**.

## O que este worker faz

- Mantém até `N` instâncias ativas (`max_active_instances`) com priorização estável por `priority`.
- Evita thrash de scheduler (não recria socket já ativo e só para fora do target com cooldown de 60s).
- Faz reconexão com backoff por instância (`2s,5s,10s,20s,40s,60s`).
- Processa outbound com marcação confiável (`mark-sent` / `mark-failed`).
- Envia inbound rico com metadados completos (chat, sender, ids, timestamp, body).

## Arquitetura

### 1) InstanceManager

A cada `DISCOVERY_POLL_MS`:

1. `GET /worker-settings` → `{ max_active_instances }`
2. `GET /eligible-instances?enabled=true&limit=50&order=priority.desc` (ou equivalente) → `{ instances:[{ id, priority }] }`
3. Calcula `targetIds = TOP N` por prioridade (ordem estável para empates).
4. Chama `ensureRunning(id)` para cada `targetId`.
5. Chama `stopGracefully(id)` somente para runtime fora do target (com cooldown de 60s quando conectado).

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
2. Para cada mensagem: `sock.sendMessage(...)`
3. Sucesso: `POST /mark-sent`
4. Falha: `POST /mark-failed` (se disponível)

> Nunca envia outbound se a instância não estiver `CONNECTED`.

### 4) Inbound

No `messages.upsert` (`type=notify`) envia para `/inbound`:

- `instanceId`
- `chat_id`
- `chat_id_raw`
- `chat_id_norm`
- `from_me`
- `sender_id`
- `wa_message_id`
- `timestamp`
- `body`

`@lid` é tratado como ID normal (sem tentativa de conversão para telefone).

## Variáveis de ambiente

- `EDGE_BASE_URL` (**obrigatória**)
  - Exemplo: `https://<project>.supabase.co/functions/v1/worker-proxy`
- `WORKER_SECRET` (**obrigatória**)
  - Header: `Authorization: Bearer <WORKER_SECRET>`
- `PORT` (opcional, default `3000`)
- `DISCOVERY_POLL_MS` (opcional, default `10000`)
- `QUEUE_POLL_MS` (opcional, default `2000`)
- `AUTH_BASE` (opcional, default `/data/auth`)
- `MAX_ACTIVE_INSTANCES` (fallback opcional se backend não retornar setting)
- `BAD_MAC_WINDOW_MS` (opcional, default `60000`)
- `BAD_MAC_THRESHOLD` (opcional, default `20`)
- `BAD_MAC_COOLDOWN_MS` (opcional, default `300000`)

## Persistência (obrigatória)

Monte volume persistente em `/data`.

Estrutura esperada por instância:

- `/data/auth/<instanceId>`

## Endpoints consumidos

Com base no `EDGE_BASE_URL`:

- `GET /worker-settings`
- `GET /eligible-instances?enabled=true&limit=50&order=priority.desc`
- `POST /update-status`
- `GET /queued-messages?instanceId=<instanceId>`
- `POST /mark-sent`
- `POST /mark-failed` (opcional, recomendado)
- `POST /inbound`

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
4. Persistent volume obrigatório:
   - Mount path: `/data`
5. Expor porta do healthcheck (`3000` ou valor de `PORT`)

## Execução local

```bash
node index.js
```
