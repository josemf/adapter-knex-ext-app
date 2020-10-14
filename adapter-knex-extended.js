const { KnexAdapter } = require('@keystonejs/adapter-knex');

const fs = require('fs');

const MODIFICATIONS_FILE_PATH = './compiled/modifications.json';

class ListModificationBuilder {

    constructor(listAdapter) {
        this._listAdapter = listAdapter;
    }

    build() {
        return this._createList(this._listAdapter.key,
                                Object.assign({}, { tableName: this._listAdapter.tableName }, this._listAdapter.config),
                                this._buildFields(this._listAdapter.fieldAdapters));        
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
        return this._modification("list", "create", name, { options, fields });
    }

    _modification(object, op, name, extra = {}) {
        return {
            object,
            op,
            name,
            ... extra
        };
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
        };        
    }

    _sortModifications(modifications) {
        // This will sort modifications so create tables go first, remove tables second, fields add or remove third and foreign keys or indexes last
        return modifications.sort((m1, m2) => {

            const objects = [ "list", "field", "reference" ];
            const ops = [ "create", "remove", "update", "rename"];

            if(objects[m1.object] < objects[m2.object]) {
                return -1;
            }

            if(objects[m1.object] > objects[m2.object]) {
                return 1;
            }

            if(ops[m1.op] < ops[m2.op]) {
                return -1;
            }

            if(ops[m1.op] > ops[m2.op]) {
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
        const modifications = Object.values(this.listAdapters).reduce((a, listAdapter) => a.concat((new ListModificationBuilder(listAdapter)).build()), []);
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
