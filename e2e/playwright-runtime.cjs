const os = require('node:os');
const path = require('node:path');
const {Module} = require('node:module');

const loadPlaywright = () => {
  try {
    return require('playwright');
  }
  catch (originalError) {
    const modules = process.env.CODEX_NODE_MODULES || path.join(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'node',
      'node_modules'
    );
    process.env.NODE_PATH = [
      path.join(modules, '.pnpm', 'node_modules'),
      modules,
      process.env.NODE_PATH
    ].filter(Boolean).join(path.delimiter);
    Module._initPaths();
    try {
      return require(process.env.PLAYWRIGHT_PATH || path.join(modules, 'playwright'));
    }
    catch (fallbackError) {
      fallbackError.cause = originalError;
      throw fallbackError;
    }
  }
};

module.exports = loadPlaywright();
