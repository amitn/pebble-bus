#include "app.h"

static Window *s_window;
static StatusBarLayer *s_status_bar;
static MenuLayer *s_menu;
static TextLayer *s_empty;
static bool s_auto_opened;

static uint16_t get_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  return g_dest_count;
}

static int16_t get_header_height(MenuLayer *menu, uint16_t section, void *ctx) {
  return 30;
}

static int16_t get_cell_height(MenuLayer *menu, MenuIndex *index, void *ctx) {
  return 48;
}

static void draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *data) {
  GRect b = layer_get_bounds(cell);
  graphics_context_set_fill_color(ctx, COLOR_ACCENT_DARK);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, "Where to?", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                     GRect(8, -2, b.size.w - 16, 28), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentLeft, NULL);
}

static void draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *data) {
  GRect b = layer_get_bounds(cell);
  bool hl = menu_cell_layer_is_highlighted(cell);
  graphics_context_set_text_color(ctx, hl ? GColorWhite : GColorBlack);

  // Little bus-stop pin
  graphics_context_set_fill_color(ctx, hl ? GColorWhite : COLOR_ACCENT);
  graphics_fill_circle(ctx, GPoint(18, b.size.h / 2), 7);
  graphics_context_set_fill_color(ctx, hl ? COLOR_ACCENT : GColorWhite);
  graphics_fill_circle(ctx, GPoint(18, b.size.h / 2), 3);

  draw_name(ctx, g_dest_names[index->row], g_font_name,
            GRect(34, (b.size.h - 22) / 2, b.size.w - 42, 22), GTextAlignmentLeft);
}

static void select_click(MenuLayer *menu, MenuIndex *index, void *ctx) {
  list_window_push(index->row);
}

static void update_visibility(void) {
  layer_set_hidden(menu_layer_get_layer(s_menu), g_dest_count == 0);
  layer_set_hidden(text_layer_get_layer(s_empty), g_dest_count != 0);
}

static void maybe_auto_open(void) {
  // With a single destination skip straight to its departures.
  if (s_auto_opened || g_dest_count != 1 || window_stack_get_top_window() != s_window) {
    return;
  }
  s_auto_opened = true;
  list_window_push(0);
  window_stack_remove(s_window, false);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);

  s_status_bar = status_bar_layer_create();
  status_bar_layer_set_colors(s_status_bar, COLOR_ACCENT_DARK, GColorWhite);
  layer_add_child(root, status_bar_layer_get_layer(s_status_bar));

  GRect body = GRect(0, STATUS_BAR_LAYER_HEIGHT, b.size.w, b.size.h - STATUS_BAR_LAYER_HEIGHT);
  s_menu = menu_layer_create(body);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_rows = get_num_rows,
    .get_header_height = get_header_height,
    .get_cell_height = get_cell_height,
    .draw_header = draw_header,
    .draw_row = draw_row,
    .select_click = select_click,
  });
  menu_layer_set_normal_colors(s_menu, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_menu, COLOR_ACCENT, GColorWhite);
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));

  s_empty = text_layer_create(GRect(12, body.origin.y + 30, b.size.w - 24, body.size.h - 40));
  text_layer_set_text(s_empty, "No destinations yet.\n\nOpen Next Bus settings in the Pebble app on your phone to add one.");
  text_layer_set_font(s_empty, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_empty, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_empty));

  update_visibility();
}

static void auto_open_timer(void *unused) {
  maybe_auto_open();
}

static void window_appear(Window *window) {
  // Defer so we don't push a window mid-transition.
  app_timer_register(50, auto_open_timer, NULL);
}

static void window_unload(Window *window) {
  menu_layer_destroy(s_menu);
  text_layer_destroy(s_empty);
  status_bar_layer_destroy(s_status_bar);
  s_menu = NULL;
}

void dest_window_push(void) {
  if (!s_window) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers) {
      .load = window_load,
      .appear = window_appear,
      .unload = window_unload,
    });
  }
  window_stack_push(s_window, true);
}

void dest_window_reload(void) {
  if (s_menu) {
    menu_layer_reload_data(s_menu);
    update_visibility();
    maybe_auto_open();
  }
}
