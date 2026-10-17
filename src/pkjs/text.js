// Text helpers. Pebble draws text strictly left-to-right, so Hebrew (and
// other RTL) strings are converted to visual order here on the phone.

var RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
var LTR = /[A-Za-z0-9À-ɏ]/;
var MIRROR = {'(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<'};

function charClass(ch) {
  if (RTL.test(ch)) {
    return 'R';
  }
  if (LTR.test(ch)) {
    return 'L';
  }
  return 'N';
}

// Simplified bidi: base direction comes from the first strong character.
// Runs of the opposite direction (including neutrals inside them) are
// kept intact; the rest is reordered.
function visual(str) {
  if (!str || !RTL.test(str)) {
    return str || '';
  }
  var chars = Array.from ? Array.from(str) : str.split('');
  var classes = chars.map(charClass);
  var base = 'L';
  for (var i = 0; i < classes.length; i++) {
    if (classes[i] !== 'N') {
      base = classes[i];
      break;
    }
  }
  var other = base === 'R' ? 'L' : 'R';

  // Group into tokens: an "other-direction" run, or a single character.
  var tokens = [];
  i = 0;
  while (i < chars.length) {
    if (classes[i] === other) {
      var end = i;
      for (var j = i + 1; j < chars.length && classes[j] !== base; j++) {
        if (classes[j] === other) {
          end = j;
        }
      }
      tokens.push({run: true, text: chars.slice(i, end + 1)});
      i = end + 1;
    } else {
      tokens.push({run: false, text: [chars[i]]});
      i++;
    }
  }

  if (base === 'R') {
    // Whole line reversed; LTR runs keep their internal order.
    return tokens.reverse().map(function(t) {
      if (t.run) {
        return t.text.join('');
      }
      return MIRROR[t.text[0]] || t.text[0];
    }).join('');
  }
  // LTR line with embedded RTL runs: reverse each run in place.
  return tokens.map(function(t) {
    if (!t.run) {
      return t.text.join('');
    }
    return t.text.slice().reverse().map(function(c) { return MIRROR[c] || c; }).join('');
  }).join('');
}

function utf8Length(ch) {
  var c = ch.codePointAt ? ch.codePointAt(0) : ch.charCodeAt(0);
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}

// Cut a string (in logical order) to at most maxBytes of UTF-8, adding "…".
function truncate(str, maxBytes) {
  str = (str || '').replace(/\s+/g, ' ').trim();
  var chars = Array.from ? Array.from(str) : str.split('');
  var total = 0;
  for (var i = 0; i < chars.length; i++) {
    total += utf8Length(chars[i]);
  }
  if (total <= maxBytes) {
    return str;
  }
  var out = '';
  var used = 3;  // room for the ellipsis
  for (i = 0; i < chars.length; i++) {
    var len = utf8Length(chars[i]);
    if (used + len > maxBytes) {
      break;
    }
    out += chars[i];
    used += len;
  }
  return out.replace(/\s+$/, '') + '…';
}

// Prepare a name for the watch: tidy, cut to size, convert to visual order.
exports.forWatch = function(str, maxBytes) {
  str = (str || '').replace(/_/g, ' - ');
  return visual(truncate(str, maxBytes));
};

exports.visual = visual;
exports.truncate = truncate;
