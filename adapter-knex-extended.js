const { KnexAdapter } = require('@keystonejs/adapter-knex');

const fs = require('fs');
const { detailedDiff } = require("deep-object-diff");

const MODIFICATIONS_FILE_PATH = './compiled/modifications.json';
const MODIFICATIONS_SCHEMA_FILE_PATH = './compiled/schema.json';
const DEFAULT_CACHE_SCHEMA_TABLE_NAME = "InternalSchema";

class ListModificationBuilder {
    
    constructor(listAdapters, knex) {
        this._listAdapters = listAdapters;

        this._modificationsList = [];
        this._knex = knex;

        // Keeps the current working copy of the schema
        // This is what we want to represent in the database
        this._schemaCurrent = new Map();

        // Keeps the cached version of the schema. We will
        // have to fetch this from the DB and represents the
        // schema we have currently mapped in the DB
        this._schemaCached = new Map();
    }

    async build() {
        
        this._buildCurrentSchema();
        await this._loadCachedSchema();

        this._schemaCurrent.forEach((listSchema, listName) => {

            const listAdapter = this._listAdapters[listSchema.list];            
            const cachedSchema = this._schemaCached.get(listName);

            if(!cachedSchema) {

                // The doesn't exists as a table in the database
                // NOTE: It might be renamed--we should think of a clever way to take care of this
                
                this._createList(listSchema.list, listSchema.options, listSchema.fields);
                this._createAssociations(listAdapter, listAdapter.fieldAdapters.filter(f => f.fieldName === "Relationship"));                
            } else {

                // The list exists and we should compare all options, fields and associations

                const diff = detailedDiff(cachedSchema, listSchema);

                if(Object.keys(diff.added).length > 0 && Object.keys(diff.added.fields).length > 0) {
                    
                    Object.keys(diff.added.fields).forEach(fieldIndex => {

                        const fieldSchema = diff.added.fields[fieldIndex];
                        const fieldThatComesBefore = listSchema.fields[Number(fieldIndex) - 1];

                        if(fieldSchema.type === "Relationship") {
                            // If the field is a Relationship we should create a Association instead
                            
                            this._createAssociations(listAdapter, [ listAdapter.fieldAdaptersByPath[fieldSchema.name] ]);                                            
                        } else {
                            this._createField(fieldSchema.name, listSchema.list, { after: fieldThatComesBefore && fieldThatComesBefore.name || false }, fieldSchema);
                        }
                    });
                }
            }            
        });
        
        return {
            modifications: this._modificationsList,
            schema: Array.from(this._schemaCurrent.values())
        };
    }

    _buildCurrentSchema() {

        Object.values(this._listAdapters).forEach(listAdapter => {

            const listSchema = this._buildList(listAdapter.key,
                                               Object.assign({}, { tableName: listAdapter.tableName }, listAdapter.config),
                                               this._buildFields(listAdapter.fieldAdapters));
            
            this._schemaCurrent.set(listAdapter.key, listSchema);
        });        
    }

    _buildList(name, options, fields) {
        return {
            list: name,
            options: options,
            fields: fields
        };
    }

    async _loadCachedSchema()  {

        if(!this._listAdapters[DEFAULT_CACHE_SCHEMA_TABLE_NAME]) {
            throw Error(`This is not implemented. For the time being make sure to add this list to your app configuration:

keystone.createList('InternalSchema', {
    schemaDoc: 'It keeps track of list schemas mapped to database, so we know how to compare database schemas without using introspection',
    fields: {
        content: { type: Text, schemaDoc: 'The schema contant as a JSON string' },
        createdAt: { type: DateTime, schemaDoc: 'The data time moment the schema have been applied to the database structure' }
    },
});
`);            
        }
        
        if(!await this._knex.schema.hasTable(DEFAULT_CACHE_SCHEMA_TABLE_NAME)) {                        
            return;
        }

        const cachedSchemaResponse = await this._knex(DEFAULT_CACHE_SCHEMA_TABLE_NAME).select("content").limit(1).orderBy("createdAt", "asc");

        if(cachedSchemaResponse.length === 0) {
            return;
        }

        const cachedSchemaLists = JSON.parse(cachedSchemaResponse[0].content);

        cachedSchemaLists.forEach(list => this._schemaCached.set(list.list, list));
    }
    
    _buildOptions(keys, object) {
        return keys.reduce((options, key) => {

            if(typeof object[key] !== "undefined") {
                options[key] = object[key];
            }

            return options;
        }, {});
    }

