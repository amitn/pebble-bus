#include "app.h"

#define REFRESH_SECONDS 120
#define ROW_HEIGHT 70

static Window *s_window;
static StatusBarLayer *s_status_bar;
static MenuLayer *s_menu;

static int s_dest = -1;
static Departure s_items[MAX_ITEMS];
static int s_count;
static Departure s_incoming[MAX_ITEMS];  // a refresh, committed once complete
static int s_expected;
static char s_status[64];
static bool s_loading;
static time_t s_last_fetch;

static void fetch(void) {
  s_loading = true;
  s_last_fetch = time(NULL);
  comm_fetch(s_dest);
  if (s_menu) {
    menu_layer_reload_data(s_menu);
  }
}

// ---- Menu callbacks --------------------------------------------------------

static uint16_t get_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  return s_count > 0 ? s_count : 1;
}

static int16_t get_header_height(MenuLayer *menu, uint16_t section, void *ctx) {
  return 28;
}

static int16_t get_cell_height(MenuLayer *menu, MenuIndex *index, void *ctx) {
  return s_count > 0 ? ROW_HEIGHT : 150;
}

static void draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *data) {
  GRect b = layer_get_bounds(cell);
  graphics_context_set_fill_color(ctx, COLOR_ACCENT_DARK);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);

  // Destination pin + name
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_circle(ctx, GPoint(12, b.size.h / 2), 6);
  graphics_context_set_fill_color(ctx, COLOR_ACCENT_DARK);
  graphics_fill_circle(ctx, GPoint(12, b.size.h / 2), 2);
  int right = s_loading ? 22 : 6;
  const char *name = s_dest >= 0 && s_dest < g_dest_count ? g_dest_names[s_dest] : "";
  draw_name(ctx, name, g_font_name, GRect(24, 3, b.size.w - 24 - right, 22), GTextAlignmentLeft);
  if (s_loading) {
    // Small "refreshing" dots
    graphics_context_set_fill_color(ctx, GColorPictonBlue);
    for (int i = 0; i < 3; i++) {
      graphics_fill_circle(ctx, GPoint(b.size.w - 16 + i * 5, b.size.h / 2), 1);
    }
  }
}

static void draw_status_row(GContext *ctx, const Layer *cell) {
  GRect b = layer_get_bounds(cell);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorDarkGray);
  const char *text = s_status[0] ? s_status : (s_loading ? "Finding buses…" : "");
  graphics_draw_text(ctx, text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                     GRect(10, 30, b.size.w - 20, b.size.h - 30), GTextOverflowModeWordWrap,
                     GTextAlignmentCenter, NULL);
}

static void draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *data) {
  if (s_count == 0) {
    draw_status_row(ctx, cell);
    return;
  }
  const Departure *d = &s_items[index->row];
  GRect b = layer_get_bounds(cell);
  bool hl = menu_cell_layer_is_highlighted(cell);
  time_t now = time(NULL);
  bool gone = now > d->dep + 30;

  GColor fg = hl ? GColorWhite : (gone ? GColorLightGray : GColorBlack);
  GColor sub = hl ? GColorWhite : GColorDarkGray;
  char buf[24];

  // Line badge + transfers below it
  draw_line_badge(ctx, d, GRect(6, 8, 52, 30), hl);
  if (d->transfers > 0) {
    snprintf(buf, sizeof(buf), "+%d bus", d->transfers);
    graphics_context_set_text_color(ctx, sub);
    graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14), GRect(2, 40, 60, 16),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  }

  int x = 64;
  int w = b.size.w - x - 6;

  // Countdown to departure + clock time
  format_countdown(buf, sizeof(buf), d->dep, now);
  graphics_context_set_text_color(ctx, fg);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD), GRect(x, -2, w, 28),
                     GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  format_clock(buf, sizeof(buf), d->dep);
  if (d->delay >= 60) {
    graphics_context_set_text_color(ctx, hl ? GColorWhite : GColorRed);
    size_t len = strlen(buf);
    snprintf(buf + len, sizeof(buf) - len, " +%d", d->delay / 60);
  } else {
    graphics_context_set_text_color(ctx, sub);
  }
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_18), GRect(x, 2, w, 22),
                     GTextOverflowModeFill, GTextAlignmentRight, NULL);
  if (d->realtime && !hl) {
    // Live-data marker next to the clock
    graphics_context_set_fill_color(ctx, GColorIslamicGreen);
    graphics_fill_circle(ctx, GPoint(b.size.w - 3, 8), 2);
  }

  // Boarding stop
  graphics_context_set_text_color(ctx, fg);
  draw_name(ctx, d->stop, g_font_name, GRect(x, 27, w, 20), GTextAlignmentLeft);

  // When to leave, colored by urgency, + arrival time
  long leave_in = (long)(d->leave - now);
  GColor urgency;
  if (gone) {
    snprintf(buf, sizeof(buf), "Departed");
    urgency = GColorLightGray;
  } else if (leave_in < 0) {
    snprintf(buf, sizeof(buf), "Hurry!");
    urgency = GColorRed;
  } else if (leave_in < 60) {
    snprintf(buf, sizeof(buf), "Leave now");
    urgency = GColorRed;
  } else if (leave_in < 3600) {
    snprintf(buf, sizeof(buf), "Leave in %ld'", leave_in / 60);
    urgency = leave_in < 300 ? GColorWindsorTan : GColorIslamicGreen;
  } else {
    char at[12];
    format_clock(at, sizeof(at), d->leave);
    snprintf(buf, sizeof(buf), "Leave %s", at);
    urgency = GColorIslamicGreen;
  }
  graphics_context_set_text_color(ctx, hl ? GColorWhite : urgency);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(x, 46, w, 22),
                     GTextOverflowModeFill, GTextAlignmentLeft, NULL);

  char arr[16];
  format_clock(arr, sizeof(arr), d->arr);
  snprintf(buf, sizeof(buf), "arr %s", arr);
  graphics_context_set_text_color(ctx, sub);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14), GRect(x, 50, w, 18),
                     GTextOverflowModeFill, GTextAlignmentRight, NULL);
}

