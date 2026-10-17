#include "app.h"

#define PERSIST_DEST_NAMES 1

char g_dest_names[MAX_DESTS][DEST_NAME_LEN];
int g_dest_count;
GFont g_font_name;
GFont g_font_small;

static bool s_js_ready;
static int s_fetch_pending = -1;
static int s_map_pending = -1;
static int s_fetch_inflight = -1;
static int s_map_inflight = -1;
static int s_retries;
static AppTimer *s_send_timer;

// ---- Destination names -------------------------------------------------

static void parse_dest_names(const char *joined) {
  g_dest_count = 0;
  const char *p = joined;
  while (*p && g_dest_count < MAX_DESTS) {
    const char *end = strchr(p, '\n');
    size_t len = end ? (size_t)(end - p) : strlen(p);
    if (len >= DEST_NAME_LEN) {
      len = DEST_NAME_LEN - 1;
    }
    memcpy(g_dest_names[g_dest_count], p, len);
    g_dest_names[g_dest_count][len] = '\0';
    g_dest_count++;
    if (!end) {
      break;
    }
    p = end + 1;
  }
}

// ---- Outbox --------------------------------------------------------------

static void send_pending(void *unused);

static void schedule_send(uint32_t delay_ms) {
  if (!s_send_timer) {
    s_send_timer = app_timer_register(delay_ms, send_pending, NULL);
  }
}

static void send_pending(void *unused) {
  s_send_timer = NULL;
  if (!s_js_ready || (s_fetch_pending < 0 && s_map_pending < 0)) {
    return;
  }
  if (s_fetch_inflight >= 0 || s_map_inflight >= 0) {
    schedule_send(200);
    return;
  }
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) {
    schedule_send(250);
    return;
  }
  if (s_fetch_pending >= 0) {
    dict_write_int32(it, MESSAGE_KEY_Fetch, s_fetch_pending);
  }
  if (s_map_pending >= 0) {
    dict_write_int32(it, MESSAGE_KEY_MapRequest, s_map_pending);
  }
  if (app_message_outbox_send() == APP_MSG_OK) {
    s_fetch_inflight = s_fetch_pending;
    s_map_inflight = s_map_pending;
    s_fetch_pending = s_map_pending = -1;
  } else {
    schedule_send(250);
  }
}

static void outbox_sent(DictionaryIterator *it, void *ctx) {
  s_fetch_inflight = s_map_inflight = -1;
  s_retries = 0;
  send_pending(NULL);
}

static void outbox_failed(DictionaryIterator *it, AppMessageResult reason, void *ctx) {
  // Re-queue unless a newer request replaced it meanwhile.
  if (s_fetch_pending < 0) {
    s_fetch_pending = s_fetch_inflight;
  }
  if (s_map_pending < 0) {
    s_map_pending = s_map_inflight;
  }
  s_fetch_inflight = s_map_inflight = -1;
  if (++s_retries <= 5) {
    schedule_send(500 * s_retries);
  } else {
    s_retries = 0;
    s_fetch_pending = s_map_pending = -1;
    list_window_set_status(list_window_dest(), "Can't reach phone");
  }
}

void comm_fetch(int dest) {
  s_fetch_pending = dest;
  schedule_send(10);
}

void comm_request_map(int item) {
  s_map_pending = item;
  schedule_send(10);
}

// ---- Inbox ---------------------------------------------------------------

static int32_t tuple_int(DictionaryIterator *it, uint32_t key, int32_t fallback) {
  Tuple *t = dict_find(it, key);
  return t ? t->value->int32 : fallback;
}

static void tuple_str(DictionaryIterator *it, uint32_t key, char *out, size_t n) {
  Tuple *t = dict_find(it, key);
  if (t && t->type == TUPLE_CSTRING) {
    strncpy(out, t->value->cstring, n - 1);
    out[n - 1] = '\0';
  } else {
    out[0] = '\0';
  }
}

