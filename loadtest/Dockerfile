FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.ts ./
USER node
ENTRYPOINT ["node", "run.ts"]
CMD ["all"]
