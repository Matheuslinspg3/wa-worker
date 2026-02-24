# Usa Node.js 18 como base para manter compatibilidade com o worker.
FROM node:18-alpine

# Define o diretório de trabalho dentro do container.
WORKDIR /app

# Copia somente os arquivos de dependência para otimizar cache de build.
COPY package.json ./

# Instala as dependências de produção do projeto.
RUN npm install --omit=dev

# Copia o restante do código para dentro do container.
COPY . .

# Define comando padrão de execução do worker.
CMD ["node", "index.js"]
