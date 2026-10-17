// Geometry helpers: polyline decoding, local projection, clipping, simplification.

// Google encoded polyline with configurable precision (MOTIS uses 6 or 7).
exports.decodePolyline = function(encoded, precision) {
  var factor = Math.pow(10, precision || 6);
  var points = [];
  var index = 0, lat = 0, lon = 0;
  while (encoded && index < encoded.length) {
    var result = 0, shift = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({lat: lat / factor, lon: lon / factor});
  }
  return points;
};

// Equirectangular projection to meters around an origin (x east, y south).
exports.projection = function(origin) {
  var kx = 111320 * Math.cos(origin.lat * Math.PI / 180);
  var ky = 110540;
  return {
    toXY: function(lat, lon) {
      return {x: (lon - origin.lon) * kx, y: (origin.lat - lat) * ky};
    },
    toLatLon: function(x, y) {
      return {lat: origin.lat - y / ky, lon: origin.lon + x / kx};
    }
  };
};

exports.distance = function(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};

// Liang-Barsky segment clip against box {x0, y0, x1, y1}; null if outside.
function clipSegment(a, b, box) {
  var t0 = 0, t1 = 1;
  var dx = b.x - a.x, dy = b.y - a.y;
  var p = [-dx, dx, -dy, dy];
  var q = [a.x - box.x0, box.x1 - a.x, a.y - box.y0, box.y1 - a.y];
  for (var i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) {
        return null;
      }
    } else {
      var t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) {
          return null;
        }
        if (t > t0) {
          t0 = t;
        }
      } else {
        if (t < t0) {
          return null;
        }
        if (t < t1) {
          t1 = t;
        }
      }
    }
  }
  return {
    a: {x: a.x + t0 * dx, y: a.y + t0 * dy},
    b: {x: a.x + t1 * dx, y: a.y + t1 * dy},
    clippedEnd: t1 < 1
  };
}

// Clip a polyline to a box; may split it into several pieces.
exports.clipPolyline = function(points, box) {
  var out = [];
  var cur = null;
  for (var i = 1; i < points.length; i++) {
    var seg = clipSegment(points[i - 1], points[i], box);
    if (!seg) {
      if (cur) {
        out.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur) {
      cur = [seg.a];
    }
    cur.push(seg.b);
    if (seg.clippedEnd) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) {
    out.push(cur);
  }
  return out.filter(function(line) { return line.length >= 2; });
};

function perpDistance(p, a, b) {
  var dx = b.x - a.x, dy = b.y - a.y;
  var len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    dx = p.x - a.x;
    dy = p.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  var t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  var ex = a.x + t * dx - p.x, ey = a.y + t * dy - p.y;
  return Math.sqrt(ex * ex + ey * ey);
}

// Douglas-Peucker simplification (iterative).
exports.simplify = function(points, tolerance) {
  if (points.length <= 2) {
    return points.slice();
  }
  var keep = new Array(points.length);
  keep[0] = keep[points.length - 1] = true;
  var stack = [[0, points.length - 1]];
  while (stack.length) {
    var range = stack.pop();
    var first = range[0], last = range[1];
    var maxDist = 0, index = -1;
    for (var i = first + 1; i < last; i++) {
      var d = perpDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index >= 0 && maxDist > tolerance) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter(function(p, i) { return keep[i]; });
};