    _buildFields(fieldAdapters) {

        return fieldAdapters
            .filter(fieldAdapter => fieldAdapter.fieldName !== "Relationship")
            .map(fieldAdapter => {

                // This would be a lot easier if Field Adapters would store the original field definition

                const options = Object.assign(

                    // Most cases lie here

                    this._buildOptions([
                        "isPrimaryKey",
                        "isRequired",
                        "isUnique",
                        "isIndexed",
                        "defaultValue",
                        "dataType",
                        "options",
                    ], fieldAdapter.field),

                    // This is required by Decimal and maybe others

                    this._buildOptions([
                        "knexOptions"
                    ], fieldAdapter)
                );

                return {
                    type: fieldAdapter.fieldName,
                    name: fieldAdapter.path,
                    options
                };
            });
    }

    _createList(name, options, fields) {
        this._modification("list", "create", name, { options, fields });
    }

    _createField(name, list, options, field) {
        this._modification("field", "create", name, { list, options, field });
    }
    
    _createAssociations(listAdapter, fieldAdapters) {

        fieldAdapters
            .forEach(fieldAdapter => {

                const data = {
                    cardinality: fieldAdapter.rel.cardinality,
                    field: fieldAdapter.path,
                    target: {
                        list: fieldAdapter.field.refListKey,
                        referenced: fieldAdapter.field.refFieldPath
                    }
                };

                this._modification("association", "create", listAdapter.key, data);
            });        
    }

    _modification(object, op, name, extra = {}) {
        this._modificationsList.push({
            object,
            op,
            name,
            ... extra
        });
    }
}

class ListModificationExecution {
    constructor(listAdapters, knex) {
        this._knex = knex;
        this._listAdapters = listAdapters;

    }

    async apply(modifications, schema) {

        // Keeps track of relationships modifications when both side
        // of the associations depend on the "other" modification data       
        const referencedAssociationsState = this._buildReferencedAssociationsState(modifications);        
        const orderedModifications = this._sortModifications(modifications);
        
        for(const modification of orderedModifications) {
            await this._applyIf({ object: "list", op: "create" }, modification, () => this._createTable(modification));
            await this._applyIf({ object: "association", op: "create" }, modification, () => this._createAssociation(modification, referencedAssociationsState));
        };

        await this._saveFreshDatabaseSchema(schema);        
    }

    _buildReferencedAssociationsState(modifications) {

        return modifications
            .filter(m => m.object === "association")
            .reduce((a, m) => {
                if(m.target.referenced) {
                    a[`${m.name}__${m.field}`] = {
                        takenCare:  false,                        
                        modification: m
                    };
                }

                return a;
            }, {});
    }
    
    _sortModifications(modifications) {
        // This will sort modifications so create tables go first, remove tables second, fields add or remove third and foreign keys or indexes last
        return modifications.sort((m1, m2) => {

            const objects = [ "list", "field", "association" ];
            const ops = [ "create", "remove", "update", "rename"];

            if(objects.indexOf(m1.object) < objects.indexOf(m2.object)) {
                return -1;
            }

            if(objects.indexOf(m1.object) > objects.indexOf(m2.object)) {
                return 1;
            }

            if(ops.indexOf(m1.op) < ops.indexOf(m2.op)) {
                return -1;
            }

            if(ops.indexOf(m1.op) > ops.indexOf(m2.op)) {
                return 1;
            }

            return 0;
        });
    }

    async _applyIf({ object, op }, modification, callback) {
        if(modification.object === object && modification.op === op) {
            return await callback();
        }

        return Promise.resolve();
    }

    async _saveFreshDatabaseSchema(schema) {
        await this._knex
            .insert({ content: schema, createdAt: new Date() })
            .into(DEFAULT_CACHE_SCHEMA_TABLE_NAME);
    }
    
    async _createTable(modification) {

        const tableName = modification.options.tableName || modification.name;

        if(await this._knex.schema.hasTable(tableName)) {

            console.log(`* ${tableName} table already exists in the database. Droping.`);
            
            await this._dropTable(modification);
        }

        console.log(`* Creating table ${tableName}`);
        
        await this._knex.schema.createTable(tableName, (t) => {
            
            modification.fields.forEach(field => {
                this._listAdapterFieldAddToTableSchema(modification.name, field, t, modification);
            });
        });

    }

