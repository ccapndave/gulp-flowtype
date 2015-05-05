"use strict";

var _toConsumableArray = function (arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) arr2[i] = arr[i]; return arr2; } else { return Array.from(arr); } };

var Q = require("q");
var fs = require("fs");
require("babel/polyfill");
var path = require("path");
var gutil = require("gulp-util");
var through = require("through2");
var flowBin = require("flow-bin");
var logSymbols = require("log-symbols");

var _require = require("child_process");

var execFile = _require.execFile;

var flowToJshint = require("flow-to-jshint");
var stylishReporter = require(require("jshint-stylish")).reporter;

/**
 * Flow check initialises a server per folder when run,
 * we can store these paths and kill them later if need be.
 */
var servers = [];
var passed = true;

/**
 * Wrap critical Flow exception into default Error json format
 */
function fatalError(stderr) {
  return {
    errors: [{
      message: [{
        path: "",
        code: 0,
        line: 0,
        start: 0,
        descr: stderr
      }]
    }]
  };
}

function optsToArgs(opts) {
  var args = [];

  if (opts.all) {
    args.push("--all");
  }
  if (opts.weak) {
    args.push("--weak");
  }
  if (opts.declarations) {
    args.push("--lib", opts.declarations);
  }

  return args;
}

function getFlowBin() {
  return process.env.FLOW_BIN || flowBin;
}

function executeFlow(_path, options) {
  var deferred = Q.defer();

  var opts = optsToArgs(options);

  var command = opts.length ? (function () {
    servers.push(path.dirname(_path));
    return "check";
  })() : "status";

  var args = [command].concat(_toConsumableArray(opts), ["/" + path.relative("/", _path), "--json"]);

  execFile(getFlowBin(), args, function (err, stdout, stderr) {
    if (stderr && /server launched/.test(stderr)) {
      /**
       * When flow starts a server it gives us an stderr
       * saying the server is starting.
       */
      stderr = null;
    }

    var parsed = !stderr ? JSON.parse(stdout) : fatalError(stderr);
    var result = {};
    result.errors = parsed.errors.filter(function (error) {
      error.message = error.message.filter(function (message, index) {
        var isCurrentFile = message.path === _path;
        var result = false;
        /**
         * If FlowType traces an issue to a method inside a file that is not
         * the one being piped through, it adds a new element to the list
         * of errors with a different file path to the current one. To detect
         * whether this error is related to the current file we check the
         * previous and next error to see if it ends with `found`, `in` or
         * `with`, From this we can tell if the error should be shown or not.
         */
        var lineEnding = /(with|found|in)$/;

        var previous = error.message[index - 1];
        if (previous && lineEnding.test(previous.descr)) {
          result = previous.path === _path;
        }

        var nextMessage = error.message[index + 1];
        if (nextMessage && lineEnding.test(message.descr)) {
          result = nextMessage.path === _path;
        }

        var generalError = /(Fatal)/.test(message.descr);
        return isCurrentFile || result || generalError;
      });
      return error.message.length > 0;
    });

    if (result.errors.length) {
      passed = false;

      // Allow a custom reporter to be passed into the options, otherwise default
      // to jshint-stylish reporter
      var reporter = typeof options.reporter === "undefined" ? stylishReporter : options.reporter.reporter;

      reporter(flowToJshint(result));

      if (options.abort) {
        deferred.reject(new gutil.PluginError("gulp-flow", "Flow failed"));
      } else {
        deferred.resolve();
      }
    } else {
      deferred.resolve();
    }
  });
  return deferred.promise;
}

function checkFlowConfigExist() {
  var deferred = Q.defer();
  var config = path.join(process.cwd(), ".flowconfig");
  fs.exists(config, function (exists) {
    if (exists) {
      deferred.resolve();
    } else {
      deferred.reject("Missing .flowconfig in the current working directory.");
    }
  });
  return deferred.promise;
}

function hasJsxPragma(contents) {
  return /@flow\b/ig.test(contents);
}

function isFileSuitable(file) {
  var deferred = Q.defer();
  if (file.isNull()) {
    deferred.reject();
  } else if (file.isStream()) {
    deferred.reject(new gutil.PluginError("gulp-flow", "Stream content is not supported"));
  } else if (file.isBuffer()) {
    deferred.resolve();
  } else {
    deferred.reject();
  }
  return deferred.promise;
}

function killServers() {
  var defers = servers.map(function (_path) {
    var deferred = Q.defer();
    execFile(getFlowBin(), ["stop"], {
      cwd: _path
    }, deferred.resolve);
    return deferred;
  });
  return Q.all(defers);
}

module.exports = function () {
  var options = arguments[0] === undefined ? {} : arguments[0];

  options.beep = typeof options.beep !== "undefined" ? options.beep : true;

  function Flow(file, enc, callback) {
    var _this = this;

    var _continue = function () {
      _this.push(file);
      callback();
    };

    isFileSuitable(file).then(function () {
      var hasPragma = hasJsxPragma(file.contents.toString());
      if (options.all || hasPragma) {
        checkFlowConfigExist().then(function () {
          executeFlow(file.path, options).then(_continue, function (err) {
            _this.emit("error", err);
            callback();
          });
        }, function (msg) {
          console.log(logSymbols.warning + " " + msg);
          _continue();
        });
      } else {
        _continue();
      }
    }, function (err) {
      if (err) {
        _this.emit("error", err);
      }
      callback();
    });
  }

  return through.obj(Flow, function () {
    var _this = this;

    var end = function () {
      _this.emit("end");
      passed = true;
    };

    if (passed) {
      console.log(logSymbols.success + " Flow has found 0 errors");
    } else if (options.beep) {
      gutil.beep();
    }

    if (options.killFlow) {
      if (servers.length) {
        killServers().done(end);
      } else {
        end();
      }
    } else {
      end();
    }
  });
};
/* @flow weak */