// Settings page, opened as a data: URL inside the Pebble phone app.
// Destinations are picked with Transitous geocoding so we store exact
// coordinates instead of free-text addresses.

var CSS = [
  '*{box-sizing:border-box}',
  'body{margin:0;font:16px/1.4 -apple-system,Roboto,"Segoe UI",sans-serif;background:#f2f3f5;color:#1b1d21}',
  'header{background:#002255;color:#fff;padding:18px 16px}',
  'header h1{margin:0;font-size:22px}header p{margin:4px 0 0;opacity:.75;font-size:14px}',
  'main{padding:12px 16px 96px;max-width:560px;margin:0 auto}',
  'h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#5b6270;margin:22px 4px 8px}',
  '.card{background:#fff;border-radius:12px;padding:12px;margin-bottom:10px;box-shadow:0 1px 2px rgba(0,0,0,.08)}',
  'label{display:block;font-size:13px;color:#5b6270;margin:0 0 4px}',
  'input[type=text],select{width:100%;font:inherit;padding:10px 12px;border:1px solid #cfd3da;border-radius:8px;background:#fff;color:inherit}',
  'input:focus,select:focus{outline:2px solid #0055aa;border-color:transparent}',
  '.row{display:flex;gap:8px;align-items:center}.row>*{flex:1}',
  '.place{margin-top:8px;font-size:14px;color:#0b6b2f}.place.none{color:#a33}',
  '.results{margin-top:6px}.results button{display:block;width:100%;text-align:left;background:#f6f7f9;border:0;border-radius:8px;padding:9px 10px;margin-top:4px;font:inherit;color:inherit}',
  '.results small{display:block;color:#5b6270}',
  '.actions{display:flex;justify-content:space-between;margin-top:10px}',
  'button.link{background:none;border:0;color:#0055aa;font:inherit;padding:6px 0}',
  'button.link.danger{color:#b00020}',
  '.toggle{display:flex;justify-content:space-between;align-items:center;padding:4px 0}',
  '.toggle input{width:22px;height:22px}',
  '.save{position:fixed;left:0;right:0;bottom:0;padding:12px 16px;background:linear-gradient(transparent,#f2f3f5 30%)}',
  '.save button{width:100%;max-width:560px;display:block;margin:0 auto;padding:14px;font:600 17px inherit;border:0;border-radius:12px;background:#0055aa;color:#fff}',
  '.note{font-size:12px;color:#5b6270;margin:16px 4px}'
].join('\n');