    async _createAssociation(modification, referencedAssociationsState) {

        console.log(`* Creating association refering table ${modification.name} and field ${modification.field} refering to table ${modification.target.list}`);

        if(!modification.target.referenced) {
            // Standalone reference

            if(modification.cardinality === "N:1") {

                // Foreign key field goes to the list that declares a relationship
                
                await this._knex.schema.table(modification.name, (t) => {
                    t.integer(modification.field).unsigned();
                    // TODO: This might be required, or unique or whatever
                    t.index(modification.field);
                    t.foreign(modification.field)
                    // TODO: Need to handle those scenarios ids might be
                    // setup differently
                        .references("id")
                        .inTable(modification.target.list);
                });                
            }

            if(modification.cardinality === "N:N") {

                // We create a Pivot table with name `<TableName>_<fieldName>_many`
                // With fields <TableName>_left_id and <TargetTableName>_right_id

                const pivotTableName = `${modification.name}_${modification.field}_many`;
                
                await this._knex.schema.createTable(pivotTableName, (t) => {

                    const leftFieldName = `${modification.name}_left_id`;                    
                    t.integer(leftFieldName);
                    t.index(leftFieldName);
                    t.foreign(leftFieldName)
                        .references("id")
                        .inTable(modification.name);

                    const rightFieldName = `${modification.target.list}_right_id`;                    
                    t.integer(rightFieldName);
                    t.index(rightFieldName);
                    t.foreign(rightFieldName)
                        .references("id")
                        .inTable(modification.target.list);                                        
                });
                
            }
        } else {

            const referencedModification    = referencedAssociationsState[`${modification.target.list}__${modification.target.referenced}`];
            const ownReferencedModification = referencedAssociationsState[`${modification.name}__${modification.field}`];

            if(referencedModification.takenCare) {
                // This was already caried out
                return;
            }
            
            if(modification.cardinality === "1:1" || modification.cardinality === "N:1") {
                // Foreign key field goes to the list that declares a relationship
                                
                await this._knex.schema.table(modification.name, (t) => {
                    t.integer(modification.field).unsigned();
                    t.index(modification.field);
                    t.foreign(modification.field)
                        .references("id")
                        .inTable(modification.target.list);
                });

                ownReferencedModification.takenCare = true;
            }

            if(modification.cardinality === "1:N") {
                // Foreign key goes to target list

                await this._knex.schema.table(modification.target.list, (t) => {
                    t.integer(referencedModification.modification.field).unsigned();
                    t.index(referencedModification.modification.field);
                    t.foreign(referencedModification.modification.field)
                        .references("id")
                        .inTable(modification.name);
                });

                ownReferencedModification.takenCare = true;
            }

            if(modification.cardinality === "N:N") {
                // This is implemented with a Pivot table `<SourceTable>_<field>_<TargetTable>_<field>`

                const pivotTableName = `${modification.name}_${modification.field}_${referencedModification.modification.name}_${referencedModification.modification.field}`;
                
                await this._knex.schema.createTable(pivotTableName, (t) => {

                    const leftFieldName = `${modification.name}_left_id`;                    
                    t.integer(leftFieldName);
                    t.index(leftFieldName);
                    t.foreign(leftFieldName)
                        .references("id")
                        .inTable(modification.name);

                    const rightFieldName = `${referencedModification.modification.name}_right_id`;                    
                    t.integer(rightFieldName);
                    t.index(rightFieldName);
                    t.foreign(rightFieldName)
                        .references("id")
                        .inTable(referencedModification.modification.name);                                        
                });

                ownReferencedModification.takenCare = true;                
            }
        }
    }

    async _dropTable(modification) {

        const tableName = modification.options.tableName || modification.name;

        await this._knex.schema.dropTableIfExists(tableName);
    }

    _listAdapterFieldAddToTableSchema(listName, field, t, m) {

        // I would prefer to build this listAdapter from scratch and feed the
        // options from the `modification<m>` itself but as a "compromise" feeding from
        // the list working copy is good enough for now--I might have to rebuild the
        // field composition from scratch

        const fieldAdapter = this._listAdapters[listName].fieldAdaptersByPath[field.name];
        fieldAdapter.addToTableSchema(t);
    } 
}

class KnexAdapterExtended extends KnexAdapter {

    constructor({ knexOptions = {}, schemaName = 'public' } = {}) {
        super({ knexOptions, schemaName });
    }

    async createModifications() {

        const builder = new ListModificationBuilder(this.listAdapters, this.knex);
        const { modifications, schema } = await builder.build();
        
        fs.writeFileSync(MODIFICATIONS_FILE_PATH, JSON.stringify(modifications));
        fs.writeFileSync(MODIFICATIONS_SCHEMA_FILE_PATH, JSON.stringify(schema));        
    }

    async doModifications() {

        if(!fs.existsSync(MODIFICATIONS_FILE_PATH)) {
            console.log(`Needs modifications file in place ${MODIFICATIONS_FILE_PATH}`);
            return;
        }

        if(!fs.existsSync(MODIFICATIONS_SCHEMA_FILE_PATH)) {
            console.log(`Needs modifications schema file in place ${MODIFICATIONS_SCHEMA_FILE_PATH}`);
            return;
        }        

        const modifications = JSON.parse(fs.readFileSync(MODIFICATIONS_FILE_PATH, "utf-8"));
        const schema = fs.readFileSync(MODIFICATIONS_SCHEMA_FILE_PATH, "utf-8");
        
        const execution = new ListModificationExecution(this.listAdapters, this.knex);
        await execution.apply(modifications, schema);
    }
}

module.exports = KnexAdapterExtended;
