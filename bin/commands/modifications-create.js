const path = require('path');
const chalk = require('chalk');
const { DEFAULT_ENTRY } = require('@keystonejs/keystone');
const { getEntryFileFullPath } = require('@keystonejs/keystone/bin/utils');
const { asyncForEach } = require('@keystonejs/utils');

const createModifications = async (args, entryFile, spinner) => {

    // Allow the spinner time to flush its output to the console.
    await new Promise(resolve => setTimeout(resolve, 100));
    const { keystone } = require(path.resolve(entryFile));
    await keystone.connect(); // Need to do _createModifications post connect so awaiting connect
    let errors = false;
    await asyncForEach(Object.values(keystone.adapters), async adapter => {

        if (!adapter.createModifications) {
            spinner.info(chalk.yellow.bold(`create-modifications requires the Knex Ext adapter`));            
            return;
        }
        try {
            console.log('Creating list modification files...');
            await adapter.createModifications();
        } catch (e) {
            spinner.fail(chalk.red.bold(`Some error occurred`));
            console.log(e);
            errors = true;
        }
    });
    if (!errors) {
        spinner.succeed(chalk.green.bold(`List modification files created`));
        process.exit(0);
    }
    process.exit(1);
};

module.exports = {
    // prettier-ignore
    spec: {
        '--entry':      String,
    },
    help: ({ exeName }) => `
    Usage
      $ ${exeName} modifications-create

    Options
      --entry       Entry file exporting keystone instance [${DEFAULT_ENTRY}]
  `,
    exec: async (args, { exeName, _cwd = process.cwd() } = {}, spinner) => {
        spinner.text = 'Validating project entry file';
        const entryFile = await getEntryFileFullPath(args, { exeName, _cwd });
        spinner.start(' ');
        return createModifications(args, entryFile, spinner);
    },
};
