/* jshint browser: true */
/* global console, Pebble, Data */
/* exported main */

function main(c) {

  var data = Data(c);
  var config;

  function mergeConfig(config, defaults) {
    var out = {};
    Object.keys(defaults).forEach(function(key) {
      out[key] = defaults[key];
    });
    Object.keys(config).forEach(function(key) {
      out[key] = config[key];
    });
    return out;
  }

  function sgvDataError(e) {
    console.log(e);
    sendMessage({msgType: c.MSG_TYPE_ERROR});
  }

  function graphArray(sgvs) {
    var endTime = sgvs.length > 0 ? sgvs[0]['date'] : new Date();
    var noEntry = {
      'date': Infinity,
      'sgv': 0
    };
    var i;

    var graphed = [];
    var xs = [];
    for(i = 0; i <= c.SGV_FETCH_SECONDS; i += c.INTERVAL_SIZE_SECONDS) {
      graphed.push(noEntry);
      xs.push(endTime - i);
    }

    for(i = 0; i < sgvs.length; i++) {
      var min = Infinity;
      var xi;
      // Don't graph missing sgvs or error codes
      if(sgvs[i]['sgv'] === undefined || sgvs[i]['sgv'] <= c.DEXCOM_ERROR_CODE_MAX) {
        continue;
      }
      // Find the x value closest to this sgv's date
      for(var j = 0; j < xs.length; j++) {
        if(Math.abs(sgvs[i]['date'] - xs[j]) < min) {
          min = Math.abs(sgvs[i]['date'] - xs[j]);
          xi = j;
        }
      }
      // Assign it if it's the closest sgv to that x
      if(min < c.INTERVAL_SIZE_SECONDS && Math.abs(sgvs[i]['date'] - xs[xi]) < Math.abs(graphed[xi]['date'] - xs[xi])) {
        graphed[xi] = sgvs[i];
      }
    }

    var ys = graphed.map(function(entry) { return entry['sgv']; });

    return ys;
  }

  function lastSgv(sgvs) {
    return sgvs.length > 0 ? parseInt(sgvs[0]['sgv'], 10) : 0;
  }

  function directionToTrend(direction) {
    return {
      'NONE': 0,
      'DoubleUp': 1,
      'SingleUp': 2,
      'FortyFiveUp': 3,
      'Flat': 4,
      'FortyFiveDown': 5,
      'SingleDown': 6,
      'DoubleDown': 7,
      'NOT COMPUTABLE': 8,
      'RATE OUT OF RANGE': 9,
    }[direction] || 0;
  }

  function lastTrendNumber(sgvs) {
    if (sgvs.length === 0) {
      return 0;
    }

    var trend = sgvs[0]['trend'];
    if (!isNaN(parseInt(trend)) && trend >= 0 && trend <= 9) {
      return trend;
    } else if (sgvs[0]['direction'] !== undefined) {
      return directionToTrend(sgvs[0]['direction']);
    } else {
      return 0;
    }
  }

  function lastDelta(ys) {
    if (ys[1] === 0) {
      return c.NO_DELTA_VALUE;
    } else {
      return ys[0] - ys[1];
    }
  }

  function recency(sgvs) {
    if (sgvs.length === 0) {
      // TODO
      return 999 * 60 * 60;
    } else {
      var seconds = Date.now() / 1000 - sgvs[0]['date'];
      return Math.floor(seconds);
    }
  }

  function sendMessage(data) {
    console.log('sending ' + JSON.stringify(data));
    Pebble.sendAppMessage(data);
  }

  function requestAndSendBGs() {
    function onData(rawSGVs, statusText) {
      try {
        sgvs = rawSGVs.map(function(e) {
          return {
            date: e['date'] / 1000,
            sgv: e['sgv'],
            trend: e['trend'],
            direction: e['direction'],
          };
        });
        var ys = graphArray(sgvs);
        sendMessage({
          msgType: c.MSG_TYPE_DATA,
          recency: recency(sgvs),
          sgvCount: ys.length,
          // XXX: divide BG by 2 to fit into 1 byte
          sgvs: ys.map(function(y) { return Math.min(255, Math.floor(y / 2)); }),
          lastSgv: lastSgv(sgvs),
          trend: lastTrendNumber(sgvs),
          delta: lastDelta(ys),
          statusText: statusText,
        });
      } catch (e) {
        sgvDataError(e);
      }
    }

    // recover from status text errors, but not sgv errors
    var sgvs = data.getSGVsDateDescending(config);
    var statusText = data.getStatusText(config).catch(function(e) {
      console.log(e);
      return '-';
    });

    Promise.all([sgvs, statusText])
      .then(function(results) {
        onData(results[0], results[1]);
      })
      .catch(sgvDataError);
  }

  function getLayout(config) {
    return config.layout === 'custom' ? config.customLayout : c.LAYOUTS[config.layout];
  }

  function countElementsForPebble(layout) {
    return layout.elements.filter(function(elementConfig) {
      return elementConfig['enabled'];
    }).length;
  }

  function encodeElementsForPebble(layout) {
    var out = [];
    layout.elements.forEach(function(elementConfig) {
      if (elementConfig['enabled']) {
        out = out.concat(c.PROPERTIES.map(function(prop) {
          if (typeof elementConfig[prop] === 'boolean') {
            return elementConfig[prop] ? 1 : 0;
          } else {
            return elementConfig[prop];
          }
        }));
      }
    });
    return out;
  }

  function sendPreferences() {
    sendMessage({
      msgType: c.MSG_TYPE_PREFERENCES,
      mmol: config.mmol ? 1 : 0,
      topOfGraph: config.topOfGraph,
      topOfRange: config.topOfRange,
      bottomOfRange: config.bottomOfRange,
      bottomOfGraph: config.bottomOfGraph,
      hGridlines: config.hGridlines,
      batteryAsNumber: config.batteryAsNumber ? 1 : 0,
      timeAlign: c.ALIGN[getLayout(config).timeAlign],
      batteryLoc: c.BATTERY_LOC[getLayout(config).batteryLoc],
      numElements: countElementsForPebble(getLayout(config)),
      elements: encodeElementsForPebble(getLayout(config)),
    });
  }

  Pebble.addEventListener('ready', function() {
    config = mergeConfig({}, c.DEFAULT_CONFIG);

    var configStr = localStorage.getItem(c.LOCAL_STORAGE_KEY_CONFIG);
    if (configStr !== null) {
      try {
        config = mergeConfig(JSON.parse(configStr), c.DEFAULT_CONFIG);
      } catch (e) {
        console.log('Bad config from localStorage: ' + configStr);
      }
    }

    Pebble.addEventListener('showConfiguration', function() {
      var platform = 'unknown';
      var firmware = '0.0.0';
      if (Pebble.getActiveWatchInfo) {
        platform = Pebble.getActiveWatchInfo()['platform'];
        firmware = ['major', 'minor', 'patch'].map(function(part) {
          return Pebble.getActiveWatchInfo()['firmware'][part];
        }).join('.');
        if (Pebble.getActiveWatchInfo()['firmware']['suffix']) {
          firmware += '.' + Pebble.getActiveWatchInfo()['firmware']['suffix'];
        }
      }
      var query = [
        ['version', c.VERSION],
        ['pf', platform],
        ['fw', firmware],
        ['at', Pebble.getAccountToken()],
        ['wt', Pebble.getWatchToken()],
        ['current', encodeURIComponent(JSON.stringify(config))],
      ].map(function(pair) {
        return pair.join('=');
      }).join('&');
      Pebble.openURL(c.CONFIG_URL + '?' + query);
    });

    Pebble.addEventListener('webviewclosed', function(event) {
      var configStr = decodeURIComponent(event.response);
      var newConfig;
      try {
        newConfig = JSON.parse(configStr);
      } catch (e) {
        console.log(e);
        console.log('Bad config from webview: ' + configStr);
      }

      if (newConfig) {
        if (newConfig.nightscout_url !== config.nightscout_url) {
          data.clearCache();
        }
        config = mergeConfig(newConfig, c.DEFAULT_CONFIG);
        localStorage.setItem(c.LOCAL_STORAGE_KEY_CONFIG, JSON.stringify(config));
        console.log('Preferences updated: ' + JSON.stringify(config));
        sendPreferences();
        requestAndSendBGs();
      }
    });

    Pebble.addEventListener('appmessage', function() {
      requestAndSendBGs();
    });

    // Send data immediately after the watchface is launched
    requestAndSendBGs();
  });

}
