// Keeps the widget extension at the app's version and build number.
//
// App Store Connect refuses an upload whose extension does not carry the same
// CFBundleShortVersionString and CFBundleVersion as the app that contains it.
// @bacons/apple-targets 4.0.7 creates the widget target with
// GENERATE_INFOPLIST_FILE = YES and CURRENT_PROJECT_VERSION = ios.buildNumber
// or 1. On EAS the build number comes from the server (appVersionSource
// "remote"), and EAS writes it into the INFOPLIST_FILE of every signed target.
// With a generated Info.plist the build settings win over that file, so the
// widget would ship as build 1 next to an app at build N.
//
// This plugin, for every target made from targets/ (its Info.plist lives
// there):
//   - sets GENERATE_INFOPLIST_FILE = NO, so targets/<name>/Info.plist is used
//     as written (it must carry every key itself; checked below), and EAS's
//     version write into that file is what ships;
//   - sets MARKETING_VERSION and CURRENT_PROJECT_VERSION to the values Expo
//     writes into the app's own Info.plist, so the $(MARKETING_VERSION) and
//     $(CURRENT_PROJECT_VERSION) in the widget's Info.plist match the app in
//     a build EAS did not patch too.
//
// It runs as a finalized mod: after @bacons/apple-targets has written the
// Xcode project with its own parser, so it reads and writes the project file
// itself, with that same parser. Nothing here runs during introspection.
//
// Check the first IPA: Payload/Clox.app/Info.plist and
// Payload/Clox.app/PlugIns/*.appex/Info.plist must show the same two values
// (unzip, then plutil -p).

const fs = require("fs");
const path = require("path");
const { IOSConfig, withFinalizedMod } = require("expo/config-plugins");

// Resolve the parser and plist packages from @bacons/apple-targets' own
// folder, so this plugin reads and writes the project exactly as it does.
function requireFromAppleTargets(name) {
  const base = path.dirname(
    require.resolve("@bacons/apple-targets/package.json"),
  );
  return require(require.resolve(name, { paths: [base] }));
}

const APP_PRODUCT_TYPE = "com.apple.product-type.application";

// The keys an extension's Info.plist must carry once Xcode stops generating
// it. Without CFBundleIdentifier or CFBundleExecutable the extension does not
// install; without NSExtension it is not a widget at all.
const REQUIRED_KEYS = [
  "CFBundleDisplayName",
  "CFBundleExecutable",
  "CFBundleIdentifier",
  "CFBundleInfoDictionaryVersion",
  "CFBundleName",
  "CFBundlePackageType",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "NSExtension",
];

function unquote(value) {
  const s = String(value);
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
    ? s.slice(1, -1)
    : s;
}

/** True for an INFOPLIST_FILE that apple-targets pointed into targets/. Its
 *  build settings use paths relative to ios/, so "../targets/widget/Info.plist". */
function isTargetsInfoPlist(infoPlistFile) {
  return /^\.\.\/targets\/[^/]+\/Info\.plist$/.test(unquote(infoPlistFile));
}

/**
 * Pure: edits a parsed project (the JSON form of project.pbxproj) in place.
 * Every native target other than the app whose Info.plist lives in targets/
 * gets GENERATE_INFOPLIST_FILE = NO and the given version and build number in
 * every build configuration. Returns what it changed.
 */
function syncExtensionVersions(pbx, { version, buildNumber }) {
  const objects = (pbx && pbx.objects) || {};
  const root = objects[pbx && pbx.rootObject];
  const targetIds = (root && root.targets) || [];
  const changed = [];
  for (const id of targetIds) {
    const target = objects[id];
    if (!target || target.isa !== "PBXNativeTarget") continue;
    if (target.productType === APP_PRODUCT_TYPE) continue;
    const list = objects[target.buildConfigurationList];
    const configs = ((list && list.buildConfigurations) || [])
      .map((cid) => objects[cid])
      .filter((c) => c && c.isa === "XCBuildConfiguration");
    const infoPlistFiles = [
      ...new Set(
        configs
          .map((c) => c.buildSettings && c.buildSettings.INFOPLIST_FILE)
          .filter(Boolean)
          .map(unquote),
      ),
    ];
    if (!infoPlistFiles.some(isTargetsInfoPlist)) continue;
    for (const config of configs) {
      config.buildSettings = config.buildSettings || {};
      config.buildSettings.GENERATE_INFOPLIST_FILE = "NO";
      config.buildSettings.MARKETING_VERSION = String(version);
      config.buildSettings.CURRENT_PROJECT_VERSION = String(buildNumber);
    }
    changed.push({
      uuid: id,
      name: target.name,
      productType: target.productType,
      infoPlistFiles,
      configurations: configs.map((c) => c.name),
    });
  }
  return changed;
}

