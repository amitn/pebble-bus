#include "app.h"

// Map data from the phone is a sequence of polylines:
//   [kind:u8][count:u8][count x (x:i16le, y:i16le)]
// with coordinates in meters relative to the boarding stop (x east, y south).
#define MAP_CAP 16384
#define TOP_H 48
#define BOTTOM_H 46
#define COORD_LIMIT 8000

enum { KIND_MINOR, KIND_MAJOR, KIND_ROUTE, KIND_WALK };
enum { CENTER_OVERVIEW, CENTER_STOP, CENTER_YOU, NUM_CENTERS };

// Decimeters per pixel for each zoom level.
static const int16_t ZOOMS[] = {4, 6, 8, 10, 13, 16, 20, 25, 32, 40, 50, 63, 80, 100, 130};
#define NUM_ZOOMS ((int)ARRAY_LENGTH(ZOOMS))

static Window *s_window;
static Layer *s_layer;
static int s_item = -1;
static uint8_t *s_buf;
static uint16_t s_len;
static bool s_have_data;
static bool s_done;
static char s_status[64];
static GPoint s_user;
static int s_zoom = 3;
static int s_center_mode;
static const char *s_toast;
static AppTimer *s_toast_timer;
static bool s_status_seen;  // status bubble is dismissed after a few seconds

// Projection state for the current frame
static int32_t s_cx, s_cy;    // center, meters
static GPoint s_screen_mid;   // center, pixels
static int32_t s_dpp;         // decimeters per pixel
static GRect s_view;

static int16_t clamp_coord(int32_t v) {
  return v < -COORD_LIMIT ? -COORD_LIMIT : (v > COORD_LIMIT ? COORD_LIMIT : v);
}

static GPoint project(int32_t x, int32_t y) {
  return GPoint(clamp_coord(s_screen_mid.x + (x - s_cx) * 10 / s_dpp),
                clamp_coord(s_screen_mid.y + (y - s_cy) * 10 / s_dpp));
}

static GPoint read_point(const uint8_t *p) {
  return project((int16_t)(p[0] | (p[1] << 8)), (int16_t)(p[2] | (p[3] << 8)));
}

static bool segment_visible(GPoint a, GPoint b) {
  int16_t x0 = s_view.origin.x - 8, y0 = s_view.origin.y - 8;
  int16_t x1 = s_view.origin.x + s_view.size.w + 8, y1 = s_view.origin.y + s_view.size.h + 8;
  return !((a.x < x0 && b.x < x0) || (a.x > x1 && b.x > x1) ||
           (a.y < y0 && b.y < y0) || (a.y > y1 && b.y > y1));
}

static uint32_t isqrt(uint32_t v) {
  uint32_t r = 0, bit = 1u << 30;
  while (bit > v) {
    bit >>= 2;
  }
  while (bit) {
    if (v >= r + bit) {
      v -= r + bit;
      r = (r >> 1) + bit;
    } else {
      r >>= 1;
    }
    bit >>= 2;
  }
  return r;
}

static void draw_poly(GContext *ctx, const uint8_t *pts, int n) {
  GPoint prev = read_point(pts);
  for (int i = 1; i < n; i++) {
    GPoint cur = read_point(pts + i * 4);
    if (segment_visible(prev, cur)) {
      graphics_draw_line(ctx, prev, cur);
    }
    prev = cur;
  }
}

static void draw_dotted(GContext *ctx, const uint8_t *pts, int n) {
  const int spacing = 7;
  int carry = 0;
  GPoint prev = read_point(pts);
  for (int i = 1; i < n; i++) {
    GPoint cur = read_point(pts + i * 4);
    int dx = cur.x - prev.x, dy = cur.y - prev.y;
    int len = isqrt(dx * dx + dy * dy);
    if (segment_visible(prev, cur)) {
      for (int t = carry; t <= len; t += spacing) {
        graphics_fill_circle(ctx, GPoint(prev.x + dx * t / (len ? len : 1),
                                         prev.y + dy * t / (len ? len : 1)), 2);
      }
    }
    // Offset of the next dot into the following segment
    if (carry <= len) {
      carry += ((len - carry) / spacing + 1) * spacing - len;
    } else {
      carry -= len;
    }
    prev = cur;
  }
}

