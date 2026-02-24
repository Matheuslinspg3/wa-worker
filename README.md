# wa-worker

Worker Node.js básico para integração com WhatsApp (Baileys) e Supabase, pronto para deploy no Easypanel.

## Pré-requisitos

- Node.js 18+
- npm 9+

## Instalação local

1. Instale as dependências:

```bash
npm install
```

2. Defina as variáveis de ambiente (por exemplo, em um arquivo `.env`):

```env
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key
INSTANCE_ID=sua_instancia
```

3. Execute o worker:

```bash
npm start
```

Ao iniciar corretamente, o processo exibirá `Worker iniciado` no console.

## Deploy no Easypanel

1. Crie o serviço apontando para este repositório.
2. Configure o deploy usando `easypanel deploy` (ou via interface do Easypanel).
3. Defina as variáveis de ambiente no serviço:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `INSTANCE_ID`
4. Configure um volume persistente montado em `/data` para armazenar sessões do WhatsApp.

## Estrutura do projeto

```text
.
├── .gitignore
├── AGENTS.md
├── Dockerfile
├── README.md
├── index.js
└── package.json
```
