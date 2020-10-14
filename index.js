const { Keystone } = require('@keystonejs/keystone');
const { Text, Relationship } = require('@keystonejs/fields');
const { GraphQLApp } = require('@keystonejs/app-graphql');
const { AdminUIApp } = require('@keystonejs/app-admin-ui');
const { StaticApp } = require('@keystonejs/app-static');

const Adapter = require('./adapter-knex-extended');

const PROJECT_NAME = 'my-app';
const adapterConfig = { knexOptions: { connection: 'postgres://postgres:postgres@db/postgres' } };

const keystone = new Keystone({
    adapter: new Adapter(adapterConfig),
});

keystone.createList('Todo', {
    schemaDoc: 'A list of things which need to be done',
    fields: {
        name: { type: Text, schemaDoc: 'This is the thing you need to do' },
        createdBy: { type: Relationship, ref: 'User' }
    },
});

keystone.createList('User', {
    schemaDoc: 'The user that keeps the todo in check',
    fields: {
        firstName: { type: Text, schemaDoc: 'The user first name' },
        lastName: { type: Text, schemaDoc: 'The user last name' },
        email: { type: Text, schemaDoc: 'The user email address'}
    },
});

module.exports = {
    keystone,
    apps: [
        new GraphQLApp(),
        new StaticApp({ path: '/', src: 'public' }),
        new AdminUIApp({ name: PROJECT_NAME, enableDefaultRoute: true }),
    ],
};
