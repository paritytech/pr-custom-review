FROM node:16.14-alpine

RUN mkdir /app && chown node:node /app
COPY --chown=node:node  . /app
WORKDIR /app

USER node
RUN yarn install --immutable

ARG PORT
EXPOSE $PORT
ENV PORT=$PORT

CMD [ "sh", "-c", "yarn start" ]
