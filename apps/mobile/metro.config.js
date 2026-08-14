// Monorepo Metro config: without this, Metro can't resolve @h59/protocol,
// @h59/scoring and @h59/shared (hoisted to the workspace root node_modules)
// or pick up changes made to those packages' source files.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// The @h59/* packages ship TS source directly (see their package.json "main"),
// so Metro needs to be told to transform .ts/.tsx found outside this app's
// own folder too — disabling hierarchical lookup keeps resolution scoped to
// the two paths above instead of walking every parent node_modules.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