static void select_click(MenuLayer *menu, MenuIndex *index, void *ctx) {
  if (s_count > 0) {
    map_window_push(index->row);
  } else {
    fetch();
  }
}

static void select_long_click(MenuLayer *menu, MenuIndex *index, void *ctx) {
  vibes_short_pulse();
  fetch();
}

// ---- Window ---------------------------------------------------------------

static void tick_handler(struct tm *tick_time, TimeUnits changed) {
  if (!s_menu) {
    return;
  }
  if (!s_loading && time(NULL) - s_last_fetch >= REFRESH_SECONDS &&
      window_stack_get_top_window() == s_window) {
    fetch();
  }
  menu_layer_reload_data(s_menu);
  map_window_refresh();
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  s_status_bar = status_bar_layer_create();
  status_bar_layer_set_colors(s_status_bar, COLOR_ACCENT_DARK, GColorWhite);
  layer_add_child(root, status_bar_layer_get_layer(s_status_bar));

  s_menu = menu_layer_create(
      GRect(0, STATUS_BAR_LAYER_HEIGHT, b.size.w, b.size.h - STATUS_BAR_LAYER_HEIGHT));
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_rows = get_num_rows,
    .get_header_height = get_header_height,
    .get_cell_height = get_cell_height,
    .draw_header = draw_header,
    .draw_row = draw_row,
    .select_click = select_click,
    .select_long_click = select_long_click,
  });
  menu_layer_set_normal_colors(s_menu, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_menu, COLOR_ACCENT, GColorWhite);
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
}

static void window_unload(Window *window) {
  tick_timer_service_unsubscribe();
  menu_layer_destroy(s_menu);
  status_bar_layer_destroy(s_status_bar);
  s_menu = NULL;
  window_destroy(s_window);
  s_window = NULL;
  s_dest = -1;
}

void list_window_push(int dest) {
  if (s_window) {
    return;
  }
  s_dest = dest;
  s_count = 0;
  s_status[0] = '\0';
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);
  fetch();
}

bool list_window_is_open(void) {
  return s_window != NULL;
}

int list_window_dest(void) {
  return s_dest;
}

void list_window_on_ready(void) {
  // Phone JS (re)started: ask again if we were waiting on it.
  if (s_window && s_loading) {
    fetch();
  }
}

void list_window_set_status(int dest, const char *status) {
  if (!s_window || dest != s_dest) {
    return;
  }
  strncpy(s_status, status, sizeof(s_status) - 1);
  s_status[sizeof(s_status) - 1] = '\0';
  // Progress messages ("Locating…") keep the spinner; anything else ends loading.
  size_t len = strlen(s_status);
  bool progress = len >= 3 && strcmp(s_status + len - 3, "…") == 0;
  if (!progress) {
    s_loading = false;
  }
  if (s_menu) {
    menu_layer_reload_data(s_menu);
  }
}

void list_window_begin(int dest, int count) {
  if (!s_window || dest != s_dest) {
    return;
  }
  s_loading = false;
  s_status[0] = '\0';
  s_expected = count < MAX_ITEMS ? count : MAX_ITEMS;
  if (s_expected > 0) {
    return;  // keep showing the old list until the new one has arrived
  }
  s_count = 0;
  if (s_menu) {
    menu_layer_reload_data(s_menu);
  }
}

void list_window_set_item(int dest, int idx, const Departure *d) {
  if (!s_window || dest != s_dest || idx < 0 || idx >= s_expected) {
    return;
  }
  s_incoming[idx] = *d;
  if (idx != s_expected - 1) {
    return;
  }
  memcpy(s_items, s_incoming, sizeof(Departure) * s_expected);
  s_count = s_expected;
  if (s_menu) {
    menu_layer_reload_data(s_menu);
  }
}

const Departure *list_window_item(int idx) {
  return idx >= 0 && idx < s_count ? &s_items[idx] : NULL;
}
