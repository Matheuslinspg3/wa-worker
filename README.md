# wa-worker

Worker de WhatsApp (Baileys) com persistência local de sessão em volume e integração via **Edge Functions proxy**.

## Arquitetura

Este worker **não usa Supabase Service Role diretamente**. Em vez disso, ele faz chamadas HTTP para um proxy em Edge Functions usando `WORKER_SECRET`.

### Variáveis de ambiente

- `EDGE_BASE_URL` (obrigatória)
  - Ex: `https://<project>.supabase.co/functions/v1/worker-proxy`
- `WORKER_SECRET` (obrigatória)
  - Enviada no header: `Authorization: Bearer <WORKER_SECRET>`
- `INSTANCE_ID` (opcional)
  - Default: `default`

## Persistência de sessão

A sessão do Baileys é salva em:

- `/data/<INSTANCE_ID>`

Em deploy, monte um volume persistente em `/data`.

## Endpoints consumidos

Com base no `EDGE_BASE_URL`:

- `POST /update-status`
- `GET /queued-messages?instanceId=<INSTANCE_ID>`
- `POST /mark-sent`
- `POST /inbound`

## Configuração no Easypanel

1. **Build/Runtime**: Node.js (ou Dockerfile deste repositório)
2. **Command**: `node index.js`
3. **Environment variables**:
   - `EDGE_BASE_URL`
   - `WORKER_SECRET`
   - `INSTANCE_ID` (opcional)
4. **Persistent volume**:
   - Mount path: `/data`
5. **Porta (healthcheck)**:
   - Adicione a porta `3000` no Easypanel
   - Target: `3000`
   - Published: opcional

> Não configure `SUPABASE_SERVICE_ROLE_KEY` neste worker. A credencial fica apenas no backend/proxy.

## Exemplos de chamadas (curl)

> Use valores fictícios localmente e **nunca** exponha seu segredo real.

### update-status

```bash
curl -X POST "$EDGE_BASE_URL/update-status" \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"default","status":"CONNECTING","qr_code":null}'
```

### queued-messages

```bash
curl "$EDGE_BASE_URL/queued-messages?instanceId=default" \
  -H "Authorization: Bearer $WORKER_SECRET"
```

### mark-sent

```bash
curl -X POST "$EDGE_BASE_URL/mark-sent" \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"messageId":"123","wa_message_id":"wamid.HBg..."}'
```

### inbound

```bash
curl -X POST "$EDGE_BASE_URL/inbound" \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"default","from":"5511999999999@s.whatsapp.net","to":"5511888888888@s.whatsapp.net","body":"oi","wa_message_id":"wamid.HBg..."}'
```

## Execução local

```bash
node index.js
```
