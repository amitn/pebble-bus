// Sequential AppMessage queue: Pebble only allows one message in flight.

var queue = [];
var busy = false;

function pump() {
  if (busy || !queue.length) {
    return;
  }
  busy = true;
  var entry = queue[0];
  Pebble.sendAppMessage(entry.msg, function() {
    queue.shift();
    busy = false;
    pump();
  }, function() {
    busy = false;
    entry.tries++;
    if (entry.tries >= 3) {
      console.log('Dropping message after 3 attempts: ' + Object.keys(entry.msg).join(','));
      queue.shift();
    }
    setTimeout(pump, 300 * entry.tries);
  });
}

// tag lets later requests drop stale queued messages (e.g. an old map).
exports.send = function(msg, tag) {
  queue.push({msg: msg, tag: tag || null, tries: 0});
  pump();
};

exports.drop = function(tag) {
  // Never drop queue[0] while it's in flight.
  queue = queue.filter(function(entry, i) {
    return (busy && i === 0) || entry.tag !== tag;
  });
};