static void inbox_received(DictionaryIterator *it, void *ctx) {
  Tuple *t;

  if ((t = dict_find(it, MESSAGE_KEY_DestNames))) {
    parse_dest_names(t->value->cstring);
    persist_write_string(PERSIST_DEST_NAMES, t->value->cstring);
    dest_window_reload();
  }

  if (dict_find(it, MESSAGE_KEY_Ready)) {
    s_js_ready = true;
    list_window_on_ready();
    send_pending(NULL);
  }

  int dest = tuple_int(it, MESSAGE_KEY_DestIndex, -1);

  if ((t = dict_find(it, MESSAGE_KEY_ResultsBegin))) {
    list_window_begin(dest, t->value->int32);
  }

  if ((t = dict_find(it, MESSAGE_KEY_ItemIndex))) {
    Departure d;
    memset(&d, 0, sizeof(d));
    tuple_str(it, MESSAGE_KEY_Line, d.line, sizeof(d.line));
    tuple_str(it, MESSAGE_KEY_Stop, d.stop, sizeof(d.stop));
    tuple_str(it, MESSAGE_KEY_Headsign, d.headsign, sizeof(d.headsign));
    d.dep = tuple_int(it, MESSAGE_KEY_DepTime, 0);
    d.leave = tuple_int(it, MESSAGE_KEY_LeaveTime, d.dep);
    d.arr = tuple_int(it, MESSAGE_KEY_ArrTime, d.dep);
    d.delay = tuple_int(it, MESSAGE_KEY_Delay, 0);
    d.walk_min = tuple_int(it, MESSAGE_KEY_WalkMin, 0);
    d.walk_dist = tuple_int(it, MESSAGE_KEY_WalkDist, 0);
    d.transfers = tuple_int(it, MESSAGE_KEY_Transfers, 0);
    d.realtime = tuple_int(it, MESSAGE_KEY_RealTime, 0) != 0;
    d.color = GColorFromHEX(tuple_int(it, MESSAGE_KEY_Color, 0x0055AA));
    list_window_set_item(dest, t->value->int32, &d);
  }

  if ((t = dict_find(it, MESSAGE_KEY_Status))) {
    list_window_set_status(dest, t->value->cstring);
  }

  if ((t = dict_find(it, MESSAGE_KEY_MapBegin))) {
    map_window_begin(t->value->int32,
                     tuple_int(it, MESSAGE_KEY_MapUserX, 0),
                     tuple_int(it, MESSAGE_KEY_MapUserY, 0),
                     tuple_int(it, MESSAGE_KEY_MapScale, 20));
  }

  if ((t = dict_find(it, MESSAGE_KEY_MapData)) && t->type == TUPLE_BYTE_ARRAY) {
    map_window_add_data(t->value->data, t->length);
  }

  if ((t = dict_find(it, MESSAGE_KEY_MapEnd))) {
    char status[64];
    tuple_str(it, MESSAGE_KEY_MapStatus, status, sizeof(status));
    map_window_end(t->value->int32, status);
  }
}

// ---- App lifecycle -------------------------------------------------------

static void init(void) {
  g_font_name = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_NAME_BOLD_17));
  g_font_small = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_NAME_14));

  if (persist_exists(PERSIST_DEST_NAMES)) {
    char joined[MAX_DESTS * DEST_NAME_LEN + 1];
    persist_read_string(PERSIST_DEST_NAMES, joined, sizeof(joined));
    parse_dest_names(joined);
  }

  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_sent(outbox_sent);
  app_message_register_outbox_failed(outbox_failed);
  uint32_t inbox = app_message_inbox_size_maximum();
  app_message_open(inbox < 4096 ? inbox : 4096, 128);

  dest_window_push();
}

static void deinit(void) {
  fonts_unload_custom_font(g_font_name);
  fonts_unload_custom_font(g_font_small);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
