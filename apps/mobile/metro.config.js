// Expo's default Metro config, plus one resolver override.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// @anthropic-ai/sdk: Metro resolves the package's ESM build (index.mjs), whose circular imports
// (beta messages ↔ BetaToolRunner) throw "Cannot read property 'BetaToolRunner' of undefined" at load on
// Hermes and web. The CommonJS build tolerates the cycle, so load that one. Its internal requires stay CJS.
const anthropicSdkCjs = require.resolve('@anthropic-ai/sdk');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@anthropic-ai/sdk') return { type: 'sourceFile', filePath: anthropicSdkCjs };
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
