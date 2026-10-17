// Builds the station map: streets around the stop (OpenStreetMap vector
// tiles from OpenFreeMap), the walking path and the bus route, all projected
// to meters relative to the stop and packed into byte arrays for the watch.
//
// Watch format per polyline: [kind:u8][count:u8][count x (x:i16le, y:i16le)]

var geo = require('./geo');
var http = require('./http');
var vectortile = require('./vectortile');

var TILEJSON = 'https://tiles.openfreemap.org/planet';
var TILEJSON_KEY = 'tileTemplate';
var TILE_ZOOM = 14;  // most detailed zoom in the OpenMapTiles schema
var CACHE_PREFIX = 'roads:';
var CACHE_INDEX = 'roadsIndex';
var CACHE_ENTRIES = 8;
var CACHE_MAX_AGE = 30 * 24 * 3600 * 1000;
var KIND = {MINOR: 0, MAJOR: 1, ROUTE: 2, WALK: 3};
var MAJOR = /^(motorway|trunk|primary|secondary|tertiary)$/;
var MINOR = /^(minor|busway)$/;
var MAX_POINTS = 3000;      // ~12KB on the watch
var CHUNK_BYTES = 1800;     // per AppMessage
var VIEW_W = 160, VIEW_H = 96;  // usable map area on the watch, minus padding

function decodeLeg(leg, proj) {
  var g = leg && leg.legGeometry;
  if (!g || !g.points) {
    return [];
  }
  return geo.decodePolyline(g.points, g.precision).map(function(p) {
    return proj.toXY(p.lat, p.lon);
  });
}

// Everything we can compute without network access.
exports.prepare = function(dep, origin) {
  var stop = {lat: dep.stopLat, lon: dep.stopLon};
  var proj = geo.projection(stop);
  var user = proj.toXY(origin.lat, origin.lon);
  var dist = geo.distance(user, {x: 0, y: 0});

  var walk = [];
  dep.preLegs.forEach(function(leg) {
    walk = walk.concat(decodeLeg(leg, proj));
  });

  // Fit the stop, you and the walking path into view.
  var near = dist < 2500;
  var fit = (near ? [user] : []).concat(walk.length && near ? walk : []);
  var minX = 0, maxX = 0, minY = 0, maxY = 0;
  fit.forEach(function(p) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });
  var spanX = maxX - minX, spanY = maxY - minY;
  var mpp = Math.max(spanX / VIEW_W, spanY / VIEW_H, near ? 0.6 : 1.5);
  // Streets are fetched around the stop (not around you) in 100 m steps, so
  // the same stop on your daily commute hits the cache.
  var reach = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY));
  var radius = Math.max(400, Math.min(800, Math.ceil((reach + 200) / 100) * 100));
  var box = {x0: -radius * 1.2, x1: radius * 1.2, y0: -radius * 1.2, y1: radius * 1.2};

  var base = [];
  geo.clipPolyline(decodeLeg(dep.leg, proj), box).forEach(function(pts) {
    base.push({kind: KIND.ROUTE, points: geo.simplify(pts, 1.5)});
  });
  if (walk.length >= 2) {
    base.push({kind: KIND.WALK, points: geo.simplify(walk, 1)});
  }

  return {
    proj: proj,
    stop: stop,
    user: {x: Math.round(user.x), y: Math.round(user.y)},
    scale10: Math.ceil(mpp * 10),
    tolerance: Math.max(1, radius / 350),
    radius: radius,
    box: box,
    base: base
  };
};

// The tile URL contains a dataset version, so look it up (daily) via TileJSON.
function tileTemplate(cb) {
  try {
    var cached = JSON.parse(localStorage.getItem(TILEJSON_KEY) || 'null');
    if (cached && Date.now() - cached.time < 24 * 3600 * 1000) {
      return cb(null, cached.url);
    }
  } catch (e) {
    // fall through and refetch
  }
  http.getJSON(TILEJSON, 15000, function(err, data) {
    if (err || !data.tiles || !data.tiles.length) {
      return cb(err || 'No tile URL');
    }
    localStorage.setItem(TILEJSON_KEY, JSON.stringify({time: Date.now(), url: data.tiles[0]}));
    cb(null, data.tiles[0]);
  });
}

function lonToTileX(lon, n) {
  return (lon + 180) / 360 * n;
}

function latToTileY(lat, n) {
  var r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
}

function tileYToLat(y, n) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
}

