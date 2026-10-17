// Minimal XHR helpers.

// Transitous' usage policy (https://transitous.org/api/) requires a
// User-Agent with the app name, version and a way to contact you.
// Set CONTACT to your project URL or e-mail before publishing.
var CONTACT = 'https://github.com/amitn/pebble-bus';
var USER_AGENT = 'PebbleNextBus/1.0.0 (+' + CONTACT + ')';

function request(url, timeoutMs, binary, cb) {
  var xhr = new XMLHttpRequest();
  var done = false;
  function finish(err, data) {
    if (!done) {
      done = true;
      cb(err, data);
    }
  }
  xhr.open('GET', url, true);
  try {
    xhr.setRequestHeader('User-Agent', USER_AGENT);
  } catch (e) {
    // Some phone JS runtimes forbid it and send their own browser UA.
  }
  if (binary) {
    xhr.responseType = 'arraybuffer';
    if (xhr.overrideMimeType) {
      xhr.overrideMimeType('text/plain; charset=x-user-defined');
    }
  }
  xhr.timeout = timeoutMs;
  xhr.onload = function() {
    if (xhr.status !== 200) {
      return finish('Server error ' + xhr.status);
    }
    if (binary) {
      return finish(null, toBytes(xhr));
    }
    try {
      finish(null, JSON.parse(xhr.responseText));
    } catch (e) {
      finish('Bad server response');
    }
  };
  xhr.onerror = function() { finish('No connection'); };
  xhr.ontimeout = function() { finish('Server timed out'); };
  xhr.send();
}

function toBytes(xhr) {
  var res = xhr.response;
  if (res && typeof res !== 'string' && res.byteLength !== undefined) {
    return new Uint8Array(res);
  }
  // Runtimes without arraybuffer support: x-user-defined keeps bytes intact.
  var text = typeof res === 'string' ? res : xhr.responseText;
  var bytes = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

exports.getJSON = function(url, timeoutMs, cb) {
  request(url, timeoutMs, false, cb);
};

exports.getBytes = function(url, timeoutMs, cb) {
  request(url, timeoutMs, true, cb);
};
