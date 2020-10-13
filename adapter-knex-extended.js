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

            const options = this._buildOptions([ "isPrimaryKey", "isRequired", "defaultValue", ], field.field);            
            
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

        const schema = this.knex.schema;
        
        const modifications = JSON.parse(fs.readFileSync(MODIFICATIONS_FILE_PATH, "utf-8"));
        
        for(const modification of modifications) {
                  
            if(modification.object === "list" && modification.op === "create") {
                // DROP if exists?

                const tableName = modification.options.tableName || modification.name;
                
                if(await schema.hasTable(tableName)) {
                    await schema.dropTableIfExists(tableName);
                }

                await schema.createTable(tableName, function(t) {                    
                    modification.fields.forEach(field => {
                        if(field.type === "AutoIncrementImplementation") {
                            t.increments(field.name).primary();
                        } else {
                            t.text(field.name);
                        }
                    });

                });    
            }
        };

    }
}
 
module.exports = KnexAdapterExtended;
