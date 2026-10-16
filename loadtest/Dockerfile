FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY *.mjs ./
ENTRYPOINT ["node", "run.mjs"]
CMD ["all"]
