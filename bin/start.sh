#!/usr/bin/env sh

if [ ! -f /tmp/started.lock ]; then
    echo "Copying node_modules..."    
    cp -R /tmp/app/* /opt/my-app
    echo "done" >> /tmp/started.lock
fi

cd /opt/keystone-adapter-knex-migration
npm link

cd /opt/my-app
npm link keystone-adapter-knex-migration

nodemon --exec "npm run dev"
