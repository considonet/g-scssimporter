const imports = {
  "path": require("path"),
  "fs": require("fs"),
  "getInstalledPathSync": require("get-installed-path").getInstalledPathSync,
  "Logger": require("@considonet/g-logger"),
  "mkdirp": require("mkdirp"),
  "rimraf": require("rimraf")
};

class ScssImporter {

  constructor(logVerbosity = 1) {

    this.logger = new imports.Logger("scss-importer", logVerbosity);

    this.scssPrefixes = ["", "_"];
    this.scssExtensions = [".scss", ".css", ""];
    this.scssIndexFileNames = ["index"];

    // Temp dir is required to put pre-compiled JSON files. Thanks to them, dart-sass doesn't crash with source maps
    this.tmpDir = imports.path.join(process.cwd(), "./node_modules/.tmp/scss-importer");
    imports.rimraf.sync(this.tmpDir);
    imports.mkdirp.sync(this.tmpDir);

  }

  normalizePath(path) {
    try {
      path = fs.realpathSync(path).replace(/[\\\/]+/g, '/');
    } catch (e) {
      path = path.replace(/[\\\/]+/g, '/');
    }
    return path;
  };

  rawFileExists(fPath) {

    try {

      return imports.fs.lstatSync(fPath).isFile();

    } catch (e) {

      if (e.code !== 'ENOENT') {
        this.logger.log(e.message, 2);
      }

    }

    return false;

  };

  getRawFilePathIfExists(fPath, fileName) {

    let ret = false;

    if(fileName.indexOf("/")!==-1) {
      const tmp = fileName.split("/");
      const fn = tmp.pop();
      fPath = imports.path.join(fPath, tmp.join("/"));
      fileName = fn;
    }

    this.scssPrefixes.some(prefix => {
      this.scssExtensions.some(ext => {
        const p = imports.path.join(fPath, `${prefix}${fileName}${ext}`);

        if(this.rawFileExists(p)) {
          ret = p;
          return true;
        }
      });

      if(ret!==false) {
        return true;
      }

    });

    return ret;

  };

  getClassicImportPath(cDir, fileName) {

    let proposal = '';
    let outPath = null;

    // Primary choice: Trying the real file first
    proposal = this.getRawFilePathIfExists(cDir, fileName);
    if(proposal!==false) {
      outPath = proposal;
    }

    // Fallback: Trying the index or _index.scss default
    if(outPath===null) {
      const altPath = imports.path.join(cDir, fileName);
      this.scssIndexFileNames.some(fName => {
        proposal = this.getRawFilePathIfExists(altPath, fName);
        this.logger.log(`Looking for ${fileName} -> ${fName} in ${altPath}`, 3);
        if(proposal!==false) {
          return true;
        }
      });
      if(proposal!==false) {
        outPath = proposal;
      }
    }

    return outPath;

  };

  transformJsonToScss(json) {

    return Object.keys(json)
      .filter(key => this.isValidScssKey(key))
      .filter(key => json[key] !== '#')
      .map(key => `$${key}: ${this.parseScssValue(json[key])};`)
      .join('\n');

  }

  isValidScssKey(key) {
    return /^[^$@:].*/.test(key)
  }

  parseScssValue(value) {
    if (Array.isArray(value)) {
      return this.parseScssList(value);
    } else if (typeof value === "object") {
      return this.parseScssMap(value);
    } else if (value === "") {
      return '""'; // Return explicitly an empty string (Sass would otherwise throw an error as the variable is set to nothing)
    } else {
      return value;
    }
  }

  parseScssList(list) {
    return `(${list
      .map(value => this.parseScssValue(value))
      .join(',')})`;
  }

  parseScssMap(map) {
    return `(${Object.keys(map)
      .filter(key => this.isValidScssKey(key))
      .map(key => `${key}: ${this.parseScssValue(map[key])}`)
      .join(',')})`;
  }

  importerCallback(fileName, prev, done) {

    const cDir = this.normalizePath(prev.split("/").slice(0, -1).join("/"));

    let outPath = null;

    this.logger.log(`Trying to resolve ${fileName}`, 3);

    if(fileName.substr(0, 1)==="~") { // We are doing a lookup for an npm package

      const pathSplit = fileName.split("/");
      let importPath = "";
      let packageName = null;
      let packageLocation = null;

      if(fileName.substr(1, 1)==="@") { // Scoped package

        packageName = `${pathSplit[0]}/${pathSplit[1]}`.substr(1);
        importPath = pathSplit.slice(2).join("/");

      } else { // Regular package

        packageName = pathSplit[0].substr(1);
        importPath = pathSplit.slice(1).join("/");

      }

      // Locating the package
      try {
        packageLocation = imports.getInstalledPathSync(packageName, { local: true });
      } catch (e) {
      }

      // Building the possible included file list
      if(packageLocation!==null) {

        const pathsToTry = [];

        if(importPath==="") { // No file specified, looking for defaults

          const pjson = require(imports.path.join(packageLocation, "package.json"));

          // package.json main
          if(typeof pjson.main !== "undefined") {
            pathsToTry.push(pjson.main);
          }

          // package.json style
          if(typeof pjson.style !== "undefined") {
            pathsToTry.push(pjson.style);
          }

          // package.json sass
          if(typeof pjson.sass !== "undefined") {
            pathsToTry.push(pjson.sass);
          }

          // Eyeglass module support
          if(typeof pjson.eyeglass !== "undefined" && typeof pjson.eyeglass.sassDir !== "undefined") {
            pathsToTry.push(pjson.eyeglass.sassDir);
          }

          // Empty path for SCSS index inclusion
          pathsToTry.push("");

        } else { // Path explicitly specified in the source SCSS

          pathsToTry.push(importPath);

        }

        // Doing the classic import (so index files are also supported)
        pathsToTry.some(possiblePath => {

          if(possiblePath.match(/(\.scss|\.css)$/) || !possiblePath.match(/(\.js|\.ts|\.es6)$/)) {

            const proposal = this.getClassicImportPath(packageLocation, possiblePath);
            if(proposal!==false) {
              outPath = proposal;
              return true;
            }

          }

        });

      }

    } else { // Classic import

      outPath = this.getClassicImportPath(cDir, fileName);

    }

    // Returning
    if(outPath==null) { // File not resolved, defaulting to node-sass

      this.logger.log(`Not found, defaulting to node-sass`, 3);
      done(null);

    } else if(outPath.match(/\.scss$/)) { // SCSS file resolved

      this.logger.log(`Resolved to SCSS file: ${outPath}`, 3);
      done({ file: outPath });

    } else if(outPath.match(/\.js(on)?$/)) { // JS/JSON file resolved

      this.logger.log(`Resolved to JS file: ${outPath}`, 3);
      delete require.cache[require.resolve(outPath)];

      const vars = require(outPath);
      const contents = this.transformJsonToScss(vars);

      // We save pre-compiled JSONs for dart-sass source maps; otherwise it crashes
      const fakePath = imports.path.join(this.tmpDir, "./", outPath.replace(/[^A-Za-z0-9]/g, "_")+".scss");
      imports.fs.writeFileSync(fakePath, contents);
      done({ file: fakePath, contents });

    } else { // Other file resolved, returning the static contents

      this.logger.log(`Resolved to external file: ${outPath}`, 3);
      done({ file: outPath, contents: imports.fs.readFileSync(outPath, "utf8") });

    }

  }

}

module.exports = ScssImporter;
