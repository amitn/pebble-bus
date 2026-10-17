// Trip planning via Transitous (https://transitous.org), a free, community
// run MOTIS instance with worldwide GTFS coverage. No API key needed.

var http = require('./http');

var API = 'https://api.transitous.org/api/v5/plan';
var MAX_RESULTS = 8;

// Pebble palette colors for lines that don't publish a route color.
var PALETTE = [0x0055AA, 0x00AA55, 0xAA5500, 0x5500AA, 0xAA0000, 0x005555, 0xAA00AA, 0x555500];

function seconds(iso) {
  return Math.round(Date.parse(iso) / 1000);
}

function lineColor(leg, line) {
  if (leg.routeColor && /^[0-9a-fA-F]{6}$/.test(leg.routeColor)) {
    return parseInt(leg.routeColor, 16);
  }
  var h = 0;
  for (var i = 0; i < line.length; i++) {
    h = (h * 31 + line.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

var STREET_MODES = ['WALK', 'BIKE', 'RENTAL', 'CAR', 'HGV', 'CAR_PARKING', 'CAR_DROPOFF',
                    'ODM', 'RIDE_SHARING', 'FLEX'];

function isStreetMode(mode) {
  return STREET_MODES.indexOf(mode) >= 0;
}

// Turn one MOTIS itinerary into a departure, keyed by its first transit leg.
function toDeparture(it) {
  var legs = it.legs || [];
  var first = -1;
  for (var i = 0; i < legs.length; i++) {
    if (!isStreetMode(legs[i].mode)) {
      first = i;
      break;
    }
  }
  if (first < 0) {
    return null;
  }
  var leg = legs[first];
  var walkSecs = 0, walkDist = 0;
  for (i = 0; i < first; i++) {
    walkSecs += legs[i].duration || 0;
    walkDist += legs[i].distance || 0;
  }
  var line = leg.routeShortName || leg.displayName || leg.tripShortName || leg.routeLongName || leg.mode;
  var dep = seconds(leg.startTime);
  var scheduled = leg.scheduledStartTime ? seconds(leg.scheduledStartTime) : dep;
  return {
    key: leg.tripId || (line + '@' + dep),
    line: line,
    headsign: leg.headsign || (leg.to && leg.to.name) || '',
    stop: leg.from.name,
    stopId: leg.from.stopId || '',
    stopLat: leg.from.lat,
    stopLon: leg.from.lon,
    dep: dep,
    leave: seconds(it.startTime),
    arr: seconds(it.endTime),
    delay: dep - scheduled,
    realtime: !!leg.realTime,
    walkMin: Math.ceil(walkSecs / 60),
    walkDist: Math.round(walkDist),
    transfers: it.transfers || 0,
    color: lineColor(leg, line),
    // kept on the phone for drawing the map
    preLegs: legs.slice(0, first),
    leg: leg
  };
}

exports.plan = function(origin, dest, s, cb) {
  var params = {
    fromPlace: origin.lat.toFixed(6) + ',' + origin.lon.toFixed(6),
    toPlace: dest.lat.toFixed(6) + ',' + dest.lon.toFixed(6),
    time: new Date().toISOString(),
    numItineraries: 10,
    searchWindow: 7200,
    transitModes: s.busOnly ? 'BUS,COACH' : 'TRANSIT',
    maxPreTransitTime: s.maxWalk * 60,
    maxPostTransitTime: s.maxWalk * 60,
    detailedTransfers: 'false'
  };
  if (s.maxTransfers >= 0) {
    params.maxTransfers = s.maxTransfers;
  }
  var query = Object.keys(params).map(function(k) {
    return k + '=' + encodeURIComponent(params[k]);
  }).join('&');

  http.getJSON(API + '?' + query, 25000, function(err, data) {
    if (err) {
      return cb(err);
    }
    var now = Date.now() / 1000;
    var byKey = {};
    (data.itineraries || []).forEach(function(it) {
      var d = toDeparture(it);
      if (!d || d.dep < now - 60) {
        return;
      }
      // Several itineraries can share the same first bus; keep the fastest.
      var prev = byKey[d.key];
      if (!prev || d.arr < prev.arr) {
        byKey[d.key] = d;
      }
    });
    var list = Object.keys(byKey).map(function(k) { return byKey[k]; });
    list.sort(function(a, b) { return a.dep - b.dep || a.arr - b.arr; });
    cb(null, list.slice(0, MAX_RESULTS));
  });
};
