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
                             Object.assign({}, { tableName: listAdapter.tableName },
                                           listAdapter.config),
                             this._buildFields(listAdapter.fieldAdapters));

            this._createAssociations(listAdapter, listAdapter.fieldAdapters.filter(f => f.fieldName === "Relationship"));
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
//                        "refListKey",
//                        "refFieldPath",
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
        this._schema = knex.schema;
        this._listAdapters = listAdapters;

    }

    async apply(modifications) {

        // Keeps track of relationships modifications when both side
        // of the associations depend on the "other" modification data       
        const referencedAssociationsState = this._buildReferencedAssociationsState(modifications);        
        const orderedModifications = this._sortModifications(modifications);
        
        for(const modification of orderedModifications) {
            await this._applyIf({ object: "list", op: "create" }, modification, () => this._createTable(modification));
            await this._applyIf({ object: "association", op: "create" }, modification, () => this._createAssociation(modification, referencedAssociationsState));
        };
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

    async _createTable(modification) {

        const tableName = modification.options.tableName || modification.name;

        if(await this._schema.hasTable(tableName)) {
            await this._dropTable(modification);
        }

        await this._schema.createTable(tableName, (t) => {

            modification.fields.forEach(field => {
                this._listAdapterFieldAddToTableSchema(modification.name, field, t, modification);
            });
        });
    }

    async _createAssociation(modification, referencedAssociationsState) {
        
        if(!modification.target.referenced) {
            // Standalone reference

            if(modification.cardinality === "N:1") {

                // Foreign key field goes to the list that declares a relationship
                
                await this._schema.table(modification.name, (t) => {
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
                
                await this._schema.createTable(pivotTableName, (t) => {

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
                                
                await this._schema.table(modification.name, (t) => {
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

                await this._schema.table(modification.target.list, (t) => {
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
                
                await this._schema.createTable(pivotTableName, (t) => {

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

        await this._schema.dropTableIfExists(tableName);
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
