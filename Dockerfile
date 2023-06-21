FROM node:16 as Builder

WORKDIR /action

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn run build

RUN yarn run package

FROM node:16-slim

COPY --from=Builder /action/dist/prcr /action

ENTRYPOINT ["node", "/action/index.js"]
