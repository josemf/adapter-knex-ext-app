const { KnexAdapter } = require('@keystonejs/adapter-knex');

const fs = require('fs');

const MODIFICATIONS_FILE_PATH = './compiled/modifications.json';

class ListModificationBuilder {

    constructor(listAdapters) {
        this._listAdapters = listAdapters;

        this._modificationsList = [];
    }

    build() {

        Object.values(this._listAdapters).map(listAdapter => {
            this._createList(listAdapter.key,
                             Object.assign({}, { tableName: listAdapter.tableName }, listAdapter.config),
                             this._buildFields(listAdapter.fieldAdapters));        
        });
        
        return this._modificationsList;
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

        return fieldAdapters.map(field => {

            const options = this._buildOptions([
                "isPrimaryKey",
                "isRequired",
                "defaultValue",
                "refListKey",
                "refListPath"
            ], field.field);            
            
            return {
                type: field.fieldName,
                name: field.path,
                options
            };
        });
    }
    
    _createList(name, options, fields) {
        this._modification("list", "create", name, { options, fields });

        fields
            .filter(field => field.type === "Relationship")
            .forEach(field => {
                const associationName = `${name}-${field.name}-${field.options.refListKey}-${field.options.refListPath || "id"}`;
                
                this._modification("association", "create", associationName, {
                    from: {
                        list: name,
                        field: field.name,
                        cardinality: "one"
                    },
                    
                    to: {
                        list: field.options.refListKey,
                        field: field.options.refListPath || "id"
                    }
                });
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
        this._schema = knex.schema;
        this._listAdapters = listAdapters;
    }

    async apply(modifications) {

        const orderedModifications = this._sortModifications(modifications);
        
        for(const modification of orderedModifications) {
            await this._applyIf({ object: "list", op: "create" }, modification, () => this._createTable(modification));
            await this._applyIf({ object: "association", op: "create" }, modification, () => this._createAssociation(modification));            
        };        
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
    
    async _createTable(modification) {
        
        const tableName = modification.options.tableName || modification.name;
        
        if(await this._schema.hasTable(tableName)) {            
            await this._dropTable(modification);
        }            
        
        await this._schema.createTable(tableName, (t) => {
            
            modification.fields.forEach(field => {
                if(field.type === "Relationship") {

                    // Foreign key references are implemented using
                    // modifications, later on
                    // TODO: This could use a better implementation then Knex btw
                    
                    t.integer(field.name);                    
                } else {
                    this._listAdapterFieldAddToTableSchema(modification.name, field, t);
                }
            });            
        });        
    }

    async _createAssociation(modification) {

        if(modification.from.cardinality === "one") {

            // TODO: put tableName
            await this._schema.table(modification.from.list, (t) => {
                t.foreign(modification.from.field)
                    .references(modification.to.field, modification.name)
                    .inTable(modification.to.list);
            });
            
            console.log(modification);    
        }
        
    }    

    async _dropTable(modification) {
        
        const tableName = modification.options.tableName || modification.name;        
        
        await this._schema.dropTableIfExists(tableName);
    }

    _listAdapterFieldAddToTableSchema(listName, field, t) {
        const fieldAdapter = this._listAdapters[listName].fieldAdaptersByPath[field.name];        
        fieldAdapter.addToTableSchema(t);
    }
}

class KnexAdapterExtended extends KnexAdapter {

    constructor({ knexOptions = {}, schemaName = 'public' } = {}) {
        super({ knexOptions, schemaName });
    }
    
    async createModifications() {

        const builder = new ListModificationBuilder(this.listAdapters);       
        const modifications = builder.build();
        
        fs.writeFileSync(MODIFICATIONS_FILE_PATH, JSON.stringify(modifications));
    }

    async doModifications() {

        if(!fs.existsSync(MODIFICATIONS_FILE_PATH)) {
            console.log(`Needs modifications file in place ${MODIFICATIONS_FILE_PATH}`);            
            return;
        }
        
        const modifications = JSON.parse(fs.readFileSync(MODIFICATIONS_FILE_PATH, "utf-8"));        
        const execution = new ListModificationExecution(this.listAdapters, this.knex);

        await execution.apply(modifications);
    }
}
 
module.exports = KnexAdapterExtended;