/**
 * Pure: what is wrong with an extension's own Info.plist once Xcode stops
 * generating it. Returns the problems (empty when it is fine) and warnings.
 */
function checkExtensionInfoPlist(infoPlist, { version, buildNumber }) {
  const problems = [];
  const warnings = [];
  const plist = infoPlist || {};
  for (const key of REQUIRED_KEYS) {
    if (plist[key] === undefined || plist[key] === "") {
      problems.push(`missing ${key}`);
    }
  }
  const ext = plist.NSExtension;
  if (ext && typeof ext === "object" && !ext.NSExtensionPointIdentifier) {
    problems.push("missing NSExtension.NSExtensionPointIdentifier");
  }
  const short = plist.CFBundleShortVersionString;
  if (
    short !== undefined &&
    short !== "$(MARKETING_VERSION)" &&
    String(short) !== String(version)
  ) {
    warnings.push(
      `CFBundleShortVersionString is ${JSON.stringify(short)}, not $(MARKETING_VERSION) or ${version}`,
    );
  }
  const build = plist.CFBundleVersion;
  if (
    build !== undefined &&
    build !== "$(CURRENT_PROJECT_VERSION)" &&
    String(build) !== String(buildNumber)
  ) {
    warnings.push(
      `CFBundleVersion is ${JSON.stringify(build)}, not $(CURRENT_PROJECT_VERSION) or ${buildNumber}`,
    );
  }
  return { problems, warnings };
}

function withExtensionVersions(config) {
  return withFinalizedMod(config, [
    "ios",
    async (config) => {
      if (config.modRequest.introspect) return config;
      const projectRoot = config.modRequest.projectRoot;
      const iosDir = config.modRequest.platformProjectRoot;
      let pbxPath;
      try {
        pbxPath = IOSConfig.Paths.getPBXProjectPath(projectRoot);
      } catch {
        return config;
      }
      const xcodeJson = requireFromAppleTargets("@bacons/xcode/json");
      // Compiled ESM: the API sits on `default` (apple-targets reads it the
      // same way, through __importDefault).
      const plistModule = requireFromAppleTargets("@expo/plist");
      const plist = plistModule.default || plistModule;
      // The same values Expo writes into the app's Info.plist (and the ones
      // EAS then overwrites in both files with the real build number).
      const version = IOSConfig.Version.getVersion(config);
      const buildNumber = IOSConfig.Version.getBuildNumber(config);

      const text = fs.readFileSync(pbxPath, "utf8");
      const pbx = xcodeJson.parse(text);
      const changed = syncExtensionVersions(pbx, { version, buildNumber });
      if (changed.length === 0) return config;

      for (const target of changed) {
        for (const file of target.infoPlistFiles) {
          const abs = path.resolve(iosDir, file);
          if (!fs.existsSync(abs)) {
            throw new Error(
              `[with-extension-versions] ${target.name}: ${file} does not exist. With GENERATE_INFOPLIST_FILE = NO the target needs a complete Info.plist.`,
            );
          }
          const { problems, warnings } = checkExtensionInfoPlist(
            plist.parse(fs.readFileSync(abs, "utf8")),
            { version, buildNumber },
          );
          if (problems.length) {
            throw new Error(
              `[with-extension-versions] ${target.name}: ${file} is not complete (${problems.join(", ")}). Xcode no longer generates it, so it must carry every key itself.`,
            );
          }
          for (const w of warnings) {
            console.warn(`[with-extension-versions] ${target.name}: ${w}`);
          }
        }
      }
      fs.writeFileSync(pbxPath, xcodeJson.build(pbx));
      return config;
    },
  ]);
}

module.exports = withExtensionVersions;
module.exports.syncExtensionVersions = syncExtensionVersions;
module.exports.checkExtensionInfoPlist = checkExtensionInfoPlist;
module.exports.isTargetsInfoPlist = isTargetsInfoPlist;
