const { Keystone } = require('@keystonejs/keystone');
const { Text, Relationship, Select, Integer, Decimal, DateTimeUtc } = require('@keystonejs/fields');
const { GraphQLApp } = require('@keystonejs/app-graphql');
const { AdminUIApp } = require('@keystonejs/app-admin-ui');
const { StaticApp } = require('@keystonejs/app-static');

const Adapter = require('./adapter-knex-extended');

const PROJECT_NAME = 'my-app';
const adapterConfig = { knexOptions: { connection: 'postgres://postgres:postgres@db/postgres' } };

const keystone = new Keystone({
    adapter: new Adapter(adapterConfig),
});

keystone.createList('InternalSchema', {
    schemaDoc: 'It keeps track of list schemas mapped to database, so we know how to compare database schemas without using introspection',
    fields: {
        content: { type: Text, isRequired: true, schemaDoc: 'The schema contant as a JSON string' },
        createdAt: { type: DateTimeUtc, isRequired: true, schemaDoc: 'The data time moment the schema have been applied to the database structure' }
    }
});

keystone.createList('Todo', {
    schemaDoc: 'A list of things which need to be done',
    fields: {
        name: { type: Text, schemaDoc: 'This is the thing you need to do' },
        workflow: { type: Select, dataType: "enum", options: [ "Home", "Work", "Leasure" ] },
        category: { type: Text },
        createdBy: { type: Relationship, ref: 'User.todo', many: false }
    },
});

keystone.createList('User', {
    schemaDoc: 'The user that keeps the todo in check',
    fields: {
        firstName: { type: Text, schemaDoc: 'The user full name' },
        lastName: { type: Text, schemaDoc: 'The user full name' },
        email: { type: Decimal, isRequired: true, knexOptions: { precision: 2, scale: 1}, schemaDoc: 'The user email' },        

        age: { type: Integer, isRequired: true },
        
        todo: { type: Relationship, ref: 'Todo.createdBy', many: true }
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
 
