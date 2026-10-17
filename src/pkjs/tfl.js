// Live London bus predictions from the TfL Unified API (no key needed for
// light use). Transitous only has London timetables; this swaps in TfL's
// countdown times for buses boarding at TfL stops.

var http = require('./http');

var API = 'https://api.tfl.gov.uk/StopPoint/';
// Transitous stop ids end in the NaPTAN code, which is TfL's StopPoint id,
// e.g. "gb-great-britain_490000093PB". London bus stops start with 490.
var NAPTAN = /_(490[0-9A-Z]{4,})$/;
// How far a prediction may be from the timetable and still be "that" bus.
var EARLY = 10 * 60;
var LATE = 20 * 60;

function naptanId(d) {
  var m = NAPTAN.exec(d.stopId || '');
  return m ? m[1] : null;
}

function seconds(iso) {
  return Math.round(Date.parse(iso) / 1000);
}

function fetchArrivals(ids, cb) {
  var byStop = {};
  var pending = ids.length;
  if (!pending) {
    return cb(byStop);
  }
  ids.forEach(function(id) {
    http.getJSON(API + id + '/Arrivals', 8000, function(err, data) {
      if (err) {
        console.log('TfL arrivals failed for ' + id + ': ' + err);
      } else if (data && data.length !== undefined) {
        byStop[id] = data;
      }
      if (--pending === 0) {
        cb(byStop);
      }
    });
  });
}

// Updates departures in place with live times where TfL has a prediction,
// then calls cb(items) re-sorted. Never fails: on errors the timetable stays.
exports.applyLive = function(items, cb) {
  var ids = [];
  items.forEach(function(d) {
    var id = naptanId(d);
    if (id && ids.indexOf(id) < 0) {
      ids.push(id);
    }
  });
  if (!ids.length) {
    return cb(items);
  }
  fetchArrivals(ids, function(byStop) {
    var used = {};
    items.forEach(function(d) {
      var arrivals = byStop[naptanId(d)];
      if (!arrivals) {
        return;
      }
      var line = String(d.line).toUpperCase();
      var scheduled = d.dep - d.delay;
      var best = null, bestDiff = Infinity;
      arrivals.forEach(function(a) {
        if (String(a.lineName).toUpperCase() !== line || used[a.id]) {
          return;
        }
        var t = seconds(a.expectedArrival);
        var diff = t - scheduled;
        if (diff >= -EARLY && diff <= LATE && Math.abs(diff) < bestDiff) {
          best = a;
          bestDiff = Math.abs(diff);
        }
      });
      if (best) {
        used[best.id] = true;
        var shift = seconds(best.expectedArrival) - d.dep;
        d.dep += shift;
        d.leave += shift;
        d.arr += shift;
        d.delay = d.dep - scheduled;
        d.realtime = true;
      }
      // London stops are signed by letter on the stop flag ("J", "PB"). Put it
      // first so it survives truncation on the watch.
      var letter = arrivals.length && arrivals[0].platformName;
      if (letter && /^[A-Z0-9]{1,3}$/.test(letter) && d.stop.indexOf('Stop ') !== 0) {
        d.stop = 'Stop ' + letter + ' \u00b7 ' + d.stop;
      }
    });
    items.sort(function(a, b) { return a.dep - b.dep || a.arr - b.arr; });
    cb(items);
  });
};