static void draw_pass(GContext *ctx, uint8_t kind) {
  uint16_t i = 0;
  while (i + 2 <= s_len) {
    uint8_t k = s_buf[i];
    uint8_t n = s_buf[i + 1];
    uint16_t next = i + 2 + n * 4;
    if (next > s_len) {
      break;
    }
    if (k == kind && n >= 2) {
      if (kind == KIND_WALK) {
        draw_dotted(ctx, s_buf + i + 2, n);
      } else {
        draw_poly(ctx, s_buf + i + 2, n);
      }
    }
    i = next;
  }
}

static void draw_scale_bar(GContext *ctx, GRect view) {
  static const int16_t lengths[] = {10, 20, 50, 100, 200, 500, 1000, 2000};
  int meters = lengths[0];
  for (unsigned i = 0; i < ARRAY_LENGTH(lengths); i++) {
    meters = lengths[i];
    if (meters * 10 / s_dpp >= 36) {
      break;
    }
  }
  int px = meters * 10 / s_dpp;
  int x = view.origin.x + 6;
  int y = view.origin.y + view.size.h - 6;
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_stroke_width(ctx, 2);
  graphics_draw_line(ctx, GPoint(x, y), GPoint(x + px, y));
  graphics_draw_line(ctx, GPoint(x, y - 4), GPoint(x, y));
  graphics_draw_line(ctx, GPoint(x + px, y - 4), GPoint(x + px, y));
  char buf[12];
  if (meters >= 1000) {
    snprintf(buf, sizeof(buf), "%d km", meters / 1000);
  } else {
    snprintf(buf, sizeof(buf), "%d m", meters);
  }
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                     GRect(x + px + 4, y - 12, 60, 16), GTextOverflowModeFill,
                     GTextAlignmentLeft, NULL);
}

static void draw_bubble(GContext *ctx, GRect view, const char *text, int y) {
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GRect box = GRect(view.origin.x + 10, y, view.size.w - 20, 40);
  GSize sz = graphics_text_layout_get_content_size(text, font, box, GTextOverflowModeWordWrap,
                                                   GTextAlignmentCenter);
  GRect bg = GRect((view.size.w - sz.w) / 2 - 8, y, sz.w + 16, sz.h + 8);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bg, 6, GCornersAll);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, text, font, GRect(bg.origin.x + 8, y + 1, sz.w, sz.h + 4),
                     GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
}

static void draw_top_bar(GContext *ctx, GRect b, const Departure *d) {
  graphics_context_set_fill_color(ctx, COLOR_ACCENT_DARK);
  graphics_fill_rect(ctx, GRect(0, 0, b.size.w, TOP_H), 0, GCornerNone);
  draw_line_badge(ctx, d, GRect(4, 5, 50, 30), false);

  char buf[24];
  time_t now = time(NULL);
  format_countdown(buf, sizeof(buf), d->dep, now);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                     GRect(60, -3, b.size.w - 64, 28), GTextOverflowModeFill,
                     GTextAlignmentLeft, NULL);
  format_clock(buf, sizeof(buf), d->dep);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(60, 1, b.size.w - 64, 22), GTextOverflowModeFill,
                     GTextAlignmentRight, NULL);
  draw_name(ctx, d->headsign, g_font_small, GRect(60, 27, b.size.w - 64, 18), GTextAlignmentLeft);
}

