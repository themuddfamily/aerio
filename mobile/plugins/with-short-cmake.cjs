const { withAppBuildGradle } = require('expo/config-plugins');
module.exports = (config) => withAppBuildGradle(config, (result) => {
  const marker = '// Aerio: keep generated C++ object paths within Windows limits';
  if (!result.modResults.contents.includes(marker)) result.modResults.contents += `\n${marker}\nandroid {\n  defaultConfig { externalNativeBuild { cmake { arguments "-DCMAKE_OBJECT_PATH_MAX=128" } } }\n  externalNativeBuild { cmake { buildStagingDirectory file("\$rootDir/../.cxx") } }\n}\n`;
  return result;
});
