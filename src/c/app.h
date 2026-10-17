#pragma once
#include <pebble.h>

#define MAX_DESTS 5
#define MAX_ITEMS 10
#define DEST_NAME_LEN 40
#define LINE_LEN 12
#define NAME_LEN 96

// One upcoming bus (an itinerary, keyed by its first transit leg).
typedef struct {
  char line[LINE_LEN];
  char stop[NAME_LEN];      // boarding stop, already in visual order
  char headsign[NAME_LEN];  // bus direction, already in visual order
  time_t dep;               // bus leaves the stop
  time_t leave;             // when you need to leave your origin
  time_t arr;               // arrival at the destination
  int16_t delay;            // realtime delay in seconds
  uint16_t walk_dist;       // meters to the stop
  uint8_t walk_min;
  uint8_t transfers;
  bool realtime;
  GColor color;
} Departure;

// Theme
#define COLOR_ACCENT GColorCobaltBlue
#define COLOR_ACCENT_DARK GColorOxfordBlue

// main.c
extern char g_dest_names[MAX_DESTS][DEST_NAME_LEN];
extern int g_dest_count;
extern GFont g_font_name;   // Latin + Hebrew, bold 17
extern GFont g_font_small;  // Latin + Hebrew, regular 14
void comm_fetch(int dest);
void comm_request_map(int item);

// dest_window.c
void dest_window_push(void);
void dest_window_reload(void);

// list_window.c
void list_window_push(int dest);
bool list_window_is_open(void);
int list_window_dest(void);
void list_window_set_status(int dest, const char *status);
void list_window_begin(int dest, int count);
void list_window_set_item(int dest, int idx, const Departure *d);
void list_window_on_ready(void);
const Departure *list_window_item(int idx);

// map_window.c
void map_window_push(int item);
void map_window_begin(int item, int16_t user_x, int16_t user_y, int mpp10);
void map_window_add_data(const uint8_t *data, uint16_t len);
void map_window_end(int item, const char *status);
void map_window_refresh(void);

// util.c
bool text_is_rtl(const char *s);
void draw_name(GContext *ctx, const char *text, GFont font, GRect box, GTextAlignment align);
void format_countdown(char *buf, size_t n, time_t when, time_t now);
void format_clock(char *buf, size_t n, time_t t);
void draw_line_badge(GContext *ctx, const Departure *d, GRect box, bool outline);