static void draw_bottom_bar(GContext *ctx, GRect b, const Departure *d) {
  int y = b.size.h - BOTTOM_H;
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, GRect(0, y, b.size.w, BOTTOM_H), 0, GCornerNone);
  graphics_context_set_fill_color(ctx, d->color);
  graphics_fill_rect(ctx, GRect(0, y, b.size.w, 3), 0, GCornerNone);

  graphics_context_set_text_color(ctx, GColorBlack);
  draw_name(ctx, d->stop, g_font_name, GRect(6, y + 4, b.size.w - 12, 22), GTextAlignmentLeft);

  char buf[32];
  GRect line = GRect(6, y + 23, b.size.w - 12, 22);
  if (d->walk_min == 0) {
    snprintf(buf, sizeof(buf), "You're at the stop");
  } else {
    snprintf(buf, sizeof(buf), "Walk %d', %d m", d->walk_min, d->walk_dist);
  }
  graphics_context_set_text_color(ctx, GColorDarkGray);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_18), line,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  long leave_in = (long)(d->leave - time(NULL));
  if (d->walk_min > 0 && leave_in > -60) {
    if (leave_in >= 3600) {
      char at[12];
      format_clock(at, sizeof(at), d->leave);
      snprintf(buf, sizeof(buf), "leave %s", at);
    } else if (leave_in >= 60) {
      snprintf(buf, sizeof(buf), "leave in %ld'", leave_in / 60);
    } else {
      snprintf(buf, sizeof(buf), "leave now");
    }
    graphics_context_set_text_color(ctx, leave_in < 300 ? GColorRed : GColorIslamicGreen);
    graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), line,
                       GTextOverflowModeFill, GTextAlignmentRight, NULL);
  }
}

static void update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const Departure *d = list_window_item(s_item);
  s_view = GRect(0, TOP_H, b.size.w, b.size.h - TOP_H - BOTTOM_H);
  s_screen_mid = GPoint(b.size.w / 2, s_view.origin.y + s_view.size.h / 2);
  s_dpp = ZOOMS[s_zoom];
  switch (s_center_mode) {
    case CENTER_STOP: s_cx = 0; s_cy = 0; break;
    case CENTER_YOU: s_cx = s_user.x; s_cy = s_user.y; break;
    default: s_cx = s_user.x / 2; s_cy = s_user.y / 2; break;
  }

  graphics_context_set_fill_color(ctx, GColorLightGray);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  graphics_context_set_antialiased(ctx, true);

  if (s_have_data) {
    int road = s_dpp <= 6 ? 7 : s_dpp <= 10 ? 5 : s_dpp <= 25 ? 3 : 2;
    graphics_context_set_stroke_color(ctx, GColorWhite);
    graphics_context_set_stroke_width(ctx, road);
    draw_pass(ctx, KIND_MINOR);
    graphics_context_set_stroke_color(ctx, GColorPastelYellow);
    graphics_context_set_stroke_width(ctx, road + 2);
    draw_pass(ctx, KIND_MAJOR);
    graphics_context_set_stroke_color(ctx, d ? d->color : COLOR_ACCENT);
    graphics_context_set_stroke_width(ctx, 4);
    draw_pass(ctx, KIND_ROUTE);
    graphics_context_set_fill_color(ctx, GColorBlue);
    draw_pass(ctx, KIND_WALK);

    // You
    GPoint you = project(s_user.x, s_user.y);
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, you, 8);
    graphics_context_set_fill_color(ctx, GColorBlue);
    graphics_fill_circle(ctx, you, 6);

    // The stop
    GPoint stop = project(0, 0);
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, stop, 10);
    graphics_context_set_fill_color(ctx, d ? d->color : GColorRed);
    graphics_fill_circle(ctx, stop, 8);
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, stop, 3);

    draw_scale_bar(ctx, s_view);
  }

  // One message at a time, at the top of the map so markers stay visible.
  const char *message = s_toast;
  if (!message && !s_have_data) {
    message = "Loading map…";
  } else if (!message && !s_done) {
    message = "Loading streets…";
  } else if (!message && s_status[0] && !s_status_seen) {
    message = s_status;
  }
  if (message) {
    draw_bubble(ctx, s_view, message, s_view.origin.y + 6);
  }

  if (d) {
    draw_top_bar(ctx, b, d);
    draw_bottom_bar(ctx, b, d);
  }
}

