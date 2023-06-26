FROM node:16 as Builder

WORKDIR /action

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn run build

RUN yarn run package

ENTRYPOINT ["node", "/action/dist/prcr/index.js"]
