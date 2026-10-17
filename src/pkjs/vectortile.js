// Just enough of a Mapbox Vector Tile (protobuf) decoder to pull line
// features out of one layer. Spec: https://github.com/mapbox/vector-tile-spec

function Reader(bytes) {
  this.buf = bytes;
  this.pos = 0;
}

Reader.prototype.varint = function() {
  var result = 0, mul = 1, b;
  do {
    b = this.buf[this.pos++];
    result += (b & 0x7f) * mul;
    mul *= 128;
  } while (b >= 0x80);
  return result;
};

Reader.prototype.skip = function(wireType) {
  if (wireType === 0) {
    this.varint();
  } else if (wireType === 1) {
    this.pos += 8;
  } else if (wireType === 2) {
    this.pos += this.varint();
  } else if (wireType === 5) {
    this.pos += 4;
  } else {
    throw new Error('Unsupported wire type ' + wireType);
  }
};

// Calls fn(field, wireType, reader) for each field up to `end`.
Reader.prototype.fields = function(end, fn) {
  while (this.pos < end) {
    var tag = this.varint();
    var start = this.pos;
    fn(tag >> 3, tag & 7);
    if (this.pos === start) {
      this.skip(tag & 7);
    }
  }
};

Reader.prototype.string = function() {
  var len = this.varint();
  var s = '';
  for (var i = 0; i < len; i++) {
    s += String.fromCharCode(this.buf[this.pos + i]);  // keys/classes are ASCII
  }
  this.pos += len;
  return s;
};

Reader.prototype.packed = function() {
  var end = this.varint() + this.pos;
  var out = [];
  while (this.pos < end) {
    out.push(this.varint());
  }
  return out;
};

function readValue(r) {
  var end = r.varint() + r.pos;
  var value = null;
  r.fields(end, function(field) {
    if (field === 1) {
      value = r.string();
    }
  });
  return value;  // only string values matter here
}

function decodeGeometry(cmds, extent) {
  var lines = [];
  var line = null;
  var x = 0, y = 0;
  var i = 0;
  while (i < cmds.length) {
    var cmd = cmds[i] & 7;
    var count = cmds[i] >> 3;
    i++;
    if (cmd === 7) {
      continue;
    }
    for (var n = 0; n < count; n++) {
      var dx = cmds[i++], dy = cmds[i++];
      x += (dx >> 1) ^ -(dx & 1);
      y += (dy >> 1) ^ -(dy & 1);
      if (cmd === 1) {
        line = [];
        lines.push(line);
      }
      line.push({x: x / extent, y: y / extent});
    }
  }
  return lines;
}

// Returns [{tags: {key: value}, lines: [[{x, y}]]}] for line features of
// `layerName`, with x/y as fractions of the tile (0..1).
exports.lineFeatures = function(bytes, layerName) {
  var r = new Reader(bytes);
  var out = [];
  r.fields(bytes.length, function(field) {
    if (field !== 3) {
      return;
    }
    var end = r.varint() + r.pos;
    var name = null, extent = 4096, keys = [], values = [], features = [];
    r.fields(end, function(f) {
      if (f === 1) {
        name = r.string();
      } else if (f === 2) {
        // Remember where features are; only decode them if the layer matches.
        var len = r.varint();
        features.push([r.pos, r.pos + len]);
        r.pos += len;
      } else if (f === 3) {
        keys.push(r.string());
      } else if (f === 4) {
        values.push(readValue(r));
      } else if (f === 5) {
        extent = r.varint();
      }
    });
    if (name !== layerName) {
      return;
    }
    var resume = r.pos;
    features.forEach(function(range) {
      r.pos = range[0];
      var feature = {type: 0, tags: [], geometry: []};
      r.fields(range[1], function(ff) {
        if (ff === 2) {
          feature.tags = r.packed();
        } else if (ff === 3) {
          feature.type = r.varint();
        } else if (ff === 4) {
          feature.geometry = r.packed();
        }
      });
      if (feature.type !== 2) {
        return;
      }
      var tags = {};
      for (var i = 0; i + 1 < feature.tags.length; i += 2) {
        tags[keys[feature.tags[i]]] = values[feature.tags[i + 1]];
      }
      out.push({tags: tags, lines: decodeGeometry(feature.geometry, extent)});
    });
    r.pos = resume;
  });
  return out;
};