// ---- Buttons ---------------------------------------------------------------

static void clear_toast(void *unused) {
  s_toast_timer = NULL;
  s_toast = NULL;
  layer_mark_dirty(s_layer);
}

static void show_toast(const char *text) {
  s_toast = text;
  if (s_toast_timer) {
    app_timer_reschedule(s_toast_timer, 1200);
  } else {
    s_toast_timer = app_timer_register(1200, clear_toast, NULL);
  }
  layer_mark_dirty(s_layer);
}

static void up_click(ClickRecognizerRef rec, void *ctx) {
  if (s_zoom > 0) {
    s_zoom--;
    layer_mark_dirty(s_layer);
  }
}

static void down_click(ClickRecognizerRef rec, void *ctx) {
  if (s_zoom < NUM_ZOOMS - 1) {
    s_zoom++;
    layer_mark_dirty(s_layer);
  }
}

static void select_click(ClickRecognizerRef rec, void *ctx) {
  static const char *names[] = {"Overview", "Bus stop", "You"};
  s_center_mode = (s_center_mode + 1) % NUM_CENTERS;
  show_toast(names[s_center_mode]);
}

static void click_config(void *ctx) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 150, up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 150, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
}

// ---- Window ------------------------------------------------------------------

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_layer, update_proc);
  layer_add_child(root, s_layer);
}

static void window_unload(Window *window) {
  if (s_toast_timer) {
    app_timer_cancel(s_toast_timer);
    s_toast_timer = NULL;
  }
  s_toast = NULL;
  layer_destroy(s_layer);
  s_layer = NULL;
  free(s_buf);
  s_buf = NULL;
  window_destroy(s_window);
  s_window = NULL;
  s_item = -1;
}

void map_window_push(int item) {
  if (s_window) {
    return;
  }
  s_buf = malloc(MAP_CAP);
  if (!s_buf) {
    return;
  }
  s_item = item;
  s_len = 0;
  s_have_data = false;
  s_done = false;
  s_status[0] = '\0';
  s_center_mode = CENTER_OVERVIEW;
  s_user = GPoint(0, 0);

  s_window = window_create();
  window_set_click_config_provider(s_window, click_config);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);
  comm_request_map(item);
}

void map_window_begin(int item, int16_t user_x, int16_t user_y, int mpp10) {
  if (!s_window || item != s_item) {
    return;
  }
  s_len = 0;
  s_user = GPoint(user_x, user_y);
  s_zoom = NUM_ZOOMS - 1;
  for (int i = 0; i < NUM_ZOOMS; i++) {
    if (ZOOMS[i] >= mpp10) {
      s_zoom = i;
      break;
    }
  }
  s_have_data = true;
  layer_mark_dirty(s_layer);
}

void map_window_add_data(const uint8_t *data, uint16_t len) {
  if (!s_window || !s_have_data || s_len + len > MAP_CAP) {
    return;
  }
  memcpy(s_buf + s_len, data, len);
  s_len += len;
  layer_mark_dirty(s_layer);
}

static void dismiss_status(void *unused) {
  s_status_seen = true;
  if (s_layer) {
    layer_mark_dirty(s_layer);
  }
}

void map_window_end(int item, const char *status) {
  if (!s_window || item != s_item) {
    return;
  }
  s_done = true;
  strncpy(s_status, status, sizeof(s_status) - 1);
  s_status[sizeof(s_status) - 1] = '\0';
  s_status_seen = false;
  if (s_status[0]) {
    app_timer_register(4000, dismiss_status, NULL);
  }
  layer_mark_dirty(s_layer);
}

void map_window_refresh(void) {
  if (s_layer) {
    layer_mark_dirty(s_layer);
  }
}
