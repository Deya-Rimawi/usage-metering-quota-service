FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY *.mjs ./
COPY public ./public
COPY test ./test
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