// Fetch tiles one after another and collect projected road lines.
function fetchTiles(m, template, cb) {
  var n = Math.pow(2, TILE_ZOOM);
  var nw = m.proj.toLatLon(m.box.x0, m.box.y0);
  var se = m.proj.toLatLon(m.box.x1, m.box.y1);
  var tiles = [];
  for (var tx = Math.floor(lonToTileX(nw.lon, n)); tx <= Math.floor(lonToTileX(se.lon, n)); tx++) {
    for (var ty = Math.floor(latToTileY(nw.lat, n)); ty <= Math.floor(latToTileY(se.lat, n)); ty++) {
      tiles.push({x: tx, y: ty});
    }
  }
  var lines = [];
  (function next(i) {
    if (i >= tiles.length) {
      return cb(null, lines);
    }
    var t = tiles[i];
    var url = template.replace('{z}', TILE_ZOOM).replace('{x}', t.x).replace('{y}', t.y);
    http.getBytes(url, 20000, function(err, bytes) {
      if (err) {
        return cb(err);
      }
      var features;
      try {
        features = vectortile.lineFeatures(bytes, 'transportation');
      } catch (e) {
        return cb('Bad map tile');
      }
      features.forEach(function(f) {
        var cls = f.tags['class'];
        var kind = MAJOR.test(cls) ? KIND.MAJOR : (MINOR.test(cls) ? KIND.MINOR : -1);
        if (kind < 0 || f.tags.brunnel === 'tunnel') {
          return;
        }
        f.lines.forEach(function(line) {
          var pts = line.map(function(p) {
            var lon = (t.x + p.x) / n * 360 - 180;
            var lat = tileYToLat(t.y + p.y, n);
            return m.proj.toXY(lat, lon);
          });
          lines.push({kind: kind, points: pts});
        });
      });
      next(i + 1);
    });
  })(0);
}

// ---- Cache: compact street lists per stop, least recently used dropped. ----

function cacheKey(m) {
  return CACHE_PREFIX + m.stop.lat.toFixed(5) + ',' + m.stop.lon.toFixed(5) + ',' + m.radius;
}

function cacheIndex() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_INDEX) || '[]');
  } catch (e) {
    return [];
  }
}

function cacheGet(key) {
  try {
    var entry = JSON.parse(localStorage.getItem(key) || 'null');
    if (!entry || Date.now() - entry.time > CACHE_MAX_AGE) {
      return null;
    }
    return entry.lines.map(function(flat) {
      var pts = [];
      for (var i = 1; i < flat.length; i += 2) {
        pts.push({x: flat[i], y: flat[i + 1]});
      }
      return {kind: flat[0], points: pts};
    });
  } catch (e) {
    return null;
  }
}

function cachePut(key, lines) {
  var flat = lines.map(function(l) {
    var out = [l.kind];
    l.points.forEach(function(p) {
      out.push(Math.round(p.x), Math.round(p.y));
    });
    return out;
  });
  var index = cacheIndex().filter(function(k) { return k !== key; });
  index.unshift(key);
  while (index.length > CACHE_ENTRIES) {
    localStorage.removeItem(index.pop());
  }
  try {
    localStorage.setItem(key, JSON.stringify({time: Date.now(), lines: flat}));
    localStorage.setItem(CACHE_INDEX, JSON.stringify(index));
  } catch (e) {
    console.log('Street cache full: ' + e);
  }
}

exports.fetchRoads = function(m, cb) {
  var key = cacheKey(m);
  var cached = cacheGet(key);
  if (cached) {
    return cb(null, cached);
  }
  tileTemplate(function(err, template) {
    if (err) {
      return cb(err);
    }
    fetchTiles(m, template, function(err, raw) {
      if (err) {
        return cb(err);
      }
      var lines = [];
      raw.forEach(function(line) {
        geo.clipPolyline(line.points, m.box).forEach(function(piece) {
          var simple = geo.simplify(piece, m.tolerance);
          var mid = simple[Math.floor(simple.length / 2)];
          lines.push({kind: line.kind, points: simple, dist: Math.sqrt(mid.x * mid.x + mid.y * mid.y)});
        });
      });
      // Big roads first, then the streets closest to the stop, within budget.
      lines.sort(function(a, b) { return (b.kind - a.kind) || (a.dist - b.dist); });
      var budget = MAX_POINTS;
      lines = lines.filter(function(l) {
        budget -= l.points.length;
        return budget >= 0;
      });
      cachePut(key, lines);
      cb(null, lines);
    });
  });
};

function push16(bytes, v) {
  v = Math.max(-32768, Math.min(32767, Math.round(v)));
  bytes.push(v & 0xff, (v >> 8) & 0xff);
}

// Pack polylines into AppMessage-sized byte arrays.
exports.encode = function(lines) {
  var chunks = [];
  var cur = [];
  lines.forEach(function(line) {
    // Drop points that collapse onto the previous one once rounded.
    var pts = [];
    line.points.forEach(function(p) {
      var q = {x: Math.round(p.x), y: Math.round(p.y)};
      var last = pts[pts.length - 1];
      if (!last || last.x !== q.x || last.y !== q.y) {
        pts.push(q);
      }
    });
    for (var start = 0; start < pts.length - 1; start += 254) {
      var part = pts.slice(start, start + 255);
      if (cur.length + 2 + part.length * 4 > CHUNK_BYTES) {
        chunks.push(cur);
        cur = [];
      }
      cur.push(line.kind, part.length);
      part.forEach(function(p) {
        push16(cur, p.x);
        push16(cur, p.y);
      });
    }
  });
  if (cur.length) {
    chunks.push(cur);
  }
  return chunks;
};
