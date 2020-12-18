const { Keystone } = require('@keystonejs/keystone');
const { Text, Relationship, Select, Integer, Decimal, DateTime, DateTimeUtc, Checkbox } = require('@keystonejs/fields');
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
        active:  { type: Checkbox, isRequired: true, knexOptions: { defaultTo: true } },
        createdAt: { type: DateTimeUtc, isRequired: true, schemaDoc: 'A datetime on the moment a schema have been applied to the database' }
    }
});
   
keystone.createList('Todo', {  
    schemaDoc: 'A list of things which need to be done',    
    fields: {
        name: { type: Text, schemaDoc: 'This is the thing you need to do' }, 
        priority: { type: Text,  },
        category: { type: Relationship, ref: 'Category.todo', many: false },  
        user: { type: Relationship, ref: 'User.todo' },
        createdAt: { type: DateTime },
        at: { type: DateTime }
    },    
});   
   
keystone.createList('Category', { 
    schemaDoc: 'The category of the Todo',   
    fields: {  
        name: { type: Text, schemaDoc: 'The user full name', isUnique: false, isIndexed: false  },  
        parent: { type: Relationship, ref: 'Category.children', many: true },
        children: { type: Relationship, ref: 'Category.parent', many: false },                         
        todo: { type: Relationship, ref: 'Todo.category', many: true },
    },  
}); 

keystone.createList('User', { 
    fields: {
        name: { type: Text, schemaDoc: 'The user full name', isUnique: false, isIndexed: false  },
        todo: { type: Relationship, ref: 'Todo.user', many: false},
//        role: { type: Relationship, ref: 'Role', many: true }
    },
});
/*
keystone.createList('Role', { 
    fields: {
        name: { type: Text, schemaDoc: 'The role', isUnique: true, isIndexed: false  },
    },
});
  */
module.exports = { 
    keystone,
    apps: [
        new GraphQLApp(),
        new StaticApp({ path: '/', src: 'public' }), 
        new AdminUIApp({ name: PROJECT_NAME, enableDefaultRoute: true }),
    ],
};
 
