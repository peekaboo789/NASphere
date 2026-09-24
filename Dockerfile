FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chmod 700 /data

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
