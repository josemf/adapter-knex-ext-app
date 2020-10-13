# https://docs.docker.com/samples/library/node/
ARG NODE_VERSION=12.10.0

FROM node:${NODE_VERSION}-alpine

RUN apk update && apk upgrade && \
    apk add --no-cache git

RUN npm i -g nodemon

RUN mkdir -p /tmp/app

COPY package*.json /tmp/app/

WORKDIR /tmp/app

RUN npm i

WORKDIR /opt/my-app

COPY bin /opt/bin/
RUN chmod +x /opt/bin/*

EXPOSE 3000
CMD ["/opt/bin/start.sh"]
