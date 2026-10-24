const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { rules: { 'react/no-unescaped-entities': 'off' } },
  { files: ['modules/safety-native/plugin/**/*.js', 'app.plugin.js', '*.config.js'], languageOptions: { globals: { __dirname: 'readonly', require: 'readonly', module: 'readonly', console: 'readonly' } } },
  { ignores: ['dist/*', 'ios/*', 'android/*', 'modules/safety-native/ios/*', 'modules/safety-native/android/*'] },
]);
