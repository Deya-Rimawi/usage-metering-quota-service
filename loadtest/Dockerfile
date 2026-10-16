FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY *.mjs ./
USER node
ENTRYPOINT ["node", "run.mjs"]
CMD ["all"]
