// Settings persisted in the phone's localStorage.
//
// {
//   dests: [{name, label, lat, lon}],   // up to 5
//   origin: null | {label, lat, lon},  // null = use GPS
//   busOnly: true,
//   maxTransfers: 1,                    // -1 = any
//   maxWalk: 15                         // minutes, to/from stops
// }

var KEY = 'settings';
var LOCATION_KEY = 'lastLocation';

var DEFAULTS = {
  dests: [],
  origin: null,
  busOnly: true,
  maxTransfers: 1,
  maxWalk: 15
};

function validPlace(p) {
  return p && typeof p.lat === 'number' && typeof p.lon === 'number' && isFinite(p.lat) && isFinite(p.lon);
}

function normalize(s) {
  var out = {};
  Object.keys(DEFAULTS).forEach(function(k) {
    out[k] = s && s[k] !== undefined ? s[k] : DEFAULTS[k];
  });
  out.dests = (out.dests || []).filter(validPlace).slice(0, 5).map(function(d) {
    return {name: String(d.name || d.label || 'Destination'), label: String(d.label || ''), lat: d.lat, lon: d.lon};
  });
  out.origin = validPlace(out.origin) ? out.origin : null;
  out.busOnly = !!out.busOnly;
  out.maxTransfers = parseInt(out.maxTransfers, 10);
  if (isNaN(out.maxTransfers)) {
    out.maxTransfers = DEFAULTS.maxTransfers;
  }
  out.maxWalk = Math.max(1, Math.min(30, parseInt(out.maxWalk, 10) || DEFAULTS.maxWalk));
  return out;
}

exports.load = function() {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch (e) {
    return normalize(null);
  }
};

exports.save = function(s) {
  var clean = normalize(s);
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
};

exports.lastLocation = function() {
  try {
    return JSON.parse(localStorage.getItem(LOCATION_KEY) || 'null');
  } catch (e) {
    return null;
  }
};

exports.saveLocation = function(loc) {
  localStorage.setItem(LOCATION_KEY, JSON.stringify(loc));
};
