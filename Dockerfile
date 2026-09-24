FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=18086 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /app/data && chmod 700 /app/data

EXPOSE 18086

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||18086)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
