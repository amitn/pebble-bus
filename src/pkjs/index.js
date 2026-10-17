var settings = require('./settings');
var transit = require('./transit');
var tfl = require('./tfl');
var mapdata = require('./mapdata');
var text = require('./text');
var queue = require('./queue');
var configPage = require('./config_page');

var NAME_BYTES = 90;   // matches NAME_LEN on the watch, minus the terminator
var DEST_BYTES = 38;

var lastResults = null;   // {dest, origin, items}
var fetchSeq = 0;
var mapSeq = 0;

function destNames() {
  return settings.load().dests.map(function(d) {
    return text.forWatch(d.name.replace(/\n/g, ' '), DEST_BYTES);
  }).join('\n');
}

function sendDestNames(extra) {
  var msg = extra || {};
  msg.DestNames = destNames();
  queue.send(msg);
}

function sendStatus(dest, status) {
  queue.send({DestIndex: dest, Status: status});
}

// ---- Location --------------------------------------------------------------

function getOrigin(s, cb) {
  if (s.origin) {
    return cb(null, {lat: s.origin.lat, lon: s.origin.lon});
  }
  navigator.geolocation.getCurrentPosition(function(pos) {
    var loc = {lat: pos.coords.latitude, lon: pos.coords.longitude, time: Date.now()};
    settings.saveLocation(loc);
    cb(null, loc);
  }, function(err) {
    console.log('Location error: ' + (err && err.message));
    var last = settings.lastLocation();
    if (last && Date.now() - last.time < 10 * 60 * 1000) {
      return cb(null, last);
    }
    cb('Can\'t get your location');
  }, {enableHighAccuracy: true, timeout: 15000, maximumAge: 30000});
}

// ---- Departures -----------------------------------------------------------

function itemMessage(dest, index, d) {
  return {
    DestIndex: dest,
    ItemIndex: index,
    Line: text.truncate(d.line, 10),
    Stop: text.forWatch(d.stop, NAME_BYTES),
    Headsign: text.forWatch(d.headsign, NAME_BYTES),
    DepTime: d.dep,
    LeaveTime: d.leave,
    ArrTime: d.arr,
    Delay: Math.max(-32000, Math.min(32000, d.delay)),
    WalkMin: Math.min(255, d.walkMin),
    WalkDist: Math.min(65535, d.walkDist),
    Transfers: Math.min(255, d.transfers),
    RealTime: d.realtime ? 1 : 0,
    Color: d.color
  };
}

function fetchDepartures(destIndex) {
  var s = settings.load();
  var dest = s.dests[destIndex];
  if (!dest) {
    return sendStatus(destIndex, 'This destination was removed. Go back and pick another.');
  }
  var seq = ++fetchSeq;
  if (!s.origin) {
    sendStatus(destIndex, 'Finding you…');
  }
  getOrigin(s, function(err, origin) {
    if (seq !== fetchSeq) {
      return;
    }
    if (err) {
      return sendStatus(destIndex, err);
    }
    sendStatus(destIndex, 'Finding buses…');
    transit.plan(origin, dest, s, function(err, items) {
      if (seq !== fetchSeq) {
        return;
      }
      if (err) {
        return sendStatus(destIndex, err);
      }
      tfl.applyLive(items, function(items) {
        if (seq === fetchSeq) {
          sendDepartures(destIndex, origin, items);
        }
      });
    });
  });
}

function sendDepartures(destIndex, origin, items) {
  var now = Date.now() / 1000;
  items = items.filter(function(d) { return d.dep >= now - 60; });
  lastResults = {dest: destIndex, origin: origin, items: items};
  if (!items.length) {
    return queue.send({DestIndex: destIndex, ResultsBegin: 0,
                       Status: 'No buses found in the next 2 hours'});
  }
  queue.send({DestIndex: destIndex, ResultsBegin: items.length});
  items.forEach(function(d, i) {
    queue.send(itemMessage(destIndex, i, d));
  });
}

// ---- Map --------------------------------------------------------------------

function sendMap(index) {
  queue.drop('map');
  var seq = ++mapSeq;
  var dep = lastResults && lastResults.items[index];
  if (!dep) {
    queue.send({MapBegin: index, MapUserX: 0, MapUserY: 0, MapScale: 20}, 'map');
    queue.send({MapEnd: index, MapStatus: 'Refresh the list and try again'}, 'map');
    return;
  }
  var m = mapdata.prepare(dep, lastResults.origin);
  queue.send({MapBegin: index, MapUserX: m.user.x, MapUserY: m.user.y, MapScale: m.scale10}, 'map');
  mapdata.encode(m.base).forEach(function(chunk) {
    queue.send({MapData: chunk}, 'map');
  });
  mapdata.fetchRoads(m, function(err, lines) {
    if (seq !== mapSeq) {
      return;
    }
    if (err) {
      console.log('Street map error: ' + err);
    } else {
      mapdata.encode(lines).forEach(function(chunk) {
        queue.send({MapData: chunk}, 'map');
      });
    }
    queue.send({MapEnd: index, MapStatus: err ? 'Streets unavailable' : ''}, 'map');
  });
}

// ---- Events -----------------------------------------------------------------

Pebble.addEventListener('ready', function() {
  sendDestNames({Ready: 1});
});

Pebble.addEventListener('appmessage', function(e) {
  var p = e.payload;
  if (p.Fetch !== undefined) {
    fetchDepartures(p.Fetch);
  }
  if (p.MapRequest !== undefined) {
    sendMap(p.MapRequest);
  }
});

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL(configPage.url(settings.load(), settings.lastLocation()));
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) {
    return;
  }
  var raw = e.response;
  try {
    var parsed = JSON.parse(raw.charAt(0) === '{' ? raw : decodeURIComponent(raw));
    settings.save(parsed);
    lastResults = null;
    sendDestNames();
  } catch (err) {
    console.log('Bad settings response: ' + err);
  }
});
