#include "app.h"

bool text_is_rtl(const char *s) {
  // Hebrew (U+0590..U+05FF) is encoded with UTF-8 lead bytes 0xD6/0xD7.
  for (; *s; s++) {
    uint8_t c = (uint8_t)*s;
    if (c == 0xD6 || c == 0xD7) {
      return true;
    }
  }
  return false;
}

static int text_width(const char *text, GFont font, int16_t h) {
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, 1000, h),
                                               GTextOverflowModeFill, GTextAlignmentLeft).w;
}

// Single-line name. RTL strings arrive from the phone in visual order, so
// Pebble's trailing ellipsis would cut off their *start*; instead drop
// characters from the visual left (the logical end) and right-align.
void draw_name(GContext *ctx, const char *text, GFont font, GRect box, GTextAlignment align) {
  if (!text_is_rtl(text)) {
    graphics_draw_text(ctx, text, font, box, GTextOverflowModeTrailingEllipsis, align, NULL);
    return;
  }
  char buf[NAME_LEN + 4];
  const char *p = text;
  snprintf(buf, sizeof(buf), "%s", p);
  while (*p && text_width(buf, font, box.size.h) > box.size.w) {
    p++;
    while ((*p & 0xC0) == 0x80) {
      p++;
    }
    while (*p == ' ') {
      p++;
    }
    snprintf(buf, sizeof(buf), "…%s", p);
  }
  graphics_draw_text(ctx, buf, font, box, GTextOverflowModeFill,
                     align == GTextAlignmentCenter ? align : GTextAlignmentRight, NULL);
}

void format_countdown(char *buf, size_t n, time_t when, time_t now) {
  long secs = (long)(when - now);
  if (secs < 60) {
    snprintf(buf, n, secs < -30 ? "Gone" : "Now");
  } else if (secs < 3600) {
    snprintf(buf, n, "%ld min", secs / 60);
  } else {
    snprintf(buf, n, "%ldh %02ldm", secs / 3600, (secs % 3600) / 60);
  }
}

void format_clock(char *buf, size_t n, time_t t) {
  struct tm *tm = localtime(&t);
  if (clock_is_24h_style()) {
    strftime(buf, n, "%H:%M", tm);
  } else {
    strftime(buf, n, "%I:%M", tm);
    if (buf[0] == '0') {
      memmove(buf, buf + 1, strlen(buf));
    }
  }
}

void draw_line_badge(GContext *ctx, const Departure *d, GRect box, bool outline) {
  graphics_context_set_fill_color(ctx, d->color);
  graphics_fill_rect(ctx, box, 6, GCornersAll);
  if (outline) {
    graphics_context_set_stroke_color(ctx, GColorWhite);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_round_rect(ctx, grect_inset(box, GEdgeInsets(1)), 5);
    graphics_context_set_stroke_width(ctx, 1);
  }
  // System fonts have no Hebrew glyphs (lines like "24א"), so fall back to ours.
  bool hebrew = text_is_rtl(d->line);
  bool small = hebrew || strlen(d->line) > 3;
  GFont font = hebrew ? g_font_name
                      : fonts_get_system_font(small ? FONT_KEY_GOTHIC_18_BOLD : FONT_KEY_GOTHIC_24_BOLD);
  int16_t text_h = small ? 18 : 24;
  GRect text_box = GRect(box.origin.x + 1, box.origin.y + (box.size.h - text_h) / 2 - (small ? 3 : 5),
                         box.size.w - 2, text_h + 6);
  graphics_context_set_text_color(ctx, gcolor_legible_over(d->color));
  graphics_draw_text(ctx, d->line, font, text_box, GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);
}
