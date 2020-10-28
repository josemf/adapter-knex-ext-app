const { Keystone } = require('@keystonejs/keystone');
const { Text, Relationship, Select, Integer, Decimal, DateTimeUtc } = require('@keystonejs/fields');
const { GraphQLApp } = require('@keystonejs/app-graphql');
const { AdminUIApp } = require('@keystonejs/app-admin-ui');
const { StaticApp } = require('@keystonejs/app-static');

const Adapter = require('keystone-adapter-knex-migrations');

const PROJECT_NAME = 'my-app';
const adapterConfig = {
    
    knexOptions: {
        connection: 'postgres://postgres:postgres@db/postgres'
    },

    knexMigrationsOptions: {
        migrationsFilePath: './compiled/migrations.json',
        migrationsSchemaFilePath: './compiled/schema.json',
        schemaTableName: "InternalSchema"                  
    }
};
 
const keystone = new Keystone({
    adapter: new Adapter(adapterConfig), 
});   

keystone.createList('InternalSchema', {
    schemaDoc: 'It keeps track all schema versions mapped to database at some point. This is used by `migrations-create` to compare against the defined list schemas.',
    fields: {
        content: { type: Text, isRequired: true, schemaDoc: 'The schema content as a JSON string' },
        createdAt: { type: DateTimeUtc, isRequired: true, schemaDoc: 'A datetime on the moment a schema have been applied to the database' }
    }
});

keystone.createList('Todo', {
    schemaDoc: 'A list of things which need to be done',
    fields: {
        name: { type: Text, schemaDoc: 'This is the thing you need to do' },
        priority: { type: Integer, isRequired: true },
//        category: { type: Relationship, ref: 'Category.todo', many: false },
        //otherCategory: { type: Relationship, ref: 'Category', many: true },
        //tags: { type: Relationship, ref: 'Tag.todos', many: true },
    },
});

keystone.createList('Category', {
    schemaDoc: 'The category of the Todo',
    fields: {
        name: { type: Text, schemaDoc: 'The user full name' },        
//        todo: { type: Relationship, ref: 'Todo.category', many: false },
    },
});

keystone.createList('Tag', {
    fields: {
        name: { type: Text, isRequired: true },
        //todos: { type: Relationship, ref: 'Todo.tags', many: true }
    }
});
 
module.exports = {
    keystone,
    apps: [
        new GraphQLApp(),
        new StaticApp({ path: '/', src: 'public' }),
        new AdminUIApp({ name: PROJECT_NAME, enableDefaultRoute: true }),
    ],
};
 