// Runs inside the settings page, not in PebbleKit JS. Kept ES5.
function pageMain(INIT) {
  var GEOCODE = 'https://api.transitous.org/api/v1/geocode';
  var state = INIT.settings;
  var bias = INIT.location;
  var $ = function(id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c];
    });
  }

  function areaName(r) {
    var areas = (r.areas || []).filter(function(a) { return a.default || a.unique; });
    return areas.map(function(a) { return a.name; }).join(', ');
  }

  function search(text, cb) {
    var coords = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) {
      var lat = parseFloat(coords[1]), lon = parseFloat(coords[2]);
      return cb(null, [{name: text.trim(), lat: lat, lon: lon, area: 'Coordinates'}]);
    }
    var url = GEOCODE + '?text=' + encodeURIComponent(text) + '&numResults=6';
    if (bias) {
      url += '&place=' + bias.lat + ',' + bias.lon;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function() {
      try {
        var rows = JSON.parse(xhr.responseText).slice(0, 6).map(function(r) {
          var name = r.name + (r.houseNumber ? ' ' + r.houseNumber : '');
          if (r.street && r.type === 'ADDRESS') {
            name = r.street + ' ' + (r.houseNumber || '');
          }
          return {name: name.trim(), lat: r.lat, lon: r.lon, area: areaName(r), type: r.type};
        });
        cb(null, rows);
      } catch (e) {
        cb('Search failed');
      }
    };
    xhr.onerror = function() { cb('No connection'); };
    xhr.send();
  }

  // A place picker: search box + results + chosen place.
  function placePicker(container, place, onPick) {
    container.innerHTML =
      '<div class="row"><input type="text" placeholder="Search address, stop or place"><button class="link" style="flex:0 0 auto">Search</button></div>' +
      '<div class="place"></div><div class="results"></div>';
    var input = container.querySelector('input');
    var placeEl = container.querySelector('.place');
    var resultsEl = container.querySelector('.results');

    function showPlace(p) {
      placeEl.className = 'place' + (p ? '' : ' none');
      placeEl.textContent = p ? '✓ ' + p.label : 'No place chosen yet';
    }
    function run() {
      if (!input.value.trim()) {
        return;
      }
      resultsEl.innerHTML = '<small>Searching…</small>';
      search(input.value, function(err, rows) {
        if (err || !rows.length) {
          resultsEl.innerHTML = '<small>' + esc(err || 'Nothing found. Try adding the city.') + '</small>';
          return;
        }
        resultsEl.innerHTML = '';
        rows.forEach(function(r) {
          var b = document.createElement('button');
          b.innerHTML = esc(r.name) + '<small>' + esc(r.area) + '</small>';
          b.onclick = function() {
            var label = r.name + (r.area && r.area !== 'Coordinates' ? ', ' + r.area : '');
            var picked = {label: label, lat: r.lat, lon: r.lon, short: r.name};
            resultsEl.innerHTML = '';
            input.value = '';
            showPlace(picked);
            onPick(picked);
          };
          resultsEl.appendChild(b);
        });
      });
    }
    container.querySelector('button').onclick = run;
    input.onkeydown = function(e) {
      if (e.keyCode === 13) {
        run();
      }
    };
    showPlace(place);
  }

  function renderDests() {
    var list = $('dests');
    list.innerHTML = '';
    state.dests.forEach(function(d, i) {
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<label>Name on watch</label><input type="text" class="name" maxlength="24" placeholder="e.g. Home, Work">' +
        '<div style="height:10px"></div><label>Place</label><div class="picker"></div>' +
        '<div class="actions"><button class="link up">Move up</button><button class="link danger remove">Remove</button></div>';
      var name = card.querySelector('.name');
      name.value = d.name || '';
      name.oninput = function() { d.name = name.value; };
      placePicker(card.querySelector('.picker'), d.lat != null ? d : null, function(p) {
        d.label = p.label;
        d.lat = p.lat;
        d.lon = p.lon;
        if (!d.name) {
          d.name = p.short;
          name.value = p.short;
        }
      });
      card.querySelector('.remove').onclick = function() {
        state.dests.splice(i, 1);
        renderDests();
      };
      var up = card.querySelector('.up');
      up.style.visibility = i === 0 ? 'hidden' : 'visible';
      up.onclick = function() {
        state.dests.splice(i - 1, 0, state.dests.splice(i, 1)[0]);
        renderDests();
      };
      list.appendChild(card);
    });
    $('add').style.display = state.dests.length >= 5 ? 'none' : 'block';
  }

  function renderOrigin() {
    var fixed = !!state.origin || $('originMode').value === 'fixed';
    $('originMode').value = fixed ? 'fixed' : 'gps';
    $('originPicker').style.display = fixed ? 'block' : 'none';
  }

  $('add').onclick = function() {
    state.dests.push({name: '', label: '', lat: null, lon: null});
    renderDests();
    var inputs = document.querySelectorAll('#dests .picker input');
    inputs[inputs.length - 1].focus();
  };
  $('originMode').onchange = function() {
    if ($('originMode').value === 'gps') {
      state.origin = null;
    }
    renderOrigin();
  };
  placePicker($('originPicker'), state.origin, function(p) {
    state.origin = {label: p.label, lat: p.lat, lon: p.lon};
  });
  $('busOnly').checked = state.busOnly;
  $('maxTransfers').value = String(state.maxTransfers);
  $('maxWalk').value = String(state.maxWalk);

  $('save').onclick = function() {
    state.busOnly = $('busOnly').checked;
    state.maxTransfers = parseInt($('maxTransfers').value, 10);
    state.maxWalk = parseInt($('maxWalk').value, 10);
    if ($('originMode').value === 'fixed' && !state.origin) {
      alert('Pick a starting place, or switch to "My current location".');
      return;
    }
    var missing = state.dests.filter(function(d) { return d.lat == null; });
    if (missing.length) {
      alert('Pick a place for every destination (or remove the empty ones).');
      return;
    }
    state.dests.forEach(function(d) {
      d.name = (d.name || '').trim() || d.label.split(',')[0];
    });
    // The emulator (pebble-tool) passes its own return URL as ?return_to=
    var m = location.search.match(/[?&]return_to=([^&]*)/);
    var returnTo = m ? decodeURIComponent(m[1]) : 'pebblejs://close#';
    document.location = returnTo + encodeURIComponent(JSON.stringify(state));
  };

  renderDests();
  renderOrigin();
}

var BODY = [
  '<header><h1>Next Bus</h1><p>Upcoming buses to your places</p></header>',
  '<main>',
  '<h2>Destinations</h2>',
  '<div id="dests"></div>',
  '<button class="link" id="add">+ Add destination</button>',
  '<h2>Starting point</h2>',
  '<div class="card"><select id="originMode"><option value="gps">My current location</option><option value="fixed">A fixed place</option></select>',
  '<div id="originPicker" style="margin-top:10px"></div></div>',
  '<h2>Options</h2>',
  '<div class="card">',
  '<div class="toggle"><span>Buses only</span><input type="checkbox" id="busOnly"></div>',
  '<div style="height:10px"></div><label>Changes</label>',
  '<select id="maxTransfers"><option value="0">Direct buses only</option><option value="1">Up to 1 change</option><option value="2">Up to 2 changes</option><option value="-1">Any</option></select>',
  '<div style="height:10px"></div><label>Longest walk to / from a stop</label>',
  '<select id="maxWalk"><option value="5">5 min</option><option value="10">10 min</option><option value="15">15 min</option><option value="20">20 min</option><option value="30">30 min</option></select>',
  '</div>',
  '<p class="note">Timetables by <a href="https://transitous.org/">Transitous</a> (<a href="https://transitous.org/sources/">data sources</a>). ' +
    'Maps \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors. ' +
    'London live times: Powered by <a href="https://tfl.gov.uk/info-for/open-data-users/">TfL Open Data</a>.</p>',
  '</main>',
  '<div class="save"><button id="save">Save</button></div>'
].join('\n');

exports.url = function(settings, location) {
  var init = {
    settings: JSON.parse(JSON.stringify(settings)),
    location: location ? {lat: location.lat.toFixed(4), lon: location.lon.toFixed(4)} : null
  };
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Next Bus</title><style>' + CSS + '</style></head><body>' + BODY +
    '<script>(' + pageMain.toString() + ')(' + JSON.stringify(init).replace(/</g, '\\u003c') + ');</script>' +
    '</body></html>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
};
